import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import {
  attemptInstanceFailover,
  buildParkFailoverOfferNotification,
  decideInstanceFailover,
  type AttemptInstanceFailoverDeps,
} from './instance-failover';

describe('buildParkFailoverOfferNotification', () => {
  const instance = {
    id: 'inst-1', displayName: 'Sess', provider: 'claude', failoverProviders: ['claude', 'codex'],
  } as never;
  const now = 1_700_000_000_000;

  it('offers when the park outlasts the threshold and fallbacks exist', () => {
    const offer = buildParkFailoverOfferNotification({
      instance, provider: 'claude', resumeAt: now + 31 * 60_000, offerAfterMinutes: 30, now,
    });
    expect(offer).toMatchObject({ kind: 'instance-failover-offer' });
    expect(offer!.body).toContain('codex');
  });

  it('stays silent for short parks, missing instances, or no fallbacks', () => {
    expect(buildParkFailoverOfferNotification({
      instance, provider: 'claude', resumeAt: now + 5 * 60_000, offerAfterMinutes: 30, now,
    })).toBeNull();
    expect(buildParkFailoverOfferNotification({
      instance: undefined, provider: 'claude', resumeAt: now + 60 * 60_000, offerAfterMinutes: 30, now,
    })).toBeNull();
    expect(buildParkFailoverOfferNotification({
      instance: { ...instance as object, failoverProviders: ['claude'] } as never,
      provider: 'claude', resumeAt: now + 60 * 60_000, offerAfterMinutes: 30, now,
    })).toBeNull();
  });
});

describe('decideInstanceFailover', () => {
  const base = {
    shouldFailover: true,
    reason: 'auth',
    failoverProviders: ['claude', 'codex'],
    currentProvider: 'claude',
    switchesSoFar: 0,
    maxSwitches: 1,
  };

  it('allows a switch on a failover category with candidates left', () => {
    const decision = decideInstanceFailover(base);
    expect(decision.action).toBe('try-switch');
    expect(decision).toMatchObject({ candidates: ['codex'] });
  });

  it('is off when no providers are configured', () => {
    expect(decideInstanceFailover({ ...base, failoverProviders: [] }).action).toBe('none');
    expect(decideInstanceFailover({ ...base, failoverProviders: undefined }).action).toBe('none');
  });

  it('never switches on a non-failover category (validation, etc.)', () => {
    expect(decideInstanceFailover({ ...base, shouldFailover: false, reason: 'validation' }).action).toBe('none');
  });

  it('respects the per-session switch budget', () => {
    expect(decideInstanceFailover({ ...base, switchesSoFar: 1, maxSwitches: 1 }).action).toBe('none');
    expect(decideInstanceFailover({ ...base, switchesSoFar: 1, maxSwitches: 2 }).action).toBe('try-switch');
  });

  it('excludes the current provider from candidates', () => {
    const decision = decideInstanceFailover({ ...base, failoverProviders: ['claude'] });
    expect(decision.action).toBe('none');
  });
});

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    displayName: 'Session',
    provider: 'claude',
    currentModel: 'sonnet',
    failoverProviders: ['claude', 'codex'],
    failoverSwitches: 0,
    ...overrides,
  } as unknown as Instance;
}

function makeDeps(overrides: Partial<AttemptInstanceFailoverDeps> = {}): AttemptInstanceFailoverDeps {
  return {
    classify: () => ({ axes: { shouldFailover: true }, reason: 'auth', message: 'auth failed' }),
    maxSwitches: 1,
    selectTarget: (request) => {
      for (const candidate of request.candidates) {
        const veto = request.veto?.(candidate) ?? null;
        if (veto === null) return { to: candidate, considered: [{ provider: candidate, vetoReason: null }] };
      }
      return { to: null, considered: request.candidates.map((p) => ({ provider: p, vetoReason: 'vetoed' })) };
    },
    isProviderParked: () => false,
    installedProviders: new Set(['claude', 'codex', 'gemini']),
    swapProvider: vi.fn().mockResolvedValue(true),
    notify: vi.fn(),
    emitActivity: vi.fn(),
    ...overrides,
  };
}

describe('attemptInstanceFailover', () => {
  it('swaps to the fallback provider, tags the instance, and notifies', async () => {
    const instance = makeInstance();
    const swapProvider = vi.fn().mockResolvedValue(true);
    const notify = vi.fn();
    const emitActivity = vi.fn();

    const outcome = await attemptInstanceFailover(instance, new Error('401'), makeDeps({ swapProvider, notify, emitActivity }));

    expect(outcome).toMatchObject({ switched: true, from: 'claude', to: 'codex' });
    expect(swapProvider).toHaveBeenCalledWith('inst-1', 'codex');
    expect(instance.failoverSwitches).toBe(1);
    expect(instance.failedOverFrom).toBe('claude');
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: expect.stringContaining('codex') }));
    expect(emitActivity).toHaveBeenCalled();
  });

  it('is inert when failover is off (no providers)', async () => {
    const instance = makeInstance({ failoverProviders: [] });
    const swapProvider = vi.fn();
    const outcome = await attemptInstanceFailover(instance, new Error('401'), makeDeps({ swapProvider }));
    expect(outcome.switched).toBe(false);
    expect(swapProvider).not.toHaveBeenCalled();
  });

  it('does not switch on a non-failover classification', async () => {
    const instance = makeInstance();
    const swapProvider = vi.fn();
    const outcome = await attemptInstanceFailover(
      instance,
      new Error('bad request'),
      makeDeps({
        swapProvider,
        classify: () => ({ axes: { shouldFailover: false }, reason: 'validation', message: 'bad' }),
      }),
    );
    expect(outcome.switched).toBe(false);
    expect(swapProvider).not.toHaveBeenCalled();
  });

  it('skips a parked fallback provider (WS2 ledger veto) and finds the next', async () => {
    const instance = makeInstance({ failoverProviders: ['claude', 'codex', 'gemini'] });
    const swapProvider = vi.fn().mockResolvedValue(true);
    const outcome = await attemptInstanceFailover(
      instance,
      new Error('401'),
      makeDeps({ swapProvider, isProviderParked: (p) => p === 'codex' }),
    );
    expect(outcome).toMatchObject({ switched: true, to: 'gemini' });
    expect(swapProvider).toHaveBeenCalledWith('inst-1', 'gemini');
  });

  it('skips a not-installed fallback provider', async () => {
    const instance = makeInstance({ failoverProviders: ['claude', 'codex'] });
    const outcome = await attemptInstanceFailover(
      instance,
      new Error('401'),
      makeDeps({ installedProviders: new Set(['claude']) }),
    );
    expect(outcome.switched).toBe(false);
  });

  it('reports no-switch when the swap closure returns false', async () => {
    const instance = makeInstance();
    const outcome = await attemptInstanceFailover(
      instance,
      new Error('401'),
      makeDeps({ swapProvider: vi.fn().mockResolvedValue(false) }),
    );
    expect(outcome.switched).toBe(false);
    expect(instance.failoverSwitches).toBe(0);
  });

  it('never throws — a swap that rejects becomes a no-switch outcome', async () => {
    const instance = makeInstance();
    const outcome = await attemptInstanceFailover(
      instance,
      new Error('401'),
      makeDeps({ swapProvider: vi.fn().mockRejectedValue(new Error('target CLI unavailable')) }),
    );
    expect(outcome.switched).toBe(false);
    expect(instance.failoverSwitches).toBe(0);
  });
});
