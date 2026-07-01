import { afterEach, describe, expect, it } from 'vitest';
import { CompactionCoordinator } from '../context/compaction-coordinator';
import { defaultLoopConfig, type LoopIteration, type LoopState } from '../../shared/types/loop.types';
import { defaultLoopContextSurvivalManager } from './loop-context-survival';
import type { LoopChildResult } from './loop-coordinator';

function makeState(id = 'loop-survival-1'): LoopState {
  const config = defaultLoopConfig('/tmp/aio-loop-context-survival', 'finish the task');
  config.caps.maxTokens = 10_000;
  return {
    id,
    chatId: 'chat-1',
    config,
    status: 'running',
    startedAt: 0,
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
  };
}

function makeIteration(tokens: number, sufficientCompletion = false): LoopIteration {
  return {
    id: `iter-${tokens}`,
    loopRunId: 'loop-survival-1',
    seq: 0,
    stage: 'IMPLEMENT',
    startedAt: 0,
    endedAt: 1,
    childInstanceId: null,
    tokens,
    costCents: 0,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    workHash: `hash-${tokens}`,
    outputSimilarityToPrev: null,
    outputExcerpt: 'iteration output',
    outputFull: 'iteration output',
    progressVerdict: 'OK',
    progressSignals: [],
    completionSignalsFired: sufficientCompletion
      ? [{ id: 'declared-complete', sufficient: true, detail: 'agent declared done' }]
      : [],
    verifyStatus: 'not-run',
    verifyOutputExcerpt: '',
  };
}

function makeChildResult(tokens: number): LoopChildResult {
  return {
    childInstanceId: null,
    output: 'iteration output',
    tokens,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
  };
}

describe('defaultLoopContextSurvivalManager', () => {
  afterEach(() => {
    CompactionCoordinator._resetForTesting();
  });

  it('returns a soft-floor nudge when a sufficient completion signal fires under budget', async () => {
    const state = makeState();
    const iteration = makeIteration(5_000, true);

    const decision = await defaultLoopContextSurvivalManager.onIterationSealed({
      state,
      iteration,
      childResult: makeChildResult(iteration.tokens),
    });

    expect(decision).toMatchObject({
      action: 'none',
      forceContextReset: false,
    });
    expect(decision.reason).toContain('completion signal fired under token target');
    expect(decision.nudge).toContain('Keep working');
  });

  it('keeps budget tracking isolated by loop id', async () => {
    const loopA = makeState('loop-a');
    const loopB = makeState('loop-b');

    await defaultLoopContextSurvivalManager.onIterationSealed({
      state: loopA,
      iteration: makeIteration(400),
      childResult: makeChildResult(400),
    });
    await defaultLoopContextSurvivalManager.onIterationSealed({
      state: loopB,
      iteration: makeIteration(700),
      childResult: makeChildResult(700),
    });

    const coordinator = CompactionCoordinator.getInstance();
    expect(coordinator.getBudgetTracker(loopA.id).getStats().continuations).toBe(1);
    expect(coordinator.getBudgetTracker(loopB.id).getStats().continuations).toBe(1);
  });
});
