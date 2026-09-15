import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCOUNT_POOL_POLICY,
  PROVIDER_ACCOUNT_PROFILE_ID_PATTERN,
  defaultProviderAccountPools,
  isAutomaticAccountOrigin,
  isLegacyAccountProfileId,
  isPooledProvider,
} from './provider-account.types';

describe('provider account types', () => {
  it('accepts safe profile slugs and rejects anything that could escape a directory', () => {
    for (const id of ['legacy', 'max-a', 'a', 'pro-2-3f9a']) {
      expect(PROVIDER_ACCOUNT_PROFILE_ID_PATTERN.test(id), id).toBe(true);
    }
    for (const id of ['', '-a', 'Max', '../x', 'a/b', 'a'.repeat(64), 'a b', '.hidden']) {
      expect(PROVIDER_ACCOUNT_PROFILE_ID_PATTERN.test(id), id).toBe(false);
    }
  });

  it('ships the documented pool defaults', () => {
    expect(DEFAULT_ACCOUNT_POOL_POLICY).toEqual({
      failoverMode: 'ask',
      continuation: 'shared-store',
      preemptive: { newSessions: true, liveSessionsAtTurnBoundary: false, thresholdPct: 90 },
      switchCooldownMs: 300_000,
      maxSwitchesPerTurn: 3,
      acknowledgedOwnershipAt: null,
    });
  });

  it('hands out independent copies of the default pools', () => {
    const pools = defaultProviderAccountPools();
    pools.claude.preemptive.thresholdPct = 50;
    expect(defaultProviderAccountPools().claude.preemptive.thresholdPct).toBe(90);
    expect(DEFAULT_ACCOUNT_POOL_POLICY.preemptive.thresholdPct).toBe(90);
  });

  it('recognises pooled providers, the legacy id and automatic origins', () => {
    expect(isPooledProvider('claude')).toBe(true);
    expect(isPooledProvider('codex')).toBe(true);
    expect(isPooledProvider('copilot')).toBe(false);
    expect(isLegacyAccountProfileId('legacy')).toBe(true);
    expect(isLegacyAccountProfileId('max-a')).toBe(false);
    expect(isAutomaticAccountOrigin('interactive')).toBe(false);
    expect(isAutomaticAccountOrigin('loop')).toBe(true);
  });
});
