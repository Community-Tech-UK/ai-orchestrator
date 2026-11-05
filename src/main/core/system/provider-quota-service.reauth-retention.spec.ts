import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderQuotaService } from './provider-quota-service';
import type { ProviderQuotaSnapshot } from '../../../shared/types/provider-quota.types';

function reading(used = 20): ProviderQuotaSnapshot {
  return {
    provider: 'opencode', takenAt: 1_700_000_000_000, source: 'admin-api', ok: true,
    windows: [{ id: 'opencode.plan', label: 'Plan', kind: 'calendar-period', unit: 'tokens',
      used, limit: 100, remaining: 100 - used, resetsAt: null }],
  };
}

function failure(overrides: Partial<ProviderQuotaSnapshot> = {}): ProviderQuotaSnapshot {
  return {
    provider: 'opencode', takenAt: 1_700_000_120_000, source: 'admin-api', ok: false,
    windows: [], error: 'MiMo usage session refresh is temporarily unavailable.', ...overrides,
  };
}

const instruction = 'MiMo usage login expired. Choose Connect usage in Accounts to sign in again.';

describe('LT-782: unresolved quota authentication warnings', () => {
  let service: ProviderQuotaService;

  beforeEach(() => { service = new ProviderQuotaService(); });
  afterEach(() => { service._resetForTesting(); });

  describe.each([undefined, 'secondary-account'])('profile %s', (accountProfileId) => {
    function register(next: ProviderQuotaSnapshot): void {
      service.registerProbe({ provider: 'opencode', accountProfileId, probe: async () => next });
    }

    async function cacheRejectedReading(): Promise<ProviderQuotaSnapshot> {
      register(reading());
      await service.refresh('opencode', accountProfileId);
      register(failure({ needsReauth: true, error: instruction }));
      return (await service.refresh('opencode', accountProfileId))!;
    }

    it('retains warning, instruction, windows and age on repeated verdict-free failures and pushes them', async () => {
      const rejected = await cacheRejectedReading();
      const updates = vi.fn();
      service.on('quota-updated', updates);
      register(failure());

      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await service.refreshProviderFamily('opencode');
        expect(result).toEqual(rejected);
        expect(result).toMatchObject({ needsReauth: true, error: instruction, takenAt: reading().takenAt });
        expect(service.getSnapshot('opencode', accountProfileId)).toEqual(rejected);
        expect(updates).toHaveBeenLastCalledWith(rejected);
      }
      expect(updates).toHaveBeenCalledTimes(2);
    });

    it('retains the warning when the probe throws without a new authentication verdict', async () => {
      const rejected = await cacheRejectedReading();
      service.registerProbe({ provider: 'opencode', accountProfileId, probe: async () => { throw new Error('boom'); } });

      expect(await service.refresh('opencode', accountProfileId)).toEqual(rejected);
    });

    it('clears the warning and uses new windows and age after a successful reading', async () => {
      await cacheRejectedReading();
      const fresh = { ...reading(30), takenAt: reading().takenAt + 180_000 };
      register(fresh);

      const result = await service.refresh('opencode', accountProfileId);
      expect(result).toEqual({ ...fresh, ...(accountProfileId ? { accountProfileId } : {}) });
      expect(result?.needsReauth).toBeUndefined();
      expect(result?.error).toBeUndefined();
      expect(service.getSnapshot('opencode', accountProfileId)).toEqual(result);
    });

    it('honours explicit false and keeps subsequent transient failures quiet', async () => {
      const rejected = await cacheRejectedReading();
      register(failure({ needsReauth: false }));

      const cleared = await service.refresh('opencode', accountProfileId);
      expect(cleared).toEqual({ ...rejected, needsReauth: false, error: undefined });
      register(failure());
      expect(await service.refresh('opencode', accountProfileId)).toEqual(cleared);
    });

    it('uses a new explicit authentication instruction instead of the old one', async () => {
      await cacheRejectedReading();
      register(failure({ needsReauth: true, error: 'Reconnect the selected usage account.' }));

      expect(await service.refresh('opencode', accountProfileId)).toMatchObject({
        needsReauth: true, error: 'Reconnect the selected usage account.',
      });
    });

    it('keeps a healthy cache quiet during ordinary failures', async () => {
      register(reading());
      await service.refresh('opencode', accountProfileId);
      register(failure());

      expect(await service.refresh('opencode', accountProfileId)).toMatchObject({
        ok: true, needsReauth: false, error: undefined, windows: reading().windows, takenAt: reading().takenAt,
      });
    });

    it.each([
      { ok: true },
      { notApplicable: true as const },
      { cliNotInstalled: true },
    ])('replaces warned cached data with an authoritative empty snapshot: %j', async (override) => {
      await cacheRejectedReading();
      const replacement = { ...failure(override), error: undefined };
      register(replacement);

      expect(await service.refresh('opencode', accountProfileId)).toEqual({
        ...replacement, ...(accountProfileId ? { accountProfileId } : {}),
      });
      expect(service.getSnapshot('opencode', accountProfileId)?.needsReauth).toBeUndefined();
    });
  });

  it('keeps provider and account caches isolated when one account recovers', async () => {
    const next = new Map<string | undefined, ProviderQuotaSnapshot>([
      [undefined, reading(10)], ['expired-account', reading(20)], ['healthy-account', reading(30)],
    ]);
    for (const accountProfileId of next.keys()) {
      service.registerProbe({ provider: 'opencode', accountProfileId, probe: async () => next.get(accountProfileId)! });
    }
    await service.refreshProviderFamily('opencode');
    next.set('expired-account', failure({ needsReauth: true, error: instruction }));
    await service.refreshProviderFamily('opencode');
    for (const accountProfileId of next.keys()) next.set(accountProfileId, failure());
    await service.refreshProviderFamily('opencode');

    expect(service.getSnapshot('opencode', 'expired-account')).toMatchObject({
      needsReauth: true, error: instruction, windows: reading(20).windows,
    });
    for (const accountProfileId of [undefined, 'healthy-account']) {
      expect(service.getSnapshot('opencode', accountProfileId)).toMatchObject({ needsReauth: false, error: undefined });
    }
    next.set('healthy-account', { ...reading(35), takenAt: reading().takenAt + 180_000 });
    await service.refreshProviderFamily('opencode');
    expect(service.getSnapshot('opencode', 'expired-account')?.needsReauth).toBe(true);
    next.set('expired-account', reading(25));
    await service.refreshProviderFamily('opencode');
    expect(service.getAll().accountSnapshots).toEqual(expect.arrayContaining([
      { ...reading(25), accountProfileId: 'expired-account' },
      { ...reading(35), takenAt: reading().takenAt + 180_000, accountProfileId: 'healthy-account' },
    ]));
  });

  it('invalidates the warning and windows when the quota source changes', async () => {
    let next = reading();
    service.registerProbe({ provider: 'opencode', accountProfileId: 'account', quotaSource: 'saved:first', probe: async () => next });
    await service.refresh('opencode', 'account');
    next = failure({ needsReauth: true, error: instruction });
    await service.refresh('opencode', 'account');
    expect(service.getSnapshot('opencode', 'account')?.needsReauth).toBe(true);

    service.replaceAccountProbes('opencode', [{
      provider: 'opencode', accountProfileId: 'account', quotaSource: 'saved:second', probe: async () => failure(),
    }]);
    expect(service.getSnapshot('opencode', 'account')).toMatchObject({ notApplicable: true, windows: [] });
    expect(service.getSnapshot('opencode', 'account')?.needsReauth).toBeUndefined();
    expect(await service.refresh('opencode', 'account')).toMatchObject({ windows: [], ok: false });
    expect(service.getSnapshot('opencode', 'account')?.needsReauth).toBeUndefined();
  });
});
