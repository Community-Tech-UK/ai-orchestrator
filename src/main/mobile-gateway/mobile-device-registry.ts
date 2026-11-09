import * as crypto from 'crypto';
import { randomUUID } from 'crypto';
import { getLogger } from '../logging/logger';
import { getSettingsManager } from '../core/config/settings-manager';
import {
  MOBILE_OWNER_PROFILE_ID,
  type MobileDevice,
  type MobileDeviceSummary,
  type MobileMemberProfile,
  type MobilePairingCredential,
} from '../../shared/types/mobile-gateway.types';

const logger = getLogger('MobileGateway');

const DEFAULT_PAIRING_TTL_MS = 10 * 60 * 1000; // 10 minutes to scan the QR
const DEFAULT_DEVICE_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
/**
 * Sliding renewal is persisted at most this often per device, so ordinary request
 * traffic doesn't rewrite settings on every call. Capped to half the token's own
 * TTL so short-lived tokens still renew.
 */
const TOKEN_RENEW_PERSIST_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day
const SETTINGS_KEY = 'mobileGatewayDevices' as const;
const PROFILES_SETTINGS_KEY = 'mobileGatewayProfiles' as const;
const MAX_PROFILE_NAME_LENGTH = 64;

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
  loadProfiles(): string | undefined;
  saveProfiles(json: string): void;
}

const settingsPersistence: MobileDevicePersistence = {
  load: () => {
    const raw = getSettingsManager().get(SETTINGS_KEY);
    return typeof raw === 'string' ? raw : undefined;
  },
  save: (json) => {
    getSettingsManager().set(SETTINGS_KEY, json);
  },
  loadProfiles: () => {
    const raw = getSettingsManager().get(PROFILES_SETTINGS_KEY);
    return typeof raw === 'string' ? raw : undefined;
  },
  saveProfiles: (json) => {
    getSettingsManager().set(PROFILES_SETTINGS_KEY, json);
  },
};

/** The person a phone belongs to. Phones paired before profiles existed are the owner's. */
export function deviceProfileId(device: Pick<MobileDevice, 'profileId'>): string {
  return device.profileId ?? MOBILE_OWNER_PROFILE_ID;
}

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
  private readonly members = new Map<string, MobileMemberProfile>();
  private readonly revocationListeners = new Set<(deviceId: string) => void>();
  private readonly pendingPairings = new Map<string, MobilePairingCredential>();
  private loaded = false;

  constructor(private readonly persistence: MobileDevicePersistence = settingsPersistence) {}

  /**
   * Issue a one-time pairing credential to encode into the desktop QR. The
   * phone that redeems it belongs to `profileId`, the owner unless given.
   */
  issuePairing(
    options: { ttlMs?: number; profileId?: string } = {},
  ): MobilePairingCredential {
    this.ensureLoaded();
    this.pruneExpiredPairings();
    const profileId = options.profileId ?? MOBILE_OWNER_PROFILE_ID;
    if (!this.hasProfile(profileId)) {
      throw new Error('That person no longer has access to the phone app.');
    }
    const ttlMs = options.ttlMs ?? DEFAULT_PAIRING_TTL_MS;
    const createdAt = Date.now();
    const credential: MobilePairingCredential = {
      pairingToken: generateToken(24),
      profileId,
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
    if (!this.hasProfile(pairing.profileId)) {
      return { status: 'rejected', reason: 'Invalid or expired pairing token' };
    }

    const now = Date.now();
    const tokenTtlMs = Math.max(60_000, params.tokenTtlMs ?? DEFAULT_DEVICE_TOKEN_TTL_MS);
    const device: MobileDevice = {
      deviceId: randomUUID(),
      profileId: pairing.profileId,
      label: (params.label?.trim() || 'iPhone').slice(0, 64),
      token: generateToken(32),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + tokenTtlMs,
      tokenTtlMs,
    };
    this.devicesByToken.set(device.token, device);
    this.persist();
    logger.info('Paired mobile device', {
      deviceId: device.deviceId,
      label: device.label,
      profileId: device.profileId,
    });
    return { status: 'paired', device };
  }

  /** Validate a bearer token; returns the (touched) device or null. */
  validateToken(token: string | undefined | null): MobileDevice | null {
    this.ensureLoaded();
    if (!token) {
      return null;
    }
    const device = this.devicesByToken.get(token);
    if (!device || !this.hasProfile(deviceProfileId(device))) {
      return null;
    }
    if (device.expiresAt <= Date.now()) {
      this.retireLiveActivities(device);
      this.devicesByToken.delete(token);
      this.persist();
      logger.info('Rejected expired mobile device token', { deviceId: device.deviceId });
      return null;
    }
    const now = Date.now();
    device.lastSeenAt = now;
    this.renewToken(device, now);
    return device;
  }

  /**
   * Extend a token's life each time it is used. The expiry used to be a fixed
   * deadline from pairing, so a phone in daily use still went dead overnight and
   * every later request 401'd. A rejected WebSocket handshake carries no readable
   * status on the phone, so that surfaced as a generic "can't connect" and looked
   * like a Tailscale fault. A device left unused past its TTL still expires.
   */
  private renewToken(device: MobileDevice, now: number): void {
    const ttlMs = device.tokenTtlMs ?? DEFAULT_DEVICE_TOKEN_TTL_MS;
    const renewedExpiry = now + ttlMs;
    const interval = Math.min(TOKEN_RENEW_PERSIST_INTERVAL_MS, Math.floor(ttlMs / 2));
    if (renewedExpiry - device.expiresAt < interval) {
      return;
    }
    device.expiresAt = renewedExpiry;
    this.persist();
  }

  listDevices(): MobileDeviceSummary[] {
    this.ensureLoaded();
    return [...this.devicesByToken.values()]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((d) => ({
        deviceId: d.deviceId,
        profileId: deviceProfileId(d),
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
        this.dropDevice(token, device);
        this.persist();
        return true;
      }
    }
    return false;
  }

  /** People other than the owner who may use the phone app. */
  listMembers(): MobileMemberProfile[] {
    this.ensureLoaded();
    return [...this.members.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  addMember(name: string): MobileMemberProfile {
    this.ensureLoaded();
    const trimmed = name.trim().slice(0, MAX_PROFILE_NAME_LENGTH);
    if (!trimmed) throw new Error('Enter a name for this person.');
    const profile: MobileMemberProfile = {
      profileId: randomUUID(),
      name: trimmed,
      createdAt: Date.now(),
    };
    this.members.set(profile.profileId, profile);
    this.persistProfiles();
    logger.info('Added mobile profile', { profileId: profile.profileId });
    return profile;
  }

  /**
   * Remove a person and every phone they paired, closing those phones' live
   * connections. Their phones go first, so a crash part-way leaves a person
   * with no phones rather than phones with no person.
   */
  removeMember(profileId: string): boolean {
    this.ensureLoaded();
    if (!this.members.has(profileId)) return false;
    let revokedAny = false;
    for (const [token, device] of this.devicesByToken) {
      if (deviceProfileId(device) !== profileId) continue;
      this.dropDevice(token, device);
      revokedAny = true;
    }
    if (revokedAny) this.persist();
    for (const [pairingToken, pairing] of this.pendingPairings) {
      if (pairing.profileId === profileId) this.pendingPairings.delete(pairingToken);
    }
    this.members.delete(profileId);
    this.persistProfiles();
    logger.info('Removed mobile profile', { profileId });
    return true;
  }

  /** The owner, or a person who still has access. */
  hasProfile(profileId: string): boolean {
    this.ensureLoaded();
    return profileId === MOBILE_OWNER_PROFILE_ID || this.members.has(profileId);
  }

  private dropDevice(token: string, device: MobileDevice): void {
    this.retireLiveActivities(device);
    this.devicesByToken.delete(token);
    logger.info('Revoked mobile device', { deviceId: device.deviceId });
    this.notifyRevoked(device.deviceId);
  }

  /**
   * Observe revocations so live transports can drop the device.
   *
   * Deleting the token only stops the *next* handshake: the gateway checks it at
   * the WebSocket upgrade and never again, so a revoked phone kept streaming on
   * the socket it already held. Revoking a lost device has to cut the live
   * connection, not just the ability to make a new one.
   *
   * Returns an unsubscribe function.
   */
  onDeviceRevoked(listener: (deviceId: string) => void): () => void {
    this.revocationListeners.add(listener);
    return () => {
      this.revocationListeners.delete(listener);
    };
  }

  private notifyRevoked(deviceId: string): void {
    for (const listener of this.revocationListeners) {
      try {
        listener(deviceId);
      } catch (err) {
        // A failing listener must not leave the token half-revoked.
        logger.warn('Device revocation listener failed', {
          deviceId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  setApnsToken(deviceId: string, apnsToken: string): boolean {
    this.ensureLoaded();
    const target = this.getDeviceById(deviceId);
    if (!target) return false;
    for (const device of this.devicesByToken.values()) {
      if (device.deviceId === deviceId || device.apnsToken !== apnsToken) continue;
      this.transferLiveActivities(device.deviceId, deviceId);
      delete device.apnsToken;
    }
    const retired = this.retiredLiveActivityTokens.get(apnsToken);
    if (retired) this.mergeLiveActivities(deviceId, retired);
    this.retiredLiveActivityTokens.delete(apnsToken);
    target.apnsToken = apnsToken;
    this.persist();
    return true;
  }

  clearApnsToken(apnsToken: string): boolean {
    this.ensureLoaded();
    let cleared = this.retiredLiveActivityTokens.delete(apnsToken);
    let changedDevice = false;
    for (const device of this.devicesByToken.values()) {
      if (device.apnsToken !== apnsToken) continue;
      delete device.apnsToken;
      cleared = true;
      changedDevice = true;
    }
    if (changedDevice) this.persist();
    return cleared;
  }

  /**
   * Per-activity APNs push tokens for Live Activities, keyed
   * deviceId → instanceId → token. In-memory only: an activity dies with the
   * phone process, so persisting its token would only leak stale tokens.
   */
  private readonly liveActivityTokens = new Map<string, Map<string, string>>();
  private readonly retiredLiveActivityTokens = new Map<string, Map<string, string>>();

  private mergeLiveActivities(deviceId: string, source: Map<string, string>): void {
    const merged = new Map(source);
    for (const [instanceId, token] of this.liveActivityTokens.get(deviceId) ?? []) {
      merged.set(instanceId, token);
    }
    this.liveActivityTokens.set(deviceId, merged);
  }

  private transferLiveActivities(fromDeviceId: string, toDeviceId: string): void {
    const source = this.liveActivityTokens.get(fromDeviceId);
    if (source) this.mergeLiveActivities(toDeviceId, source);
    this.liveActivityTokens.delete(fromDeviceId);
  }

  private retireLiveActivities(device: MobileDevice): void {
    const source = this.liveActivityTokens.get(device.deviceId);
    if (device.apnsToken && source) {
      const retained = new Map(this.retiredLiveActivityTokens.get(device.apnsToken) ?? []);
      for (const [instanceId, token] of source) retained.set(instanceId, token);
      this.retiredLiveActivityTokens.set(device.apnsToken, retained);
    }
    this.liveActivityTokens.delete(device.deviceId);
  }

  setLiveActivityToken(deviceId: string, instanceId: string, token: string): boolean {
    this.ensureLoaded();
    if (!this.getDeviceById(deviceId)) return false;
    let byInstance = this.liveActivityTokens.get(deviceId);
    if (!byInstance) {
      byInstance = new Map<string, string>();
      this.liveActivityTokens.set(deviceId, byInstance);
    }
    if (token) {
      byInstance.set(instanceId, token);
    } else {
      byInstance.delete(instanceId);
    }
    return true;
  }

  clearLiveActivityTokensForInstance(instanceId: string): void {
    for (const byInstance of this.liveActivityTokens.values()) {
      byInstance.delete(instanceId);
    }
    for (const byInstance of this.retiredLiveActivityTokens.values()) {
      byInstance.delete(instanceId);
    }
  }

  clearLiveActivityToken(token: string): boolean {
    let cleared = false;
    for (const byInstance of this.liveActivityTokens.values()) {
      for (const [instanceId, registered] of byInstance) {
        if (registered !== token) continue;
        byInstance.delete(instanceId);
        cleared = true;
      }
    }
    for (const [apnsToken, byInstance] of this.retiredLiveActivityTokens) {
      for (const [instanceId, registered] of byInstance) {
        if (registered !== token) continue;
        byInstance.delete(instanceId);
        cleared = true;
      }
      if (byInstance.size === 0) this.retiredLiveActivityTokens.delete(apnsToken);
    }
    return cleared;
  }

  /** Activity tokens for an instance, on that person's live phones only. */
  liveActivityTargetsFor(
    instanceId: string,
    profileId: string,
  ): { deviceId: string; token: string }[] {
    this.ensureLoaded();
    const now = Date.now();
    const targets: { deviceId: string; token: string }[] = [];
    for (const [deviceId, byInstance] of this.liveActivityTokens) {
      const token = byInstance.get(instanceId);
      const device = this.getDeviceById(deviceId);
      if (token && device && device.expiresAt > now && deviceProfileId(device) === profileId) {
        targets.push({ deviceId, token });
      }
    }
    return targets;
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

  /** Push targets on one person's non-expired phones that have registered a token. */
  apnsTargets(profileId: string): { deviceId: string; token: string }[] {
    this.ensureLoaded();
    const now = Date.now();
    const targets: { deviceId: string; token: string }[] = [];
    for (const device of this.devicesByToken.values()) {
      if (device.apnsToken && device.expiresAt > now && deviceProfileId(device) === profileId) {
        targets.push({ deviceId: device.deviceId, token: device.apnsToken });
      }
    }
    return targets;
  }

  // --- internals ---

  private ensureLoaded(): void {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    this.loadMembers();
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

  private loadMembers(): void {
    const raw = this.persistence.loadProfiles();
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as MobileMemberProfile[];
      if (!Array.isArray(parsed)) return;
      for (const profile of parsed) {
        if (
          profile &&
          typeof profile.profileId === 'string' &&
          profile.profileId !== MOBILE_OWNER_PROFILE_ID &&
          typeof profile.name === 'string'
        ) {
          this.members.set(profile.profileId, profile);
        }
      }
    } catch (err) {
      logger.warn('Failed to parse persisted mobile profiles', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private persist(): void {
    const list = [...this.devicesByToken.values()];
    this.persistence.save(JSON.stringify(list));
  }

  private persistProfiles(): void {
    this.persistence.saveProfiles(JSON.stringify([...this.members.values()]));
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
