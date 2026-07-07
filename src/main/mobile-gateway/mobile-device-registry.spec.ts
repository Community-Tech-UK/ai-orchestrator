import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MobileDeviceRegistry,
  type MobileDevicePersistence,
} from './mobile-device-registry';

function memPersistence(): MobileDevicePersistence & { dump: () => string | undefined } {
  let store: string | undefined;
  return {
    load: () => store,
    save: (json: string) => {
      store = json;
    },
    dump: () => store,
  };
}

describe('MobileDeviceRegistry', () => {
  let persistence: ReturnType<typeof memPersistence>;
  let registry: MobileDeviceRegistry;

  beforeEach(() => {
    persistence = memPersistence();
    registry = new MobileDeviceRegistry(persistence);
  });

  it('pairs a device from a valid one-time pairing token', () => {
    const pairing = registry.issuePairing();
    expect(pairing.pairingToken).toMatch(/^[0-9a-f]+$/);
    expect(pairing.expiresAt).toBeGreaterThan(Date.now());

    const result = registry.pair({ pairingToken: pairing.pairingToken, label: "James's iPhone" });
    expect(result.status).toBe('paired');
    if (result.status !== 'paired') return;

    expect(result.device.token).toMatch(/^[0-9a-f]+$/);
    expect(result.device.label).toBe("James's iPhone");
    expect(registry.validateToken(result.device.token)).not.toBeNull();
    expect(registry.listDevices()).toHaveLength(1);
  });

  it('rejects an invalid or missing pairing token', () => {
    expect(registry.pair({ pairingToken: 'nope' }).status).toBe('rejected');
    expect(registry.pair({ pairingToken: '' }).status).toBe('rejected');
  });

  it('treats pairing tokens as single-use', () => {
    const pairing = registry.issuePairing();
    expect(registry.pair({ pairingToken: pairing.pairingToken }).status).toBe('paired');
    expect(registry.pair({ pairingToken: pairing.pairingToken }).status).toBe('rejected');
  });

  it('returns null for unknown bearer tokens', () => {
    expect(registry.validateToken('unknown')).toBeNull();
    expect(registry.validateToken(undefined)).toBeNull();
  });

  it('revokes a device so its token no longer validates', () => {
    const pairing = registry.issuePairing();
    const result = registry.pair({ pairingToken: pairing.pairingToken });
    if (result.status !== 'paired') throw new Error('expected pairing to succeed');

    expect(registry.revokeDevice(result.device.deviceId)).toBe(true);
    expect(registry.validateToken(result.device.token)).toBeNull();
    expect(registry.listDevices()).toHaveLength(0);
    expect(registry.revokeDevice('already-gone')).toBe(false);
  });

  it('persists devices so a fresh registry reloads them', () => {
    const pairing = registry.issuePairing();
    const result = registry.pair({ pairingToken: pairing.pairingToken });
    if (result.status !== 'paired') throw new Error('expected pairing to succeed');

    const reloaded = new MobileDeviceRegistry(persistence);
    expect(reloaded.validateToken(result.device.token)).not.toBeNull();
    expect(reloaded.listDevices()).toHaveLength(1);
  });

  it('records an APNs token against a device', () => {
    const pairing = registry.issuePairing();
    const result = registry.pair({ pairingToken: pairing.pairingToken });
    if (result.status !== 'paired') throw new Error('expected pairing to succeed');

    expect(registry.setApnsToken(result.device.deviceId, 'apns-abc')).toBe(true);
    expect(registry.listDevices()[0].hasApnsToken).toBe(true);
    expect(registry.getDeviceById(result.device.deviceId)?.apnsToken).toBe('apns-abc');
  });

  describe('expiry (fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('rejects an expired pairing token', () => {
      const pairing = registry.issuePairing(1_000);
      vi.setSystemTime(new Date('2026-01-01T00:00:05Z')); // +5s
      expect(registry.pair({ pairingToken: pairing.pairingToken }).status).toBe('rejected');
    });

    it('rejects an expired device token', () => {
      const pairing = registry.issuePairing();
      const result = registry.pair({ pairingToken: pairing.pairingToken, tokenTtlMs: 60_000 });
      if (result.status !== 'paired') throw new Error('expected pairing to succeed');
      expect(registry.validateToken(result.device.token)).not.toBeNull();

      vi.setSystemTime(new Date('2026-06-01T00:00:00Z')); // well past 60s TTL
      expect(registry.validateToken(result.device.token)).toBeNull();
    });
  });
});

describe('live activity tokens', () => {
  let persistence: ReturnType<typeof memPersistence>;
  let registry: MobileDeviceRegistry;

  beforeEach(() => {
    persistence = memPersistence();
    registry = new MobileDeviceRegistry(persistence);
  });

  function pairDevice(): { deviceId: string } {
    const pairing = registry.issuePairing();
    const result = registry.pair({ pairingToken: pairing.pairingToken, label: 'phone' });
    if (result.status !== 'paired') throw new Error('pairing failed');
    return { deviceId: result.device.deviceId };
  }

  it('stores, retrieves and clears per-instance activity tokens', () => {
    const { deviceId } = pairDevice();

    expect(registry.setLiveActivityToken(deviceId, 'inst-1', 'tok-a')).toBe(true);
    expect(registry.liveActivityTokensFor('inst-1')).toEqual(['tok-a']);
    expect(registry.liveActivityTokensFor('inst-2')).toEqual([]);

    // Empty token clears the registration.
    expect(registry.setLiveActivityToken(deviceId, 'inst-1', '')).toBe(true);
    expect(registry.liveActivityTokensFor('inst-1')).toEqual([]);
  });

  it('clears tokens for a removed instance across devices', () => {
    const { deviceId } = pairDevice();
    registry.setLiveActivityToken(deviceId, 'inst-1', 'tok-a');
    registry.clearLiveActivityTokensForInstance('inst-1');
    expect(registry.liveActivityTokensFor('inst-1')).toEqual([]);
  });

  it('rejects tokens for unknown devices', () => {
    expect(registry.setLiveActivityToken('ghost', 'inst-1', 'tok')).toBe(false);
  });
});
