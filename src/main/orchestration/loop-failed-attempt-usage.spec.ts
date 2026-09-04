import { describe, expect, it } from 'vitest';
import type { LoopState } from '../../shared/types/loop.types';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import { chargeFailedAttemptUsage } from './loop-failed-attempt-usage';

function runningState(): LoopState {
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    config: defaultLoopConfig('/tmp/workspace', 'do work'),
    status: 'running',
    startedAt: Date.now(),
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
    recentEvidenceHashes: [],
    repeatedEvidenceCount: 0,
    terminalIntentHistory: [],
  };
}

describe('chargeFailedAttemptUsage', () => {
  it('folds an estimated partial usage snapshot into run totals exactly once', () => {
    const state = runningState();
    const error = Object.assign(new Error('prompt timed out'), {
      model: 'grok-4.6',
      partialUsage: {
        inputTokens: 1_200,
        outputTokens: 800,
        totalTokens: 2_000,
        isEstimated: true,
      },
    });

    const charge = chargeFailedAttemptUsage(state, error);

    expect(charge).not.toBeNull();
    expect(charge!.tokens).toBe(2_000);
    expect(charge!.estimated).toBe(true);
    expect(charge!.model).toBe('grok-4.6');
    expect(state.totalTokens).toBe(2_000);
    expect(state.tokensSinceLastTestImprovement).toBe(2_000);
    expect(state.totalCostCents).toBe(charge!.costCents);
    expect(charge!.costCents).toBeGreaterThan(0);
  });

  it('charges each failed attempt separately so retries accumulate', () => {
    const state = runningState();
    const attempt = () =>
      chargeFailedAttemptUsage(
        state,
        Object.assign(new Error('prompt timed out'), {
          partialUsage: { inputTokens: 500, outputTokens: 500, totalTokens: 1_000, isEstimated: true },
        }),
      );

    attempt();
    attempt();

    expect(state.totalTokens).toBe(2_000);
    expect(state.tokensSinceLastTestImprovement).toBe(2_000);
  });

  it('sums the usage breakdown when no explicit total is present', () => {
    const state = runningState();

    const charge = chargeFailedAttemptUsage(
      state,
      Object.assign(new Error('boom'), {
        partialUsage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, reasoningTokens: 2 },
      }),
    );

    expect(charge!.tokens).toBe(20);
    expect(charge!.estimated).toBe(false);
  });

  it('prices a totals-only snapshot instead of charging tokens at zero cost', () => {
    // `computeTokenCost` reads only the input/output/cache/reasoning breakdown,
    // so forwarding a totals-only usage would select the `computed` basis and
    // return $0.00 for a real token charge.
    const state = runningState();

    const charge = chargeFailedAttemptUsage(
      state,
      Object.assign(new Error('boom'), { partialUsage: { totalTokens: 50_000, isEstimated: true } }),
    );

    expect(charge!.tokens).toBe(50_000);
    expect(charge!.costCents).toBeGreaterThan(0);
    expect(state.totalCostCents).toBe(charge!.costCents);
  });

  it('invents nothing when the failed attempt produced no estimable material', () => {
    const state = runningState();

    expect(chargeFailedAttemptUsage(state, new Error('spawn failed'))).toBeNull();
    expect(chargeFailedAttemptUsage(state, undefined)).toBeNull();
    expect(
      chargeFailedAttemptUsage(state, Object.assign(new Error('boom'), { partialUsage: { inputTokens: 0 } })),
    ).toBeNull();
    expect(state.totalTokens).toBe(0);
    expect(state.totalCostCents).toBe(0);
    expect(state.tokensSinceLastTestImprovement).toBe(0);
  });
});
