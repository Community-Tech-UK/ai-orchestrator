import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { LoopIterationPayload, LoopStatePayload } from '@contracts/schemas/loop';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import { LoopIpcService, type LoopActivityPayload } from '../../core/services/ipc/loop-ipc.service';
import { LoopStore } from '../../core/state/loop.store';
import { LoopControlComponent } from './loop-control.component';

describe('LoopControlComponent', () => {
  let fixture: ComponentFixture<LoopControlComponent>;
  let listeners: {
    stateChanged: Listener<{ loopRunId: string; state: LoopStatePayload }>[];
    activity: Listener<LoopActivityPayload>[];
  };
  let ipc: {
    start: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
    intervene: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    listRunsForChat: ReturnType<typeof vi.fn>;
    getIterations: ReturnType<typeof vi.fn>;
    onStateChanged: ReturnType<typeof vi.fn>;
    onIterationStarted: ReturnType<typeof vi.fn>;
    onActivity: ReturnType<typeof vi.fn>;
    onIterationComplete: ReturnType<typeof vi.fn>;
    onPausedNoProgress: ReturnType<typeof vi.fn>;
    onClaimedDoneButFailed: ReturnType<typeof vi.fn>;
    onTerminalIntentRecorded: ReturnType<typeof vi.fn>;
    onTerminalIntentRejected: ReturnType<typeof vi.fn>;
    onFreshEyesReviewStarted: ReturnType<typeof vi.fn>;
    onFreshEyesReviewPassed: ReturnType<typeof vi.fn>;
    onFreshEyesReviewFailed: ReturnType<typeof vi.fn>;
    onFreshEyesReviewBlocked: ReturnType<typeof vi.fn>;
    onCompleted: ReturnType<typeof vi.fn>;
    onFailed: ReturnType<typeof vi.fn>;
    onCapReached: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    TestBed.resetTestingModule();
    listeners = {
      stateChanged: [],
      activity: [],
    };
    ipc = {
      start: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      intervene: vi.fn(),
      cancel: vi.fn(),
      listRunsForChat: vi.fn().mockResolvedValue({ success: true, data: { runs: [] } }),
      getIterations: vi.fn().mockResolvedValue({
        success: true,
        data: { iterations: [loopIteration()] },
      }),
      onStateChanged: vi.fn((cb) => subscribe(listeners.stateChanged, cb)),
      onIterationStarted: vi.fn(() => noop),
      onActivity: vi.fn((cb) => subscribe(listeners.activity, cb)),
      onIterationComplete: vi.fn(() => noop),
      onPausedNoProgress: vi.fn(() => noop),
      onClaimedDoneButFailed: vi.fn(() => noop),
      onTerminalIntentRecorded: vi.fn(() => noop),
      onTerminalIntentRejected: vi.fn(() => noop),
      onFreshEyesReviewStarted: vi.fn(() => noop),
      onFreshEyesReviewPassed: vi.fn(() => noop),
      onFreshEyesReviewFailed: vi.fn(() => noop),
      onFreshEyesReviewBlocked: vi.fn(() => noop),
      onCompleted: vi.fn(() => noop),
      onFailed: vi.fn(() => noop),
      onCapReached: vi.fn(() => noop),
      onError: vi.fn(() => noop),
    };

    TestBed.overrideComponent(LoopControlComponent, {
      add: { schemas: [NO_ERRORS_SCHEMA] },
    });

    await TestBed.configureTestingModule({
      imports: [LoopControlComponent],
      providers: [
        LoopStore,
        { provide: LoopIpcService, useValue: ipc },
        { provide: CLIPBOARD_SERVICE, useValue: clipboardMock() },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(LoopControlComponent);
    (fixture.componentInstance as unknown as { chatId: () => string }).chatId = () => 'chat-1';
    fixture.detectChanges();
  });

  it('opens an inspectable trace with persisted iterations and full activity', async () => {
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: activeState(),
    }));
    listeners.activity.forEach((cb) => cb({
      loopRunId: 'loop-1',
      seq: 1,
      stage: 'IMPLEMENT',
      kind: 'assistant',
      message: 'Read state files to orient, then edited the target service and ran focused tests.',
      timestamp: 1778310002000,
    }));
    fixture.detectChanges();

    const inspect = fixture.nativeElement.querySelector('.ls-actions button[title="Show loop trace"]') as HTMLButtonElement;
    inspect.click();
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fixture.detectChanges();

    expect(ipc.getIterations).toHaveBeenCalledWith('loop-1');
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Loop trace');
    expect(text).toContain('iteration output that explains the child work');
    expect(text).toContain('Signals: progress A:WARN; completion completed-rename:insufficient; verify failed');
    expect(text).toContain('src/main/orchestration/loop-runner.ts (+12/-3)');
    expect(text).toContain('Read state files to orient, then edited the target service and ran focused tests.');
  });
});

const noop = (): void => undefined;

type Listener<T> = (data: T) => void;

function subscribe<T>(target: Listener<T>[], cb: Listener<T>): () => void {
  target.push(cb);
  return () => {
    const index = target.indexOf(cb);
    if (index >= 0) target.splice(index, 1);
  };
}

function clipboardMock() {
  const lastResult = signal(null);
  const ok = vi.fn().mockResolvedValue({ ok: true });
  return {
    lastResult: lastResult.asReadonly(),
    copyText: ok,
    copyJSON: ok,
    copyImage: ok,
    copyMessage: ok,
  };
}

function activeState(): LoopStatePayload {
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    status: 'running',
    currentStage: 'IMPLEMENT',
    totalIterations: 1,
    totalTokens: 2000,
    totalCostCents: 5,
    startedAt: 1778310000000,
    endedAt: null,
    pendingInterventions: [],
    completedFileRenameObserved: false,
    doneSentinelPresentAtStart: false,
    planChecklistFullyCheckedAtStart: false,
    uncompletedPlanFilesAtStart: [],
    tokensSinceLastTestImprovement: 0,
    highestTestPassCount: 0,
    iterationsOnCurrentStage: 1,
    recentWarnIterationSeqs: [],
    config: {
      initialPrompt: 'goal',
      iterationPrompt: 'continue',
      workspaceCwd: '/tmp/project',
      provider: 'claude',
      reviewStyle: 'single',
      contextStrategy: 'same-session',
      caps: {
        maxIterations: 50,
        maxWallTimeMs: 14_400_000,
        maxTokens: 1_000_000,
        maxCostCents: 50_000,
        maxToolCallsPerIteration: 200,
      },
      progressThresholds: {
        identicalHashWarnConsecutive: 2,
        identicalHashCriticalConsecutive: 3,
        identicalHashCriticalWindow: 3,
        similarityWarnMean: 0.92,
        similarityCriticalMean: 0.98,
        stageWarnIterations: { PLAN: 2, REVIEW: 2, IMPLEMENT: 4 },
        stageCriticalIterations: { PLAN: 4, REVIEW: 4, IMPLEMENT: 8 },
        errorRepeatWarnInWindow: 2,
        errorRepeatCriticalInWindow: 3,
        tokensWithoutProgressWarn: 10_000,
        tokensWithoutProgressCritical: 20_000,
        pauseOnTokenBurn: false,
        toolRepeatWarnPerIteration: 20,
        toolRepeatCriticalPerIteration: 40,
        testStagnationWarnIterations: 3,
        testStagnationCriticalIterations: 6,
        churnRatioWarn: 0.8,
        churnRatioCritical: 0.95,
        warnEscalationWindow: 3,
        warnEscalationCount: 2,
      },
      completion: {
        completedFilenamePattern: '_completed',
        donePromiseRegex: '',
        doneSentinelFile: '',
        verifyCommand: '',
        verifyTimeoutMs: 120_000,
        runVerifyTwice: false,
        requireCompletedFileRename: false,
      },
      allowDestructiveOps: false,
      initialStage: 'IMPLEMENT',
      iterationTimeoutMs: 3_600_000,
      streamIdleTimeoutMs: 300_000,
    },
  };
}

function loopIteration(): LoopIterationPayload {
  return {
    id: 'iter-loop-1-1',
    loopRunId: 'loop-1',
    seq: 1,
    stage: 'IMPLEMENT',
    startedAt: 1778310000000,
    endedAt: 1778310060000,
    childInstanceId: 'child-1',
    tokens: 2000,
    costCents: 5,
    filesChanged: [
      {
        path: 'src/main/orchestration/loop-runner.ts',
        additions: 12,
        deletions: 3,
        contentHash: 'abc',
      },
    ],
    toolCalls: [],
    errors: [],
    testPassCount: 12,
    testFailCount: 0,
    workHash: 'hash',
    outputSimilarityToPrev: null,
    outputExcerpt: 'iteration output that explains the child work',
    progressVerdict: 'WARN',
    progressSignals: [
      { id: 'A', verdict: 'WARN', message: 'same work hash repeated' },
    ],
    completionSignalsFired: [
      { id: 'completed-rename', sufficient: false, detail: 'missing rename' },
    ],
    verifyStatus: 'failed',
    verifyOutputExcerpt: 'verify failed because rename was not observed',
  };
}
