import { describe, expect, it } from 'vitest';
import { buildLoopCheckpoint, LOOP_CHECKPOINT_HISTORY_TAIL } from './loop-checkpoint';
import { defaultLoopConfig, type LoopIteration, type LoopState } from '../../shared/types/loop.types';

function state(): LoopState {
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    config: defaultLoopConfig('/repo', 'goal'),
    status: 'running',
    startedAt: 100,
    endedAt: null,
    totalIterations: 0,
    totalTokens: 0,
    totalCostCents: 0,
    currentStage: 'PLAN',
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

function iteration(seq: number): LoopIteration {
  return {
    id: `iter-${seq}`,
    loopRunId: 'loop-1',
    seq,
    stage: 'PLAN',
    startedAt: seq,
    endedAt: seq + 1,
    childInstanceId: null,
    tokens: 1,
    costCents: 0,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    workHash: `hash-${seq}`,
    outputSimilarityToPrev: null,
    outputExcerpt: '',
    outputFull: '',
    progressVerdict: 'OK',
    progressSignals: [],
    completionSignalsFired: [],
    verifyStatus: 'not-run',
    verifyOutputExcerpt: '',
  };
}

describe('buildLoopCheckpoint', () => {
  it('keeps only a bounded history tail in checkpoints', () => {
    const history = Array.from({ length: LOOP_CHECKPOINT_HISTORY_TAIL + 3 }, (_, index) => iteration(index));
    const checkpoint = buildLoopCheckpoint({ state: state(), history, now: 500 });
    expect(checkpoint.historyTail).toHaveLength(LOOP_CHECKPOINT_HISTORY_TAIL);
    expect(checkpoint.historyTail[0]?.seq).toBe(3);
    expect(checkpoint.updatedAt).toBe(500);
  });

  it('WS3: persists the ledgerConvergence tracker with the state', () => {
    const withTracker: LoopState = {
      ...state(),
      ledgerConvergence: {
        version: 1,
        knownTaskStates: { 'ws4.a': 'done', 'ws4.b': 'todo' },
        plannedLeafIds: ['ws4.a', 'ws4.b'],
        discoveredLeafIds: ['ws5.c'],
        noMeaningfulTransitionIterations: 2,
        lastObjectiveEvidenceKey: 'verify-pass:r1',
      },
    };
    const checkpoint = buildLoopCheckpoint({ state: withTracker, history: [], now: 500 });
    expect(checkpoint.state.ledgerConvergence).toEqual(withTracker.ledgerConvergence);
  });

  it('WS3: a checkpoint without the tracker (old row) stays valid', () => {
    const checkpoint = buildLoopCheckpoint({ state: state(), history: [], now: 500 });
    expect(checkpoint.state.ledgerConvergence).toBeUndefined();
  });
});
