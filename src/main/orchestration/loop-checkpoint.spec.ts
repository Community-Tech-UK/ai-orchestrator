import { describe, expect, it } from 'vitest';
import { buildLoopCheckpoint, buildRunCheckpoint, checkpointHistory, LOOP_CHECKPOINT_HISTORY_TAIL } from './loop-checkpoint';
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
  it('keeps the stuck detector window rather than excess history', () => {
    const checkpoint = buildLoopCheckpoint({ state: state(), history: Array.from({ length: 30 }, (_, seq) => iteration(seq)) });
    expect(checkpoint.historyTail).toHaveLength(5);
    expect(checkpoint.historyTail[0].seq).toBe(25);
  });
  it('keeps five detector rounds, replaces the latest sealed round and snapshots completion hints', () => {
    const history = Array.from({ length: 8 }, (_, index) => iteration(index));
    const last = { ...iteration(7), outputExcerpt: 'sealed' };
    expect(checkpointHistory(history, last).map(row => row.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const checkpoint = buildRunCheckpoint({ getIterations: () => history, getCheckpointContext: () => ({ convergenceNote: 'ledger stall', planRegenerationCount: 2, pendingContextReset: true }) }, state(), last);
    expect(checkpoint.historyTail.at(-1)?.outputExcerpt).toBe('sealed');
    expect(checkpoint).toMatchObject({ convergenceNote: 'ledger stall', planRegenerationCount: 2, pendingContextReset: true });
  });
  it('follows a raised identicalHashCriticalWindow', () => {
    const run = state();
    run.config.progressThresholds.identicalHashCriticalWindow = 12;
    expect(buildLoopCheckpoint({ state: run, history: Array.from({ length: 30 }, (_, seq) => iteration(seq)) }).historyTail).toHaveLength(12);
  });
  it('falls back to lastIteration', () => {
    const run = state();
    run.lastIteration = iteration(3);
    expect(buildLoopCheckpoint({ state: run, history: [] }).historyTail).toEqual([run.lastIteration]);
  });
  it('keeps only a bounded history tail in checkpoints', () => {
    const history = Array.from({ length: LOOP_CHECKPOINT_HISTORY_TAIL + 3 }, (_, index) => iteration(index));
    const run = state();
    run.config.progressThresholds.identicalHashCriticalWindow = 30;
    const checkpoint = buildLoopCheckpoint({ state: run, history, now: 500 });
    expect(checkpoint.historyTail).toHaveLength(LOOP_CHECKPOINT_HISTORY_TAIL);
    expect(checkpoint.historyTail[0]?.seq).toBe(3);
    expect(checkpoint.updatedAt).toBe(500);
    const windowed = buildLoopCheckpoint({ state: state(), history, now: 500 });
    expect(windowed.historyTail).toHaveLength(5);
    expect(windowed.historyTail[0]?.seq).toBe(LOOP_CHECKPOINT_HISTORY_TAIL - 2);
    expect(windowed.updatedAt).toBe(500);
  });

  it('expands the detector window and caps it at twenty-five rounds', () => {
    const current = state();
    const history = Array.from({ length: 30 }, (_, index) => iteration(index));
    current.config.progressThresholds.identicalHashCriticalWindow = 12;
    expect(buildLoopCheckpoint({ state: current, history }).historyTail).toHaveLength(12);
    current.config.progressThresholds.identicalHashCriticalWindow = 40;
    expect(buildLoopCheckpoint({ state: current, history }).historyTail).toHaveLength(25);
    const fallback = buildRunCheckpoint({ getIterations: () => [], getCheckpointContext: () => ({ convergenceNote: null, planRegenerationCount: 0, pendingContextReset: false }) }, current, iteration(29));
    expect(fallback.historyTail.map(row => row.seq)).toEqual([29]);
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
