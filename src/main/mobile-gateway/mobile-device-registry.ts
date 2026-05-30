import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { getLogger } from '../logging/logger';
import { getSettingsManager } from '../core/config/settings-manager';
import type {
  MobileDevice,
  MobileDeviceSummary,
  MobilePairingCredential,
} from '../../shared/types/mobile-gateway.types';

const logger = getLogger('MobileGateway');

const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000; // 10 minutes to scan the QR
const DEFAULT_DEVICE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const SETTINGS_KEY = 'mobileGatewayDevices' as const;

function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Persistence port so the registry is unit-testable without Electron settings.
 * Defaults to the settings-backed implementation below.
 */
export interface MobileDevicePersistence {
  load(): string | undefined;
  save(json: string): void;
}

const settingsPersistence: MobileDevicePersistence = {
  load: () => {
    const raw = getSettingsManager().get(SETTINGS_KEY);
    return typeof raw === 'string' ? raw : undefined;
  },
  save: (json) => {
    getSettingsManager().set(SETTINGS_KEY, json);
  },
};

export type MobilePairResult =
  | { status: 'paired'; device: MobileDevice }
  | { status: 'rejected'; reason: string };

/**
 * Registry of paired phones for the Mobile Gateway. Deliberately separate from
 * the worker-node `RemoteAuthService`/`NodeIdentityStore` so phones don't appear
 * in the compute-worker registry and can carry mobile-only fields (APNs token,
 * token expiry). It reuses the same techniques: random hex tokens, one-time TTL
 * pairing credentials, and settings-backed persistence.
 */
export class MobileDeviceRegistry {
  private readonly devicesByToken = new Map<string, MobileDevice>();
  private readonly pendingPairings = new Map<string, MobilePairingCredential>();
  private loaded = false;

  constructor(private readonly persistence: MobileDevicePersistence = settingsPersistence) {}

  /** Issue a one-time pairing credential to encode into the desktop QR. */
  issuePairing(ttlMs: number = DEFAULT_PAIRING_TTL_MS): MobilePairingCredential {
    this.pruneExpiredPairings();
    const createdAt = Date.now();
    const credential: MobilePairingCredential = {
      pairingToken: generateToken(24),
      createdAt,
      expiresAt: createdAt + Math.max(1_000, ttlMs),
    };
    this.pendingPairings.set(credential.pairingToken, credential);
    return credential;
  }

  /** Consume a pairing token and mint a long-lived device token. */
  pair(params: { pairingToken: string; label?: string; tokenTtlMs?: number }): MobilePairResult {
    this.ensureLoaded();
    this.pruneExpiredPairings();

    const token = params.pairingToken?.trim();
    if (!token) {
      return { status: 'rejected', reason: 'Missing pairing token' };
    }
    const pairing = this.pendingPairings.get(token);
    if (!pairing) {
      return { status: 'rejected', reason: 'Invalid or expired pairing token' };
    }
    this.pendingPairings.delete(token);

    const now = Date.now();
    const device: MobileDevice = {
      deviceId: randomUUID(),
      label: (params.label?.trim() || 'iPhone').slice(0, 64),
      token: generateToken(32),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + Math.max(60_000, params.tokenTtlMs ?? DEFAULT_DEVICE_TOKEN_TTL_MS),
    };
    this.devicesByToken.set(device.token, device);
    this.persist();
    logger.info('Paired mobile device', { deviceId: device.deviceId, label: device.label });
    return { status: 'paired', device };
  }

  /** Validate a bearer token; returns the (touched) device or null. */
  validateToken(token: string | undefined | null): MobileDevice | null {
    this.ensureLoaded();
    if (!token) {
      return null;
    }
    const device = this.devicesByToken.get(token);
    if (!device) {
      return null;
    }
    if (device.expiresAt <= Date.now()) {
      this.devicesByToken.delete(token);
      this.persist();
      logger.info('Rejected expired mobile device token', { deviceId: device.deviceId });
      return null;
    }
    device.lastSeenAt = Date.now();
    return device;
  }

  listDevices(): MobileDeviceSummary[] {
    this.ensureLoaded();
    return [...this.devicesByToken.values()]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((d) => ({
        deviceId: d.deviceId,
        label: d.label,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
        expiresAt: d.expiresAt,
        hasApnsToken: Boolean(d.apnsToken),
      }));
  }

  revokeDevice(deviceId: string): boolean {
    this.ensureLoaded();
    for (const [token, device] of this.devicesByToken) {
      if (device.deviceId === deviceId) {
        this.devicesByToken.delete(token);
        this.persist();
        logger.info('Revoked mobile device', { deviceId });
        return true;
      }
    }
    return false;
  }

  setApnsToken(deviceId: string, apnsToken: string): boolean {
    this.ensureLoaded();
    for (const device of this.devicesByToken.values()) {
      if (device.deviceId === deviceId) {
        device.apnsToken = apnsToken;
        this.persist();
        return true;
      }
    }
    return false;
  }

  getDeviceById(deviceId: string): MobileDevice | undefined {
    this.ensureLoaded();
    for (const device of this.devicesByToken.values()) {
      if (device.deviceId === deviceId) {
        return device;
      }
    }
    return undefined;
  }

  deviceCount(): number {
    this.ensureLoaded();
    return this.devicesByToken.size;
  }

  /** APNs tokens of all non-expired paired devices that have registered one. */
  apnsTokens(): string[] {
    this.ensureLoaded();
    const now = Date.now();
    const tokens: string[] = [];
    for (const device of this.devicesByToken.values()) {
      if (device.apnsToken && device.expiresAt > now) {
        tokens.push(device.apnsToken);
      }
    }
    return tokens;
  }

  // --- internals ---

  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    const raw = this.persistence.load();
    if (!raw) {
      return;
    }
    try {
      const parsed = JSON.parse(raw) as MobileDevice[];
      if (Array.isArray(parsed)) {
        for (const device of parsed) {
          if (device && typeof device.token === 'string' && typeof device.deviceId === 'string') {
            this.devicesByToken.set(device.token, device);
          }
        }
      }
    } catch (err) {
      logger.warn('Failed to parse persisted mobile devices', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private persist(): void {
    const list = [...this.devicesByToken.values()];
    this.persistence.save(JSON.stringify(list));
  }

  private pruneExpiredPairings(now = Date.now()): void {
    for (const [token, pairing] of this.pendingPairings) {
      if (pairing.expiresAt <= now) {
        this.pendingPairings.delete(token);
      }
    }
  }
}

let registry: MobileDeviceRegistry | null = null;

export function getMobileDeviceRegistry(): MobileDeviceRegistry {
  if (!registry) {
    registry = new MobileDeviceRegistry();
  }
  return registry;
}

export function _resetMobileDeviceRegistryForTesting(persistence?: MobileDevicePersistence): void {
  registry = persistence ? new MobileDeviceRegistry(persistence) : null;
}
