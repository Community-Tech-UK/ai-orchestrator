import { describe, expect, it, vi } from 'vitest';
import type { ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import { defaultProviderAccountPools } from '../../../shared/types/provider-account.types';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('./provider-account-events', () => ({ emitProviderAccountEvent: vi.fn() }));

import { LoopAccountFailover } from './loop-account-failover';
import { rememberAdapterAccountRoute } from './adapter-account-routes';
import { ProviderAccountStore } from './provider-account-store';
import type { AccountQuotaEvidence } from './provider-account-selector';

function profile(id: string, priority: number): ProviderAccountProfile {
  return {
    id, provider: 'codex', label: id, expectedIdentity: null, expectedAccountKey: null, planLabel: null,
    priority, enabled: true, automationPolicy: 'allow-routed', isLegacy: id === 'legacy', createdAt: 1, updatedAt: 1,
  };
}

function setup(
  policy: Partial<ReturnType<typeof defaultProviderAccountPools>['codex']> = {},
  quota: Record<string, AccountQuotaEvidence> = {},
) {
  const pools = defaultProviderAccountPools();
  pools.codex = { ...pools.codex, failoverMode: 'automatic', acknowledgedOwnershipAt: 1, switchCooldownMs: 0, ...policy };
  const store = new ProviderAccountStore({ read: () => ({ profiles: [profile('legacy', 0), profile('pro-b', 1)], pools }) });
  const recycle = vi.fn();
  const notify = vi.fn();
  const clock = { now: 1_000 };
  const failover = new LoopAccountFailover({
    store: () => store,
    cachedBindingState: () => undefined,
    getParkedProfileIds: () => [],
    getParkedSince: () => new Map<string, number>(),
    getQuotaEvidence: (_provider, id) => quota[id] ?? null,
    notify,
    now: () => clock.now,
  });
  const adapter = {};
  rememberAdapterAccountRoute(adapter, { provider: 'codex', profileId: 'legacy', source: 'default', executionNodeId: 'local' });
  failover.noteIterationAdapter('loop-1', adapter);
  failover.registerRecycler('loop-1', recycle);
  return { failover, recycle, notify, clock };
}

describe('LoopAccountFailover', () => {
  it('tracks the account an iteration adapter ran on and switches away, recycling the persistent adapter', () => {
    const h = setup();
    expect(h.failover.currentProfileId('loop-1', 'codex')).toBe('legacy');
    expect(h.failover.trySwitch({ loopRunId: 'loop-1', provider: 'codex', model: null, iteration: 3, reason: 'limit' })).toBe(true);
    expect(h.recycle).toHaveBeenCalledTimes(1);
    expect(h.failover.currentProfileId('loop-1', 'codex')).toBe('pro-b');
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'account-switched' }));
  });

  it('does not switch in ask mode, without acknowledgement, or past the per-iteration cap', () => {
    expect(setup({ failoverMode: 'ask' }).failover.trySwitch({ loopRunId: 'loop-1', provider: 'codex', model: null, iteration: 1, reason: 'x' })).toBe(false);
    expect(setup({ acknowledgedOwnershipAt: null }).failover.trySwitch({ loopRunId: 'loop-1', provider: 'codex', model: null, iteration: 1, reason: 'x' })).toBe(false);
    const capped = setup();
    expect(capped.failover.trySwitch({ loopRunId: 'loop-1', provider: 'codex', model: null, iteration: 1, reason: 'x' })).toBe(true);
    // Two profiles → at most one switch per iteration.
    expect(capped.failover.trySwitch({ loopRunId: 'loop-1', provider: 'codex', model: null, iteration: 1, reason: 'x' })).toBe(false);
  });

  it('moves onto an account that runs only on purchased credits only when the loop may spend them', () => {
    const quota = { 'pro-b': { weeklyPct: 100, usable: true, creditsOnly: true } };
    const params = { loopRunId: 'loop-1', provider: 'codex', model: null, iteration: 1, reason: 'x' };
    const guarded = setup({}, quota);
    expect(guarded.failover.trySwitch(params)).toBe(false);
    expect(guarded.recycle).not.toHaveBeenCalled();
    expect(setup({}, quota).failover.trySwitch({ ...params, allowCredits: true })).toBe(true);
  });

  it('does not move onto an account whose weekly usage is spent', () => {
    const h = setup({}, { 'pro-b': { weeklyPct: 100 } });
    expect(h.failover.trySwitch({ loopRunId: 'loop-1', provider: 'codex', model: null, iteration: 1, reason: 'x' })).toBe(false);
  });

  it('ignores loops it has no account record for and clears on teardown', () => {
    const h = setup();
    expect(h.failover.trySwitch({ loopRunId: 'other', provider: 'codex', model: null, iteration: 1, reason: 'x' })).toBe(false);
    h.failover.clear('loop-1');
    expect(h.failover.currentProfileId('loop-1', 'codex')).toBeNull();
  });
});
