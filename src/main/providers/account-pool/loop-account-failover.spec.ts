import { describe, expect, it, vi } from 'vitest';
import type { PooledProvider, ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import { defaultProviderAccountPools } from '../../../shared/types/provider-account.types';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('./provider-account-events', () => ({ emitProviderAccountEvent: vi.fn() }));

import { LoopAccountFailover } from './loop-account-failover';
import { rememberAdapterAccountRoute } from './adapter-account-routes';
import { ProviderAccountStore } from './provider-account-store';
import type { AccountQuotaEvidence } from './provider-account-selector';

function profile(id: string, priority: number, provider: PooledProvider = 'codex'): ProviderAccountProfile {
  return {
    id, provider, label: id, expectedIdentity: null, expectedAccountKey: null, planLabel: null,
    ...(provider === 'opencode' ? { region: 'ams' as const } : {}),
    priority, enabled: true, automationPolicy: 'allow-routed', isLegacy: id === 'legacy', createdAt: 1, updatedAt: 1,
  };
}

function setup(
  policy: Partial<ReturnType<typeof defaultProviderAccountPools>['codex']> = {},
  quota: Record<string, AccountQuotaEvidence> = {},
  provider: PooledProvider = 'codex',
) {
  const pools = defaultProviderAccountPools();
  pools[provider] = { ...pools[provider], failoverMode: 'automatic', acknowledgedOwnershipAt: 1, switchCooldownMs: 0, ...policy };
  const store = new ProviderAccountStore({ read: () => ({ profiles: [profile('legacy', 0, provider), profile('pro-b', 1, provider)], pools }) });
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
  rememberAdapterAccountRoute(adapter, { provider, profileId: 'legacy', source: 'default', executionNodeId: 'local', ...(provider === 'opencode' ? { region: 'ams' as const } : {}) });
  failover.noteIterationAdapter('loop-1', adapter, { provider, model: provider === 'opencode' ? 'xiaomi-token-plan-ams/mimo-v2.6-pro' : 'gpt-5.5' });
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


describe('LoopAccountFailover logical MiMo isolation', () => {
  it.each(['opencode/big-pickle', 'openrouter/placeholder-model', 'auto', '', undefined, 'aio-mimo-pro-b/mimo-v2.6-pro'])(
    'rejects an explicit non-logical MiMo switch for %s without side effects', (model) => {
      const h = setup({}, {}, 'opencode');
      expect(h.failover.trySwitch({ loopRunId: 'loop-1', provider: 'opencode', model: model as string, iteration: 1, reason: 'limit' })).toBe(false);
      expect(h.failover.currentProfileId('loop-1', 'opencode')).toBe('legacy');
      expect(h.recycle).not.toHaveBeenCalled();
      expect(h.notify).not.toHaveBeenCalled();
    },
  );

  it.each(['xiaomi-token-plan/mimo-v2.6-pro', 'xiaomi-token-plan-ams/mimo-v2.6-pro', 'xiaomi-token-plan-sgp/mimo-v2.6-pro', 'xiaomi-token-plan-cn/mimo-v2.6-pro', null])(
    'retains valid logical or current account-wide MiMo failover for %s', (model) => {
      const h = setup({}, {}, 'opencode');
      expect(h.failover.trySwitch({ loopRunId: 'loop-1', provider: 'opencode', model, iteration: 1, reason: 'limit' })).toBe(true);
      expect(h.failover.currentProfileId('loop-1', 'opencode')).toBe('pro-b');
      expect(h.recycle).toHaveBeenCalledTimes(1);
    },
  );

  it('clears a route-less replacement account but retains the actual model and recycler', () => {
    const h = setup({}, {}, 'opencode');
    h.failover.noteIterationAdapter('loop-1', {}, { provider: 'opencode', model: 'opencode/big-pickle' });
    expect(h.failover.currentProfileId('loop-1', 'opencode')).toBeNull();
    expect(h.failover.currentModel('loop-1', 'opencode')).toBe('opencode/big-pickle');
    expect(h.failover.trySwitch({ loopRunId: 'loop-1', provider: 'opencode', model: null, iteration: 1, reason: 'limit' })).toBe(false);
    const adapter = {};
    rememberAdapterAccountRoute(adapter, { provider: 'opencode', profileId: 'legacy', source: 'default', executionNodeId: 'local', region: 'sgp' });
    h.failover.noteIterationAdapter('loop-1', adapter, { provider: 'opencode', model: 'xiaomi-token-plan-sgp/mimo-v2.6-pro' });
    expect(h.failover.trySwitch({ loopRunId: 'loop-1', provider: 'opencode', model: null, iteration: 2, reason: 'limit' })).toBe(true);
    expect(h.recycle).toHaveBeenCalledTimes(1);
    h.failover.clear('loop-1');
    expect(h.failover.currentModel('loop-1', 'opencode')).toBeNull();
  });

  it('clears stale attribution when a route-less adapter has no declared model', () => {
    const h = setup({}, {}, 'opencode');
    h.failover.noteIterationAdapter('loop-1', {});
    expect(h.failover.currentProfileId('loop-1', 'opencode')).toBeNull();
    expect(h.failover.currentModel('loop-1', 'opencode')).toBeNull();
  });

  it('cannot treat a stale attached MiMo route as pool evidence for a declared native model', () => {
    const h = setup({}, {}, 'opencode');
    const adapter = {};
    rememberAdapterAccountRoute(adapter, { provider: 'opencode', profileId: 'legacy', source: 'default', executionNodeId: 'local', region: 'ams' });
    h.failover.noteIterationAdapter('loop-1', adapter, { provider: 'opencode', model: 'opencode/big-pickle' });
    expect(h.failover.currentProfileId('loop-1', 'opencode')).toBeNull();
  });

  it('preserves acknowledgement, off/ask mode, cooldown, cap and exhausted allowance checks for MiMo', () => {
    const params = { loopRunId: 'loop-1', provider: 'opencode', model: null, iteration: 1, reason: 'limit' };
    for (const policy of [{ failoverMode: 'ask' as const }, { failoverMode: 'off' as const }, { acknowledgedOwnershipAt: null }]) {
      expect(setup(policy, {}, 'opencode').failover.trySwitch(params)).toBe(false);
    }
    expect(setup({}, { 'pro-b': { allowancePct: 100 } }, 'opencode').failover.trySwitch(params)).toBe(false);
    const h = setup({ switchCooldownMs: 500 }, {}, 'opencode');
    expect(h.failover.trySwitch(params)).toBe(true);
    expect(h.failover.trySwitch(params)).toBe(false);
    expect(h.failover.trySwitch({ ...params, iteration: 2 })).toBe(false);
    h.clock.now += 500;
    expect(h.failover.trySwitch({ ...params, iteration: 2 })).toBe(true);
  });
});
