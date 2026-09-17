import { describe, expect, it } from 'vitest';
import type { AccountBindingState, ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import { selectAccount, type SelectAccountInput } from './provider-account-selector';

function profile(id: string, priority: number, overrides: Partial<ProviderAccountProfile> = {}): ProviderAccountProfile {
  return {
    id,
    provider: 'claude',
    label: id,
    expectedIdentity: null,
    expectedAccountKey: null,
    planLabel: null,
    priority,
    enabled: true,
    automationPolicy: 'allow-routed',
    isLegacy: id === 'legacy',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function input(overrides: Partial<SelectAccountInput> = {}): SelectAccountInput {
  const profiles = overrides.profiles ?? [profile('legacy', 0), profile('max-b', 1), profile('max-c', 2)];
  return {
    profiles,
    origin: 'interactive',
    parkedProfileIds: [],
    bindings: new Map<string, AccountBindingState>(profiles.map((entry) => [entry.id, 'authenticated'])),
    ...overrides,
  };
}

describe('selectAccount', () => {
  it('stays on the highest-priority eligible profile', () => {
    expect(selectAccount(input()).profileId).toBe('legacy');
  });

  it.each([
    ['disabled', { profiles: [profile('legacy', 0, { enabled: false }), profile('max-b', 1)] }],
    ['automation-disallowed', { origin: 'loop' as const, profiles: [profile('legacy', 0, { automationPolicy: 'manual-only' }), profile('max-b', 1)] }],
    ['excluded', { exclude: ['legacy'] }],
    ['parked', { parkedProfileIds: ['legacy'] }],
    ['exhausted', { quotaByProfile: new Map([['legacy', { fiveHourPct: 100 }]]) }],
    ['over-threshold', { thresholdPct: 90, quotaByProfile: new Map([['legacy', { fiveHourPct: 92 }]]) }],
  ])('skips a %s profile with that named veto', (veto, overrides) => {
    const result = selectAccount(input(overrides as Partial<SelectAccountInput>));
    expect(result.profileId).toBe('max-b');
    expect(result.considered).toEqual([{ profileId: 'legacy', vetoReason: veto }]);
  });

  it('vetoes an unverified binding unless bindings are ignored (remote placement)', () => {
    const bindings = new Map<string, AccountBindingState>([['legacy', 'unauthenticated'], ['max-b', 'authenticated']]);
    expect(selectAccount(input({ bindings })).considered).toEqual([{ profileId: 'legacy', vetoReason: 'unbound' }]);
    expect(selectAccount(input({ bindings, ignoreBindings: true })).profileId).toBe('legacy');
  });

  it('never picks disabled-policy profiles, even interactively', () => {
    const result = selectAccount(input({ profiles: [profile('legacy', 0, { automationPolicy: 'disabled' })] }));
    expect(result).toEqual({ profileId: null, considered: [{ profileId: 'legacy', vetoReason: 'automation-disallowed' }] });
  });

  it('allows manual-only profiles for interactive selection', () => {
    expect(selectAccount(input({ profiles: [profile('legacy', 0, { automationPolicy: 'manual-only' })] })).profileId).toBe('legacy');
  });

  it('breaks ties consume-first, then least recently used', () => {
    const tied = [profile('a', 0), profile('b', 0), profile('c', 0)];
    const quota = new Map([['a', { weeklyResetsAt: 3000 }], ['b', { weeklyResetsAt: 1000 }]]);
    expect(selectAccount(input({ profiles: tied, quotaByProfile: quota })).profileId).toBe('b');
    const lastUsedAt = new Map([['a', 50], ['b', 10], ['c', 30]]);
    expect(selectAccount(input({ profiles: tied, lastUsedAt })).profileId).toBe('b');
  });

  it('vetoes a spent weekly window, and an account the provider says cannot run, as exhausted', () => {
    const weekly = selectAccount(input({ quotaByProfile: new Map([['legacy', { weeklyPct: 100 }]]) }));
    expect(weekly.considered).toEqual([{ profileId: 'legacy', vetoReason: 'exhausted' }]);
    const refused = selectAccount(input({ quotaByProfile: new Map([['legacy', { fiveHourPct: 3, weeklyPct: 20, usable: false }]]) }));
    expect(refused.considered).toEqual([{ profileId: 'legacy', vetoReason: 'exhausted' }]);
  });

  it('counts purchased credits as usage left, unless credits are disallowed', () => {
    const quotaByProfile = new Map([['legacy', { weeklyPct: 100, usable: true, creditsOnly: true }]]);
    expect(selectAccount(input({ quotaByProfile })).profileId).toBe('legacy');
    const noCredits = selectAccount(input({ quotaByProfile, allowCredits: false }));
    expect(noCredits.profileId).toBe('max-b');
    expect(noCredits.considered).toEqual([{ profileId: 'legacy', vetoReason: 'credits-only' }]);
  });

  it('never moves pre-emptively onto an account that would bill credits', () => {
    const quotaByProfile = new Map([['legacy', { fiveHourPct: 0, weeklyPct: 100, usable: true, creditsOnly: true }]]);
    expect(selectAccount(input({ quotaByProfile, thresholdPct: 90 })).considered)
      .toEqual([{ profileId: 'legacy', vetoReason: 'over-threshold' }]);
  });

  it('lifts a park only on a usable verdict observed after the limit was recorded', () => {
    const parked = { parkedProfileIds: ['legacy'], parkedSince: new Map([['legacy', 1_000]]) };
    const at = (observedAt: number, extra: Record<string, unknown> = {}) =>
      new Map([['legacy', { weeklyPct: 100, usable: true, creditsOnly: true, observedAt, ...extra }]]);
    expect(selectAccount(input({ ...parked, quotaByProfile: at(900) })).considered)
      .toEqual([{ profileId: 'legacy', vetoReason: 'parked' }]);
    expect(selectAccount(input({ ...parked, quotaByProfile: at(1_100) })).profileId).toBe('legacy');
    // Without the park time a park always holds; without a verdict windows never lift it.
    expect(selectAccount(input({ parkedProfileIds: ['legacy'], quotaByProfile: at(1_100) })).profileId).toBe('max-b');
    expect(selectAccount(input({ ...parked, quotaByProfile: new Map([['legacy', { weeklyPct: 10, observedAt: 1_100 }]]) })).profileId)
      .toBe('max-b');
    // A credits-only verdict does not lift a park for work that may not spend credits.
    expect(selectAccount(input({ ...parked, quotaByProfile: at(1_100), allowCredits: false })).considered)
      .toEqual([{ profileId: 'legacy', vetoReason: 'parked' }]);
  });

  it('reports every veto when nothing is eligible', () => {
    const result = selectAccount(input({ parkedProfileIds: ['legacy', 'max-b', 'max-c'] }));
    expect(result.profileId).toBeNull();
    expect(result.considered.map((entry) => entry.vetoReason)).toEqual(['parked', 'parked', 'parked']);
  });
});
