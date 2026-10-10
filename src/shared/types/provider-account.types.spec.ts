import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ACCOUNT_POOL_POLICY,
  PROVIDER_ACCOUNT_PROFILE_ID_PATTERN,
  defaultProviderAccountPools,
  isAutomaticAccountOrigin,
  isLegacyAccountProfileId,
  isLogicalMiMoModel,
  isOpenCodeAccountProviderName,
  isPooledProvider,
  opencodeAccountProviderName,
  pooledProviderLabel,
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

  it('includes an OpenCode/MiMo pool with the shared-store continuation', () => {
    const pools = defaultProviderAccountPools();
    expect(Object.keys(pools).sort()).toEqual(['claude', 'codex', 'opencode']);
    expect(pools.opencode).toEqual(DEFAULT_ACCOUNT_POOL_POLICY);
    pools.opencode.preemptive.thresholdPct = 10;
    expect(defaultProviderAccountPools().opencode.preemptive.thresholdPct).toBe(90);
  });

  it('recognises pooled providers, the legacy id and automatic origins', () => {
    expect(isPooledProvider('claude')).toBe(true);
    expect(isPooledProvider('codex')).toBe(true);
    expect(isPooledProvider('opencode')).toBe(true);
    expect(isPooledProvider('copilot')).toBe(false);
    expect(isLegacyAccountProfileId('legacy')).toBe(true);
    expect(isLegacyAccountProfileId('max-b')).toBe(false);
    expect(isAutomaticAccountOrigin('interactive')).toBe(false);
    expect(isAutomaticAccountOrigin('loop')).toBe(true);
  });

  it('derives the OpenCode provider name, never a free-form one', () => {
    expect(opencodeAccountProviderName({ id: 'legacy', isLegacy: true, region: 'ams' })).toBe('xiaomi-token-plan-ams');
    expect(opencodeAccountProviderName({ id: 'max-b-1a2b', isLegacy: false, region: 'ams' })).toBe('aio-mimo-max-b-1a2b');
    expect(() => opencodeAccountProviderName({ id: 'legacy', isLegacy: true })).toThrow(/region/);
    expect(isOpenCodeAccountProviderName('aio-mimo-max-b-1a2b')).toBe(true);
    expect(isOpenCodeAccountProviderName('xiaomi-token-plan-ams')).toBe(false);
  });

  it.each([
    ['xiaomi-token-plan/mimo-v2.6-pro', true],
    [' xiaomi-token-plan-ams/mimo-v2.6-pro ', true],
    ['xiaomi-token-plan-sgp/mimo-v2.6-pro', true],
    ['xiaomi-token-plan-cn/mimo-v2.6-pro', true],
    ['xiaomi-token-plan-us/mimo-v2.6-pro', false],
    ['xiaomi-token-planning/mimo-v2.6-pro', false],
    ['xiaomi-token-plan-ams/', false],
    ['openrouter/xiaomi/mimo-v2.6-pro', false],
    ['aio-mimo-profile/mimo-v2.6-pro', false],
    ['opencode/big-pickle', false],
    ['auto', false], [undefined, false], [null, false],
  ] as const)('classifies only logical MiMo account requests: %s', (model, expected) => {
    expect(isLogicalMiMoModel(model)).toBe(expected);
  });

  it('labels the providers for account copy', () => {
    expect(pooledProviderLabel('claude')).toBe('Claude');
    expect(pooledProviderLabel('codex')).toBe('Codex');
    expect(pooledProviderLabel('opencode')).toBe('MiMo');
  });
});
