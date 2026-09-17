import { beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import { _resetRecoveryRecipesForTesting, type RecoveryAttemptRecord } from '../core/loop-recovery-recipes';
import { routeClassifiedLoopInvocationFailure } from './loop-invocation-error-routing';
import { LoopProviderLimitHandler } from './loop-provider-limit-handler';

function makeLoopState(overrides: Partial<LoopState> = {}): LoopState {
  const config = overrides.config ?? defaultLoopConfig('/tmp/project', 'ship it');
  return {
    id: 'loop-route-1',
    chatId: 'chat-1',
    config,
    status: 'running',
    startedAt: 1_700_000_000_000,
    endedAt: null,
    totalIterations: 0,
    totalTokens: 0,
    totalCostCents: 0,
    currentStage: 'IMPLEMENT',
    pendingInterventions: [],
    completedFileRenameObserved: false,
    doneSentinelPresentAtStart: false,
    planChecklistFullyCheckedAtStart: false,
    uncompletedPlanFilesAtStart: [],
    manualReviewOnly: false,
    tokensSinceLastTestImprovement: 0,
    highestTestPassCount: 0,
    iterationsOnCurrentStage: 0,
    recentWarnIterationSeqs: [],
    completionAttempts: 0,
    loopTasksLedgerResolvedAtStart: false,
    ...overrides,
  } as LoopState;
}

function noop(): void {
  /* intentional no-op stub for LoopProviderLimitHandler deps */
}

function makeProviderLimitHandler(
  tryProviderFailover?: (state: LoopState, reason: string) => boolean,
): LoopProviderLimitHandler {
  return new LoopProviderLimitHandler({
    emit: noop,
    cloneStateForBroadcast: (state) => state,
    setConvergenceNote: noop,
    terminate: noop,
    resumeLoop: () => false,
    tryProviderFailover,
  });
}

function baseParams(state: LoopState, error: unknown, overrides: Partial<Parameters<typeof routeClassifiedLoopInvocationFailure>[0]> = {}) {
  const events: { eventName: string; payload: unknown }[] = [];
  const attempts: RecoveryAttemptRecord[] = [];
  return {
    params: {
      state,
      error,
      seq: 1,
      stage: 'IMPLEMENT' as const,
      contextOverflowRecoveryAttempted: false,
      providerLimitHandler: makeProviderLimitHandler(),
      emit: (eventName: string, payload: unknown) => events.push({ eventName, payload }),
      onRecoveryAttempt: (record: RecoveryAttemptRecord) => attempts.push(record),
      ...overrides,
    },
    events,
    attempts,
  };
}

describe('routeClassifiedLoopInvocationFailure — recovery recipe wiring (C3)', () => {
  beforeEach(() => {
    _resetRecoveryRecipesForTesting();
  });

  it('runs a catalogued recipe once (route stays "none", the coordinator retries) then escalates to do-not-retry on the next occurrence', () => {
    const state = makeLoopState();
    const error = new Error('provider adapter failed to respond');

    const { params: p1, attempts: a1 } = baseParams(state, error, { seq: 1 });
    const route1 = routeClassifiedLoopInvocationFailure(p1);
    expect(route1).toBe('none');
    expect(a1).toHaveLength(1);
    expect(a1[0]!.outcome).toBe('attempted');

    const { params: p2, attempts: a2, events: e2 } = baseParams(state, error, { seq: 2 });
    const route2 = routeClassifiedLoopInvocationFailure(p2);
    expect(route2).toBe('do-not-retry');
    expect(a2).toHaveLength(1);
    expect(a2[0]!.outcome).toBe('escalated');
    expect(e2.some(e => e.eventName === 'loop:activity')).toBe(true);
  });

  it('never auto-runs a destructive step, even when allowDestructiveOps is true', () => {
    const state = makeLoopState({
      config: { ...defaultLoopConfig('/tmp/project', 'ship it'), allowDestructiveOps: true },
    });
    const error = new Error('stale worktree detected, needs rebase');

    const { params, attempts } = baseParams(state, error, { seq: 1 });
    const route = routeClassifiedLoopInvocationFailure(params);

    // stale_worktree is not retryable, so the underlying classification would
    // already force do-not-retry — the point under test is that no destructive
    // step is ever surfaced as auto-runnable.
    expect(route).toBe('do-not-retry');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.proposedDestructiveSteps.length).toBeGreaterThan(0);
    for (const step of attempts[0]!.proposedDestructiveSteps) {
      expect(step.class).toBe('destructive');
    }
  });

  it('does not propose destructive steps when allowDestructiveOps is false (default)', () => {
    const state = makeLoopState();
    const error = new Error('stale worktree detected, needs rebase');
    const { params, attempts } = baseParams(state, error, { seq: 1 });
    routeClassifiedLoopInvocationFailure(params);
    expect(attempts[0]!.proposedDestructiveSteps).toEqual([]);
  });

  it('leaves classifications with no catalogued recipe on the existing behavior (auth -> do-not-retry, no recipe)', () => {
    const state = makeLoopState();
    const error = Object.assign(new Error('unauthorized: invalid api key'), { status: 401 });
    const { params, attempts } = baseParams(state, error, { seq: 1 });
    const route = routeClassifiedLoopInvocationFailure(params);
    expect(route).toBe('do-not-retry');
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.outcome).toBe('no-recipe');
  });

  it('preserves the existing rate_limit park behavior untouched by the recipe layer', () => {
    const state = makeLoopState();
    const error = Object.assign(new Error('rate limit exceeded'), {
      status: 429,
      headers: { 'retry-after': '5' },
    });
    const { params, attempts } = baseParams(state, error, { seq: 1 });
    const route = routeClassifiedLoopInvocationFailure(params);
    expect(route).toBe('parked');
    // rate_limit has no catalogued recipe today.
    expect(attempts[0]!.outcome).toBe('no-recipe');
  });

  it('reports a switched account for a plan limit carrying only structured quota diagnostics', () => {
    const state = makeLoopState({ config: { ...defaultLoopConfig('/tmp/project', 'ship it'), provider: 'codex' } });
    const handler = makeProviderLimitHandler();
    const trySwitch = vi.fn(() => true);
    handler.setLoopAccountFailover({ currentProfileId: () => 'pro-a', trySwitch });
    // Wording that no provider-notice pattern recognises: only `quota` says it is a plan limit.
    const error = Object.assign(new Error('turn failed'), { status: 429, headers: { 'retry-after': '5' }, quota: { exhausted: true } });
    const { params } = baseParams(state, error, { seq: 1, providerLimitHandler: handler });
    expect(routeClassifiedLoopInvocationFailure(params)).toBe('switched-account');
    expect(trySwitch).toHaveBeenCalledTimes(1);
    handler.clearResumeTimer(state.id);
  });

  it('reports a switched provider for a plan limit when opt-in provider failover moves the run', () => {
    const state = makeLoopState({ config: { ...defaultLoopConfig('/tmp/project', 'ship it'), provider: 'claude' } });
    const tryProviderFailover = vi.fn(() => true);
    const handler = makeProviderLimitHandler(tryProviderFailover);
    handler.setLoopAccountFailover({ currentProfileId: () => null, trySwitch: vi.fn(() => false) });
    const error = Object.assign(new Error('turn failed'), { status: 429, headers: { 'retry-after': '5' }, quota: { exhausted: true } });
    const { params } = baseParams(state, error, { seq: 1, providerLimitHandler: handler });
    expect(routeClassifiedLoopInvocationFailure(params)).toBe('switched-provider');
    expect(tryProviderFailover).toHaveBeenCalledTimes(1);
    handler.clearResumeTimer(state.id);
  });

  it('never rotates accounts for a burst throttle with no plan-limit signal, even with an active pool', () => {
    const state = makeLoopState({ config: { ...defaultLoopConfig('/tmp/project', 'ship it'), provider: 'claude' } });
    const handler = makeProviderLimitHandler();
    const trySwitch = vi.fn(() => true);
    handler.setLoopAccountFailover({ currentProfileId: () => 'max-a', trySwitch });
    const error = Object.assign(new Error('rate limit exceeded'), { status: 429, headers: { 'retry-after': '5' } });
    const { params } = baseParams(state, error, { seq: 1, providerLimitHandler: handler });
    expect(routeClassifiedLoopInvocationFailure(params)).toBe('parked');
    expect(trySwitch).not.toHaveBeenCalled();
    handler.clearResumeTimer(state.id);
  });

  it('preserves the existing context_overflow single-retry-then-do-not-retry gate (recipe only annotates it)', () => {
    const state = makeLoopState();
    const error = Object.assign(new Error('request too large'), {
      status: 400,
      body: "This model's maximum context length is 200000 tokens. However, your messages resulted in 220001 tokens.",
    });

    const { params: p1 } = baseParams(state, error, { seq: 1, contextOverflowRecoveryAttempted: false });
    expect(routeClassifiedLoopInvocationFailure(p1)).toBe('retry-fresh');

    const { params: p2 } = baseParams(state, error, { seq: 2, contextOverflowRecoveryAttempted: true });
    expect(routeClassifiedLoopInvocationFailure(p2)).toBe('do-not-retry');
  });

  it('emits an audit record via onRecoveryAttempt for every call', () => {
    const state = makeLoopState();
    const error = new Error('tool execution failed: exit code 1');
    const { params, attempts } = baseParams(state, error, { seq: 1 });
    routeClassifiedLoopInvocationFailure(params);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.loopRunId).toBe(state.id);
    expect(attempts[0]!.reason).toBe('tool_runtime');
  });
});
