/**
 * AgyCredentialsReader
 *
 * Reads Antigravity's (AGY 1.1.1) active consumer credential so Harness can call
 * Google's read-only `retrieveUserQuotaSummary` endpoint without depending on the
 * external token-usage-monitor.
 *
 * AGY stores its signed-in credential in the OS keyring. On macOS the item uses
 * service `gemini` and account `antigravity`, serialized by the Go `go-keyring`
 * library as an opaque prefix, a colon, then base64-encoded JSON:
 *
 *     go-keyring-base64:<base64({ token: { access_token, expiry, ... }, ... })>
 *
 * We read `token.access_token` and `token.expiry` (an ISO-8601 timestamp).
 *
 * Credential ownership stays with AGY: this reader never writes, rotates, or logs
 * the keyring credential (nor its refresh token). When the short-lived access
 * token is expired, it runs the non-inference `agy models` command so AGY can
 * silently refresh its own Keychain item, then rereads it. A missing or malformed
 * credential is reported as unavailable (fail closed), and the probe can still
 * fall back to the legacy `~/.gemini/oauth_creds.json` source.
 */

import { execFile as execFileCb } from 'child_process';
import { getLogger } from '../../../logging/logger';
import { createAntigravityCliAuthCheck } from './gemini-quota-probe';

const logger = getLogger('AgyCredentialsReader');

const KEYCHAIN_SERVICE = 'gemini';
const KEYCHAIN_ACCOUNT = 'antigravity';
const DEFAULT_TIMEOUT_MS = 5_000;
const EXPIRY_SKEW_MS = 90_000;

export interface AgyCredential {
  accessToken: string;
  /** Epoch ms when the access token expires. 0 when the credential carries no expiry. */
  expiresAt: number;
}

export type AgyCredentialFailureReason =
  | 'not-found'
  | 'denied'
  | 'expired'
  | 'malformed'
  | 'unsupported';

export interface AgyCredentialResult {
  credential: AgyCredential | null;
  reason?: AgyCredentialFailureReason;
}

export type AgySecurityExec = (
  args: string[],
  opts: { timeoutMs: number },
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export interface AgyCredentialsReaderOptions {
  platform?: NodeJS.Platform;
  securityExec?: AgySecurityExec;
  /** Delegates an expired-token refresh to AGY itself (`agy models`). */
  refreshCliAuth?: () => Promise<boolean>;
  now?: () => number;
}

interface AgyKeyringPayload {
  token?: {
    access_token?: unknown;
    expiry?: unknown;
  };
}

export class AgyCredentialsReader {
  private readonly platform: NodeJS.Platform;
  private readonly securityExec: AgySecurityExec;
  private readonly refreshCliAuth: () => Promise<boolean>;
  private readonly now: () => number;

  constructor(opts: AgyCredentialsReaderOptions = {}) {
    this.platform = opts.platform ?? process.platform;
    this.securityExec = opts.securityExec ?? defaultSecurityExec;
    const cliAuthCheck = createAntigravityCliAuthCheck();
    this.refreshCliAuth = opts.refreshCliAuth ?? (() => cliAuthCheck({}));
    this.now = opts.now ?? Date.now;
  }

  async read(): Promise<AgyCredentialResult> {
    if (this.platform !== 'darwin') {
      // Only the macOS Keychain source is modelled; other platforms fall back to
      // the legacy oauth_creds.json path handled by the probe.
      return { credential: null, reason: 'unsupported' };
    }

    const first = await this.readKeychainOnce();
    if (first.reason !== 'expired') return first;

    try {
      if (await this.refreshCliAuth()) {
        return await this.readKeychainOnce();
      }
    } catch (err) {
      logger.debug(`Antigravity CLI credential refresh failed: ${(err as Error).message}`);
    }
    return first;
  }

  private async readKeychainOnce(): Promise<AgyCredentialResult> {
    let raw: string;
    try {
      const { stdout, exitCode } = await this.securityExec(
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
        { timeoutMs: DEFAULT_TIMEOUT_MS },
      );
      if (exitCode !== 0) return { credential: null, reason: 'not-found' };
      raw = stdout.trim();
    } catch (err) {
      logger.debug(`Antigravity keychain read failed: ${(err as Error).message}`);
      return { credential: null, reason: 'not-found' };
    }

    if (!raw) return { credential: null, reason: 'not-found' };
    return this.decode(raw);
  }

  /** Decode the `<prefix>:<base64-JSON>` keyring serialization. */
  private decode(raw: string): AgyCredentialResult {
    const colon = raw.indexOf(':');
    if (colon < 0) return { credential: null, reason: 'malformed' };

    let payload: AgyKeyringPayload;
    try {
      const json = Buffer.from(raw.slice(colon + 1), 'base64').toString('utf8');
      payload = JSON.parse(json) as AgyKeyringPayload;
    } catch {
      return { credential: null, reason: 'malformed' };
    }

    const accessToken = payload.token?.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      return { credential: null, reason: 'malformed' };
    }

    // `expiry` is an ISO-8601 timestamp. A missing expiry is treated as unknown
    // (expiresAt=0), while malformed or past timestamps fail closed.
    const rawExpiry = payload.token?.expiry;
    let expiresAt = 0;
    if (typeof rawExpiry === 'string' && rawExpiry.length > 0) {
      const parsed = Date.parse(rawExpiry);
      if (Number.isNaN(parsed)) {
        return { credential: null, reason: 'malformed' };
      }
      expiresAt = parsed;
      if (expiresAt <= this.now() + EXPIRY_SKEW_MS) {
        return { credential: null, reason: 'expired' };
      }
    }

    return { credential: { accessToken, expiresAt } };
  }
}

const defaultSecurityExec: AgySecurityExec = (args, { timeoutMs }) => {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = execFileCb(
      '/usr/bin/security',
      args,
      { timeout: timeoutMs, maxBuffer: 256 * 1024 },
      (err, stdout, stderr) => {
        if (settled) return;
        settled = true;
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (typeof code === 'string') return reject(err);
          resolve({
            stdout,
            stderr,
            exitCode: typeof code === 'number' ? code : 1,
          });
          return;
        }
        resolve({ stdout, stderr, exitCode: 0 });
      },
    );
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
};
