import * as crypto from 'crypto';
import * as http2 from 'http2';
import { getLogger } from '../logging/logger';
import { getSettingsManager } from '../core/config/settings-manager';
import type { MobileApnsConfig } from '../../shared/types/mobile-gateway.types';

const logger = getLogger('MobileApns');

/** A push alert the gateway sends when an agent needs the user. */
export interface ApnsAlert {
  title: string;
  body: string;
  /** Custom payload merged into the APNs body for deep-linking (instanceId, requestId, kind). */
  data?: Record<string, unknown>;
  /** APNs `category` → maps to a notification action set on the device. */
  category?: string;
  /** Thread id so related alerts group in Notification Center. */
  threadId?: string;
}

export interface ApnsSendResult {
  deviceToken: string;
  ok: boolean;
  status?: number;
  reason?: string;
}

/**
 * Network transport — abstracted so the JWT/header/payload construction can be
 * unit-tested without opening a real HTTP/2 connection to Apple.
 */
export interface ApnsTransport {
  post(args: {
    host: string;
    deviceToken: string;
    jwt: string;
    topic: string;
    payload: string;
  }): Promise<{ status: number; reason?: string }>;
}

export interface MobileApnsSenderOptions {
  /** Defaults to reading the settings store. Injectable for tests. */
  configProvider?: () => MobileApnsConfig;
  /** Defaults to a real HTTP/2 client. Injectable for tests. */
  transport?: ApnsTransport;
  /** Defaults to Date.now. Injectable for deterministic JWT iat in tests. */
  now?: () => number;
}

const APNS_PROD_HOST = 'api.push.apple.com';
const APNS_SANDBOX_HOST = 'api.sandbox.push.apple.com';
/** APNs allows a provider JWT to be reused for up to 60 min; refresh well before. */
const JWT_TTL_MS = 50 * 60 * 1000;

export function apnsHost(production: boolean): string {
  return production ? APNS_PROD_HOST : APNS_SANDBOX_HOST;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf-8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Build the short-lived ES256 provider JWT APNs requires. Signed with the .p8
 * key (PKCS#8 PEM). `dsaEncoding: 'ieee-p1363'` yields the raw R||S signature
 * JWS/ES256 expects (not DER).
 */
export function buildApnsJwt(config: MobileApnsConfig, iatSeconds: number): string {
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: config.keyId, typ: 'JWT' }));
  const claims = base64url(JSON.stringify({ iss: config.teamId, iat: iatSeconds }));
  const signingInput = `${header}.${claims}`;
  const key = crypto.createPrivateKey(config.keyP8);
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${base64url(signature)}`;
}

/** Build the APNs JSON body for an alert. */
export function buildApnsPayload(alert: ApnsAlert): string {
  const body: Record<string, unknown> = {
    aps: {
      alert: { title: alert.title, body: alert.body },
      sound: 'default',
      ...(alert.category ? { category: alert.category } : {}),
      ...(alert.threadId ? { 'thread-id': alert.threadId } : {}),
    },
    ...(alert.data ?? {}),
  };
  return JSON.stringify(body);
}

class Http2ApnsTransport implements ApnsTransport {
  post(args: {
    host: string;
    deviceToken: string;
    jwt: string;
    topic: string;
    payload: string;
  }): Promise<{ status: number; reason?: string }> {
    return new Promise((resolve, reject) => {
      const client = http2.connect(`https://${args.host}`);
      let settled = false;
      const done = (fn: () => void) => {
        if (settled) return;
        settled = true;
        try {
          client.close();
        } catch {
          /* ignore */
        }
        fn();
      };
      client.on('error', (err) => done(() => reject(err)));

      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${args.deviceToken}`,
        authorization: `bearer ${args.jwt}`,
        'apns-topic': args.topic,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      });
      let status = 0;
      let raw = '';
      req.on('response', (headers) => {
        status = Number(headers[':status']) || 0;
      });
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        raw += chunk;
      });
      req.on('end', () =>
        done(() => {
          let reason: string | undefined;
          if (raw) {
            try {
              reason = (JSON.parse(raw) as { reason?: string }).reason;
            } catch {
              reason = raw.slice(0, 200);
            }
          }
          resolve({ status, reason });
        }),
      );
      req.on('error', (err) => done(() => reject(err)));
      req.end(args.payload);
    });
  }
}

const settingsConfigProvider = (): MobileApnsConfig => {
  const s = getSettingsManager();
  return {
    keyP8: s.get('mobileGatewayApnsKeyP8'),
    keyId: s.get('mobileGatewayApnsKeyId'),
    teamId: s.get('mobileGatewayApnsTeamId'),
    bundleId: s.get('mobileGatewayApnsBundleId'),
    production: s.get('mobileGatewayApnsProduction'),
  };
};

/**
 * Sends APNs alerts straight from the Mac to Apple (no third-party relay), using
 * a settings-stored .p8 Auth Key. No-ops cleanly when push is unconfigured.
 */
export class MobileApnsSender {
  private readonly configProvider: () => MobileApnsConfig;
  private readonly transport: ApnsTransport;
  private readonly now: () => number;

  private cachedJwt: { token: string; issuedAt: number; keyId: string; teamId: string } | null = null;

  constructor(opts: MobileApnsSenderOptions = {}) {
    this.configProvider = opts.configProvider ?? settingsConfigProvider;
    this.transport = opts.transport ?? new Http2ApnsTransport();
    this.now = opts.now ?? Date.now;
  }

  getConfig(): MobileApnsConfig {
    return this.configProvider();
  }

  isConfigured(): boolean {
    const c = this.configProvider();
    return Boolean(c.keyP8 && c.keyId && c.teamId && c.bundleId);
  }

  private getJwt(config: MobileApnsConfig): string {
    const nowMs = this.now();
    if (
      this.cachedJwt &&
      this.cachedJwt.keyId === config.keyId &&
      this.cachedJwt.teamId === config.teamId &&
      nowMs - this.cachedJwt.issuedAt < JWT_TTL_MS
    ) {
      return this.cachedJwt.token;
    }
    const token = buildApnsJwt(config, Math.floor(nowMs / 1000));
    this.cachedJwt = { token, issuedAt: nowMs, keyId: config.keyId, teamId: config.teamId };
    return token;
  }

  /** Send one alert to every supplied device token. Resolves with per-device results. */
  async send(deviceTokens: string[], alert: ApnsAlert): Promise<ApnsSendResult[]> {
    if (deviceTokens.length === 0) {
      return [];
    }
    const config = this.configProvider();
    if (!this.isConfigured()) {
      logger.debug('APNs push skipped — not configured');
      return [];
    }

    let jwt: string;
    try {
      jwt = this.getJwt(config);
    } catch (err) {
      logger.warn('Failed to build APNs JWT (bad .p8 key?)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    const host = apnsHost(config.production);
    const payload = buildApnsPayload(alert);

    const results = await Promise.all(
      deviceTokens.map(async (deviceToken): Promise<ApnsSendResult> => {
        try {
          const { status, reason } = await this.transport.post({
            host,
            deviceToken,
            jwt,
            topic: config.bundleId,
            payload,
          });
          return { deviceToken, ok: status === 200, status, reason };
        } catch (err) {
          return {
            deviceToken,
            ok: false,
            reason: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    const failures = results.filter((r) => !r.ok);
    if (failures.length > 0) {
      logger.warn('APNs delivery had failures', {
        sent: results.length,
        failed: failures.length,
        reasons: [...new Set(failures.map((f) => f.reason).filter(Boolean))],
      });
    }
    return results;
  }
}

let sender: MobileApnsSender | null = null;

export function getMobileApnsSender(): MobileApnsSender {
  if (!sender) {
    sender = new MobileApnsSender();
  }
  return sender;
}

export function _resetMobileApnsSenderForTesting(): void {
  sender = null;
}
