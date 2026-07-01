import { describe, expect, it } from 'vitest';
import {
  detectAnnounceThenHalt,
  maybeQueueAnnounceThenHaltContinuation,
} from './loop-announce-then-halt';
import { defaultLoopConfig, type LoopIteration, type LoopState } from '../../shared/types/loop.types';

function makeIteration(overrides: Partial<LoopIteration> = {}): LoopIteration {
  return {
    id: 'iter-1',
    loopRunId: 'loop-1',
    seq: 0,
    stage: 'IMPLEMENT',
    startedAt: 0,
    endedAt: 1,
    childInstanceId: null,
    tokens: 1,
    costCents: 0,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    workHash: 'hash',
    outputSimilarityToPrev: null,
    outputExcerpt: '',
    outputFull: '',
    progressVerdict: 'OK',
    progressSignals: [],
    completionSignalsFired: [],
    verifyStatus: 'not-run',
    verifyOutputExcerpt: '',
    ...overrides,
  };
}

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  const config = defaultLoopConfig('/tmp/ws', 'finish the task');
  return {
    id: 'loop-1',
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
    ...overrides,
  };
}

describe('detectAnnounceThenHalt', () => {
  it('detects first-person future tool/action narration', () => {
    expect(detectAnnounceThenHalt("I'll now run the focused test suite.")?.excerpt)
      .toBe("I'll now run the focused test suite.");
    expect(detectAnnounceThenHalt('Next I will edit the coordinator wiring.')).toBeTruthy();
  });

  it('ignores non-action summaries and user-facing next-step lists', () => {
    expect(detectAnnounceThenHalt('Implemented the parser and ran tests.')).toBeNull();
    expect(detectAnnounceThenHalt('Next steps for the operator: deploy this build.')).toBeNull();
  });
});

describe('maybeQueueAnnounceThenHaltContinuation', () => {
  it('queues a bounded continuation intervention for a no-tool IMPLEMENT turn that only announces work', () => {
    const state = makeState();
    const iteration = makeIteration({
      outputExcerpt: "I'll now run npm test and fix any failures.",
      outputFull: "I'll now run npm test and fix any failures.",
    });

    expect(maybeQueueAnnounceThenHaltContinuation(state, iteration)).toBe(true);

    expect(state.announceThenHaltNudgeCount).toBe(1);
    expect(state.pendingInterventions).toHaveLength(1);
    expect(state.pendingInterventions[0]).toMatchObject({
      kind: 'queue',
      source: 'announce-then-halt',
    });
    expect(state.pendingInterventions[0].message).toContain('Continue now');
    expect(state.pendingInterventions[0].message).toContain('run npm test');
  });

  it('does not queue after tools or files changed, outside IMPLEMENT, or after two nudges', () => {
    expect(maybeQueueAnnounceThenHaltContinuation(
      makeState(),
      makeIteration({
        outputExcerpt: "I'll now run tests.",
        toolCalls: [{ toolName: 'Bash', argsHash: 'h', success: true, durationMs: 1 }],
      }),
    )).toBe(false);

    expect(maybeQueueAnnounceThenHaltContinuation(
      makeState(),
      makeIteration({
        stage: 'PLAN',
        outputExcerpt: "I'll now draft the plan.",
      }),
    )).toBe(false);

    const capped = makeState({ announceThenHaltNudgeCount: 2 });
    expect(maybeQueueAnnounceThenHaltContinuation(
      capped,
      makeIteration({ outputExcerpt: "I'll now run tests." }),
    )).toBe(false);
    expect(capped.pendingInterventions).toEqual([]);
  });
});
