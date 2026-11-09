import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MobileDeviceRegistry,
  type MobileDevicePersistence,
} from './mobile-device-registry';
import { MOBILE_OWNER_PROFILE_ID } from '../../shared/types/mobile-gateway.types';

function memPersistence(): MobileDevicePersistence & {
  dump: () => string | undefined;
  dumpProfiles: () => string | undefined;
  saveCount: () => number;
} {
  let store: string | undefined;
  let profiles: string | undefined;
  let saves = 0;
  return {
    load: () => store,
    save: (json: string) => {
      saves += 1;
      store = json;
    },
    loadProfiles: () => profiles,
    saveProfiles: (json: string) => {
      profiles = json;
    },
    dump: () => store,
    dumpProfiles: () => profiles,
    saveCount: () => saves,
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
    expect(registry.apnsTargets(MOBILE_OWNER_PROFILE_ID)).toEqual([{ deviceId: result.device.deviceId, token: 'apns-abc' }]);
    expect(registry.clearApnsToken('apns-abc')).toBe(true);
    expect(registry.apnsTargets(MOBILE_OWNER_PROFILE_ID)).toEqual([]);
  });

  it('clears every legacy device record containing the same rejected APNs token', () => {
    const now = Date.now();
    persistence.save(JSON.stringify([
      {
        deviceId: 'legacy-a', label: 'A', token: 'auth-a', apnsToken: 'duplicate-invalid',
        createdAt: now, lastSeenAt: now, expiresAt: now + 60_000, tokenTtlMs: 60_000,
      },
      {
        deviceId: 'legacy-b', label: 'B', token: 'auth-b', apnsToken: 'duplicate-invalid',
        createdAt: now, lastSeenAt: now, expiresAt: now + 60_000, tokenTtlMs: 60_000,
      },
      {
        deviceId: 'other', label: 'Other', token: 'auth-other', apnsToken: 'unrelated',
        createdAt: now, lastSeenAt: now, expiresAt: now + 60_000, tokenTtlMs: 60_000,
      },
    ]));
    registry = new MobileDeviceRegistry(persistence);

    expect(registry.clearApnsToken('duplicate-invalid')).toBe(true);
    expect(registry.apnsTargets(MOBILE_OWNER_PROFILE_ID)).toEqual([{ deviceId: 'other', token: 'unrelated' }]);
  });

  it('moves a physical APNs token to the newest pairing', () => {
    const firstPairing = registry.issuePairing();
    const first = registry.pair({ pairingToken: firstPairing.pairingToken });
    const secondPairing = registry.issuePairing();
    const second = registry.pair({ pairingToken: secondPairing.pairingToken });
    if (first.status !== 'paired' || second.status !== 'paired') throw new Error('expected pairings to succeed');

    expect(registry.setApnsToken(first.device.deviceId, 'same-phone-token')).toBe(true);
    expect(registry.setLiveActivityToken(first.device.deviceId, 'inst-1', 'activity-token')).toBe(true);
    expect(registry.setApnsToken(second.device.deviceId, 'same-phone-token')).toBe(true);

    expect(registry.apnsTargets(MOBILE_OWNER_PROFILE_ID)).toEqual([
      { deviceId: second.device.deviceId, token: 'same-phone-token' },
    ]);
    expect(registry.getDeviceById(first.device.deviceId)?.apnsToken).toBeUndefined();
    expect(registry.liveActivityTargetsFor('inst-1', MOBILE_OWNER_PROFILE_ID)).toEqual([
      { deviceId: second.device.deviceId, token: 'activity-token' },
    ]);
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
      const pairing = registry.issuePairing({ ttlMs: 1_000 });
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

    it('slides the expiry forward while the device keeps using its token', () => {
      const pairing = registry.issuePairing();
      const result = registry.pair({ pairingToken: pairing.pairingToken });
      if (result.status !== 'paired') throw new Error('expected pairing to succeed');
      const originalExpiry = result.device.expiresAt;

      // Day 80 of a 90-day token: still valid, and using it must push the deadline out.
      vi.setSystemTime(new Date('2026-03-22T00:00:00Z'));
      expect(registry.validateToken(result.device.token)).not.toBeNull();
      expect(result.device.expiresAt).toBeGreaterThan(originalExpiry);

      // Past the ORIGINAL deadline, the renewed token still works — this is the
      // regression: an in-use phone used to 401 here and could only report it as
      // a generic connection failure.
      vi.setSystemTime(new Date(originalExpiry + 60_000));
      expect(registry.validateToken(result.device.token)).not.toBeNull();
    });

    it('persists a renewal so it survives a restart', () => {
      const pairing = registry.issuePairing();
      const result = registry.pair({ pairingToken: pairing.pairingToken });
      if (result.status !== 'paired') throw new Error('expected pairing to succeed');
      const originalExpiry = result.device.expiresAt;

      vi.setSystemTime(new Date('2026-03-22T00:00:00Z'));
      registry.validateToken(result.device.token);

      const reloaded = new MobileDeviceRegistry(persistence);
      vi.setSystemTime(new Date(originalExpiry + 60_000));
      expect(reloaded.validateToken(result.device.token)).not.toBeNull();
    });

    it('still expires a device that goes unused for a full TTL', () => {
      const pairing = registry.issuePairing();
      const result = registry.pair({ pairingToken: pairing.pairingToken });
      if (result.status !== 'paired') throw new Error('expected pairing to succeed');

      // Never validated in between, so nothing renewed it.
      vi.setSystemTime(new Date(result.device.expiresAt + 1));
      expect(registry.validateToken(result.device.token)).toBeNull();
    });

    it('does not rewrite storage on every request', () => {
      const pairing = registry.issuePairing();
      const result = registry.pair({ pairingToken: pairing.pairingToken });
      if (result.status !== 'paired') throw new Error('expected pairing to succeed');
      const saves = persistence.saveCount();

      for (let i = 0; i < 25; i += 1) {
        registry.validateToken(result.device.token);
      }
      expect(persistence.saveCount()).toBe(saves);
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

  function pairDevice(): { deviceId: string; token: string } {
    const pairing = registry.issuePairing();
    const result = registry.pair({ pairingToken: pairing.pairingToken, label: 'phone' });
    if (result.status !== 'paired') throw new Error('pairing failed');
    return { deviceId: result.device.deviceId, token: result.device.token };
  }

  it('stores, retrieves and clears per-instance activity tokens', () => {
    const { deviceId } = pairDevice();

    expect(registry.setLiveActivityToken(deviceId, 'inst-1', 'tok-a')).toBe(true);
    expect(registry.liveActivityTargetsFor('inst-1', MOBILE_OWNER_PROFILE_ID).map((target) => target.token)).toEqual(['tok-a']);
    expect(registry.liveActivityTargetsFor('inst-2', MOBILE_OWNER_PROFILE_ID).map((target) => target.token)).toEqual([]);

    // Empty token clears the registration.
    expect(registry.setLiveActivityToken(deviceId, 'inst-1', '')).toBe(true);
    expect(registry.liveActivityTargetsFor('inst-1', MOBILE_OWNER_PROFILE_ID).map((target) => target.token)).toEqual([]);
  });

  it('clears tokens for a removed instance across devices', () => {
    const { deviceId } = pairDevice();
    registry.setLiveActivityToken(deviceId, 'inst-1', 'tok-a');
    registry.clearLiveActivityTokensForInstance('inst-1');
    expect(registry.liveActivityTargetsFor('inst-1', MOBILE_OWNER_PROFILE_ID).map((target) => target.token)).toEqual([]);
  });

  it('clears an invalid activity token by value', () => {
    const { deviceId } = pairDevice();
    registry.setLiveActivityToken(deviceId, 'inst-1', 'dead-token');

    expect(registry.clearLiveActivityToken('dead-token')).toBe(true);
    expect(registry.liveActivityTargetsFor('inst-1', MOBILE_OWNER_PROFILE_ID).map((target) => target.token)).toEqual([]);
  });

  it('rejects tokens for unknown devices', () => {
    expect(registry.setLiveActivityToken('ghost', 'inst-1', 'tok')).toBe(false);
  });

  it('reattaches activity tokens after the old pairing was revoked', () => {
    const old = pairDevice();
    registry.setApnsToken(old.deviceId, 'physical-token');
    registry.setLiveActivityToken(old.deviceId, 'inst-1', 'activity-token');
    registry.revokeDevice(old.deviceId);
    expect(registry.liveActivityTargetsFor('inst-1', MOBILE_OWNER_PROFILE_ID)).toEqual([]);

    const replacement = pairDevice();
    registry.setApnsToken(replacement.deviceId, 'physical-token');

    expect(registry.liveActivityTargetsFor('inst-1', MOBILE_OWNER_PROFILE_ID)).toEqual([
      { deviceId: replacement.deviceId, token: 'activity-token' },
    ]);
  });

  it('does not resurrect an ended activity from a revoked pairing', () => {
    const old = pairDevice();
    registry.setApnsToken(old.deviceId, 'physical-token');
    registry.setLiveActivityToken(old.deviceId, 'ended-instance', 'stale-activity-token');
    registry.revokeDevice(old.deviceId);
    registry.clearLiveActivityTokensForInstance('ended-instance');

    const replacement = pairDevice();
    registry.setApnsToken(replacement.deviceId, 'physical-token');

    expect(registry.liveActivityTargetsFor('ended-instance', MOBILE_OWNER_PROFILE_ID)).toEqual([]);
  });

  it('purges retired activities when APNs rejects the physical device token', () => {
    const old = pairDevice();
    registry.setApnsToken(old.deviceId, 'invalid-physical-token');
    registry.setLiveActivityToken(old.deviceId, 'inst-1', 'activity-token');
    registry.revokeDevice(old.deviceId);

    expect(registry.clearApnsToken('invalid-physical-token')).toBe(true);
    const replacement = pairDevice();
    registry.setApnsToken(replacement.deviceId, 'invalid-physical-token');
    expect(registry.liveActivityTargetsFor('inst-1', MOBILE_OWNER_PROFILE_ID)).toEqual([]);
  });

  it('purges a retired activity token when ActivityKit APNs rejects it', () => {
    const first = pairDevice();
    registry.setApnsToken(first.deviceId, 'physical-token-a');
    registry.setLiveActivityToken(first.deviceId, 'inst-1', 'invalid-activity-token');
    registry.setLiveActivityToken(first.deviceId, 'inst-safe', 'valid-activity-token');
    registry.revokeDevice(first.deviceId);
    const second = pairDevice();
    registry.setApnsToken(second.deviceId, 'physical-token-b');
    registry.setLiveActivityToken(second.deviceId, 'inst-2', 'invalid-activity-token');
    registry.revokeDevice(second.deviceId);

    expect(registry.clearLiveActivityToken('invalid-activity-token')).toBe(true);
    const replacementA = pairDevice();
    registry.setApnsToken(replacementA.deviceId, 'physical-token-a');
    const replacementB = pairDevice();
    registry.setApnsToken(replacementB.deviceId, 'physical-token-b');
    expect(registry.liveActivityTargetsFor('inst-1', MOBILE_OWNER_PROFILE_ID)).toEqual([]);
    expect(registry.liveActivityTargetsFor('inst-2', MOBILE_OWNER_PROFILE_ID)).toEqual([]);
    expect(registry.liveActivityTargetsFor('inst-safe', MOBILE_OWNER_PROFILE_ID)).toEqual([
      { deviceId: replacementA.deviceId, token: 'valid-activity-token' },
    ]);
  });

  it('reattaches activity tokens after the old pairing expired', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-25T12:00:00Z'));
    try {
      const pairing = registry.issuePairing();
      const old = registry.pair({ pairingToken: pairing.pairingToken, tokenTtlMs: 60_000 });
      if (old.status !== 'paired') throw new Error('pairing failed');
      registry.setApnsToken(old.device.deviceId, 'physical-token');
      registry.setLiveActivityToken(old.device.deviceId, 'inst-1', 'activity-token');
      vi.advanceTimersByTime(60_001);
      expect(registry.validateToken(old.device.token)).toBeNull();

      const replacement = pairDevice();
      registry.setApnsToken(replacement.deviceId, 'physical-token');

      expect(registry.liveActivityTargetsFor('inst-1', MOBILE_OWNER_PROFILE_ID)).toEqual([
        { deviceId: replacement.deviceId, token: 'activity-token' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MobileDeviceRegistry people', () => {
  function pairFor(registry: MobileDeviceRegistry, profileId?: string) {
    const result = registry.pair({
      pairingToken: registry.issuePairing(profileId ? { profileId } : {}).pairingToken,
    });
    if (result.status !== 'paired') throw new Error(result.reason);
    return result.device;
  }

  it('remembers people across a restart', () => {
    const persistence = memPersistence();
    const added = new MobileDeviceRegistry(persistence).addMember('  Second person  ');

    const reloaded = new MobileDeviceRegistry(persistence);

    expect(added.name).toBe('Second person');
    expect(reloaded.listMembers()).toEqual([added]);
  });

  it('pairs a phone to the person named in the pairing', () => {
    const registry = new MobileDeviceRegistry(memPersistence());
    const member = registry.addMember('Second person');

    const ownerPhone = pairFor(registry);
    const memberPhone = pairFor(registry, member.profileId);

    expect(ownerPhone.profileId).toBe(MOBILE_OWNER_PROFILE_ID);
    expect(memberPhone.profileId).toBe(member.profileId);
    expect(registry.listDevices().map((d) => [d.deviceId, d.profileId])).toEqual(
      expect.arrayContaining([
        [ownerPhone.deviceId, MOBILE_OWNER_PROFILE_ID],
        [memberPhone.deviceId, member.profileId],
      ]),
    );
  });

  it('refuses a pairing for someone who does not exist', () => {
    const registry = new MobileDeviceRegistry(memPersistence());

    expect(() => registry.issuePairing({ profileId: 'nobody' })).toThrow();
    expect(() => registry.addMember('   ')).toThrow();
  });

  it('treats phones paired before people existed as the owner', () => {
    const persistence = memPersistence();
    persistence.save(JSON.stringify([{
      deviceId: 'old-phone', label: 'iPhone', token: 'old-token', createdAt: 1,
      lastSeenAt: 1, expiresAt: Date.now() + 60_000, apnsToken: 'old-push-placeholder',
    }]));
    const registry = new MobileDeviceRegistry(persistence);
    const member = registry.addMember('Second person');

    expect(registry.listDevices()[0]?.profileId).toBe(MOBILE_OWNER_PROFILE_ID);
    expect(registry.apnsTargets(MOBILE_OWNER_PROFILE_ID)).toEqual([
      { deviceId: 'old-phone', token: 'old-push-placeholder' },
    ]);
    expect(registry.apnsTargets(member.profileId)).toEqual([]);
  });

  it("removing a person revokes only their phones and their unused pairings", () => {
    const registry = new MobileDeviceRegistry(memPersistence());
    const member = registry.addMember('Second person');
    const ownerPhone = pairFor(registry);
    const memberPhone = pairFor(registry, member.profileId);
    const unused = registry.issuePairing({ profileId: member.profileId });
    const revoked: string[] = [];
    registry.onDeviceRevoked((deviceId) => revoked.push(deviceId));

    expect(registry.removeMember(member.profileId)).toBe(true);

    expect(revoked).toEqual([memberPhone.deviceId]);
    expect(registry.validateToken(memberPhone.token)).toBeNull();
    expect(registry.validateToken(ownerPhone.token)?.deviceId).toBe(ownerPhone.deviceId);
    expect(registry.pair({ pairingToken: unused.pairingToken }).status).toBe('rejected');
    expect(registry.listMembers()).toEqual([]);
    expect(registry.removeMember(member.profileId)).toBe(false);
  });

  it('refuses a phone whose person is missing from the saved list', () => {
    const persistence = memPersistence();
    const registry = new MobileDeviceRegistry(persistence);
    const member = registry.addMember('Second person');
    const phone = pairFor(registry, member.profileId);
    persistence.saveProfiles('[]');

    const reloaded = new MobileDeviceRegistry(persistence);

    expect(reloaded.validateToken(phone.token)).toBeNull();
    expect(reloaded.hasProfile(member.profileId)).toBe(false);
  });
});
