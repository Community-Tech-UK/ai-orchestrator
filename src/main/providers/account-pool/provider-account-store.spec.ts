import { describe, expect, it, vi } from 'vitest';
import type { ProviderAccountPools, ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import { defaultProviderAccountPools } from '../../../shared/types/provider-account.types';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => {
    throw new Error('settings-manager must not be reached in this spec');
  },
}));

import {
  ProviderAccountStore,
  deriveProviderAccountProfileId,
  normalizePools,
  onProviderAccountsChanged,
} from './provider-account-store';

function legacy(provider: 'claude' | 'codex'): ProviderAccountProfile {
  return {
    id: 'legacy',
    provider,
    label: `Existing ${provider} account`,
    expectedIdentity: null,
    expectedAccountKey: null,
    planLabel: null,
    priority: 0,
    enabled: true,
    automationPolicy: 'allow-routed',
    isLegacy: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

function makeStore(initial: { profiles?: ProviderAccountProfile[]; pools?: ProviderAccountPools } = {}) {
  const state = {
    profiles: initial.profiles ?? [legacy('claude'), legacy('codex')],
    pools: initial.pools ?? defaultProviderAccountPools(),
  };
  let suffix = 0;
  const store = new ProviderAccountStore({
    read: () => ({ profiles: [...state.profiles], pools: state.pools }),
    write: (update) => {
      if (update.profiles) state.profiles = update.profiles;
      if (update.pools) state.pools = update.pools;
    },
    now: () => 5000,
    randomSuffix: () => `s${(suffix += 1)}`,
  });
  return { store, state };
}

describe('deriveProviderAccountProfileId', () => {
  it('slugifies the label and always appends a suffix so homes are never reused', () => {
    expect(deriveProviderAccountProfileId('Max A!', [], () => 'ab12')).toBe('max-a-ab12');
    expect(deriveProviderAccountProfileId('Legacy', [], () => 'ab12')).toBe('account-ab12');
    expect(deriveProviderAccountProfileId('???', [], () => 'ab12')).toBe('account-ab12');
  });

  it('retries on a collision', () => {
    const suffixes = ['aa', 'bb'];
    expect(deriveProviderAccountProfileId('max', ['max-aa'], () => suffixes.shift()!)).toBe('max-bb');
  });
});

describe('ProviderAccountStore', () => {
  it('creates a profile after the legacy one, disabled until ownership is acknowledged', () => {
    const { store } = makeStore();
    const profile = store.createProfile({ provider: 'claude', label: 'Max B' });
    expect(profile).toMatchObject({ id: 'max-b-s1', priority: 1, enabled: false, isLegacy: false });
    expect(store.hasNonLegacyProfiles('claude')).toBe(true);
    expect(store.hasNonLegacyProfiles('codex')).toBe(false);
  });

  it('refuses to enable a second account before acknowledgement, then allows it', () => {
    const { store } = makeStore();
    const profile = store.createProfile({ provider: 'claude', label: 'Max B' });
    expect(() => store.updateProfile('claude', profile.id, { enabled: true })).toThrow(/personally pay/);
    const policy = store.acknowledgeOwnership('claude');
    expect(policy.acknowledgedOwnershipAt).toBe(5000);
    expect(policy.failoverMode).toBe('automatic');
    expect(store.updateProfile('claude', profile.id, { enabled: true }).enabled).toBe(true);
  });

  it('keeps an explicit off mode when ownership is acknowledged', () => {
    const { store } = makeStore();
    store.setPoolPolicy('codex', { failoverMode: 'off' });
    expect(store.acknowledgeOwnership('codex').failoverMode).toBe('off');
  });

  it('never leaves a provider with no enabled account', () => {
    const { store } = makeStore();
    expect(() => store.updateProfile('claude', 'legacy', { enabled: false })).toThrow(/must stay enabled/);
  });

  it('reorders priorities and validates the full list', () => {
    const { store } = makeStore();
    const b = store.createProfile({ provider: 'claude', label: 'Max B' });
    expect(() => store.setPriorityOrder('claude', [b.id])).toThrow(/exactly once/);
    const ordered = store.setPriorityOrder('claude', [b.id, 'legacy']);
    expect(ordered.map((profile) => [profile.id, profile.priority])).toEqual([[b.id, 0], ['legacy', 1]]);
  });

  it('refuses to remove the legacy profile or one in use', () => {
    const { store, state } = makeStore();
    const b = store.createProfile({ provider: 'codex', label: 'Pro B' });
    expect(() => store.removeProfile('codex', 'legacy')).toThrow(/cannot be removed/);
    expect(() => store.removeProfile('codex', b.id, [b.id])).toThrow(/in use/);
    store.removeProfile('codex', b.id);
    expect(state.profiles.some((profile) => profile.id === b.id)).toBe(false);
  });

  it('adopts an observed identity', () => {
    const { store } = makeStore();
    const updated = store.adoptObservedIdentity('codex', 'legacy', { identity: 'me@example.com', accountKey: 'acct-1', planLabel: 'pro' });
    expect(updated).toMatchObject({ expectedIdentity: 'me@example.com', expectedAccountKey: 'acct-1', planLabel: 'pro' });
  });

  it('rejects an invalid pool policy without persisting', () => {
    const { store, state } = makeStore();
    expect(() => store.setPoolPolicy('claude', { preemptive: { thresholdPct: 500 } })).toThrow(/invalid/);
    expect(state.pools.claude.preemptive.thresholdPct).toBe(90);
  });

  it('notifies change listeners on every persisted mutation', () => {
    const { store } = makeStore();
    const listener = vi.fn();
    const unsubscribe = onProviderAccountsChanged(listener);
    store.createProfile({ provider: 'claude', label: 'Max B' });
    unsubscribe();
    store.createProfile({ provider: 'claude', label: 'Max C' });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('normalizePools', () => {
  it('fills missing providers and fields from the defaults', () => {
    const pools = normalizePools({ claude: { failoverMode: 'off' } as never });
    expect(pools.claude.failoverMode).toBe('off');
    expect(pools.claude.preemptive.thresholdPct).toBe(90);
    expect(pools.codex.failoverMode).toBe('ask');
  });
});
