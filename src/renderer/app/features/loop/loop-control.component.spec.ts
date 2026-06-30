import {
  NO_ERRORS_SCHEMA,
  signal,
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import type { LoopIterationPayload, LoopStatePayload } from '@contracts/schemas/loop';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import { LoopIpcService, type LoopActivityPayload } from '../../core/services/ipc/loop-ipc.service';
import { LoopStore } from '../../core/state/loop.store';
import { LoopControlComponent } from './loop-control.component';

// Angular verifies standalone component resources before TestBed applies the
// metadata override below, so resolve the extracted stylesheet for JIT tests.
await resolveComponentResources(() => Promise.resolve(''));

describe('LoopControlComponent', () => {
  let fixture: ComponentFixture<LoopControlComponent>;
  let listeners: {
    stateChanged: Listener<{ loopRunId: string; state: LoopStatePayload }>[];
    activity: Listener<LoopActivityPayload>[];
    pausedNoProgress: Listener<{ loopRunId: string; signal: { id: string; message: string; verdict: string } }>[];
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
    onOutstandingChanged: ReturnType<typeof vi.fn>;
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
    onCompletedNeedsReview: ReturnType<typeof vi.fn>;
    onFailed: ReturnType<typeof vi.fn>;
    onCapReached: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
    acceptCompletion: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    TestBed.resetTestingModule();
    listeners = {
      stateChanged: [],
      activity: [],
      pausedNoProgress: [],
    };
    ipc = {
      start: vi.fn(),
      pause: vi.fn().mockResolvedValue({ success: true, data: { ok: true, state: { ...activeState(), status: 'paused' } } }),
      resume: vi.fn().mockResolvedValue({ success: true, data: { ok: true, state: { ...activeState(), status: 'running' } } }),
      intervene: vi.fn().mockResolvedValue({ success: true, data: { ok: true } }),
      cancel: vi.fn().mockResolvedValue({ success: true, data: { ok: true } }),
      listRunsForChat: vi.fn().mockResolvedValue({ success: true, data: { runs: [] } }),
      getIterations: vi.fn().mockResolvedValue({
        success: true,
        data: { iterations: [loopIteration()] },
      }),
      onStateChanged: vi.fn((cb) => subscribe(listeners.stateChanged, cb)),
      onIterationStarted: vi.fn(() => noop),
      onOutstandingChanged: vi.fn(() => noop),
      onActivity: vi.fn((cb) => subscribe(listeners.activity, cb)),
      onIterationComplete: vi.fn(() => noop),
      onPausedNoProgress: vi.fn((cb) => subscribe(listeners.pausedNoProgress, cb)),
      onClaimedDoneButFailed: vi.fn(() => noop),
      onTerminalIntentRecorded: vi.fn(() => noop),
      onTerminalIntentRejected: vi.fn(() => noop),
      onFreshEyesReviewStarted: vi.fn(() => noop),
      onFreshEyesReviewPassed: vi.fn(() => noop),
      onFreshEyesReviewFailed: vi.fn(() => noop),
      onFreshEyesReviewBlocked: vi.fn(() => noop),
      onCompleted: vi.fn(() => noop),
      onCompletedNeedsReview: vi.fn(() => noop),
      onFailed: vi.fn(() => noop),
      onCapReached: vi.fn(() => noop),
      onError: vi.fn(() => noop),
      acceptCompletion: vi.fn().mockResolvedValue({ success: true, data: { ok: true } }),
    };

    TestBed.overrideComponent(LoopControlComponent, {
      set: {
        styles: [],
        styleUrl: undefined,
        styleUrls: [],
        schemas: [NO_ERRORS_SCHEMA],
      },
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

  it('routes the status-strip pause button to the active loop', async () => {
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: activeState(),
    }));
    fixture.detectChanges();

    const pause = fixture.nativeElement.querySelector('.ls-actions button[title="Pause loop"]') as HTMLButtonElement;
    pause.click();
    await settle(fixture);

    expect(ipc.pause).toHaveBeenCalledWith('loop-1');
    expect(fixture.nativeElement.textContent).toContain('Resume');
  });

  it('shows resume controls for a restored provider-limit checkpoint', async () => {
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: { ...activeState(), status: 'provider-limit', endedAt: null },
    }));
    fixture.detectChanges();

    const resume = fixture.nativeElement.querySelector('.ls-actions button[title="Resume loop"]') as HTMLButtonElement | null;
    expect(fixture.nativeElement.textContent).toContain('PROVIDER LIMIT');
    expect(resume).toBeTruthy();

    resume!.click();
    await settle(fixture);

    expect(ipc.resume).toHaveBeenCalledWith('loop-1');
  });

  it('shows a read-only run-config summary while the loop is active (LF-8)', () => {
    listeners.stateChanged.forEach((cb) => cb({ loopRunId: 'loop-1', state: activeState() }));
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Run configuration');
    expect(text).toContain('Provider');
    expect(text).toContain('claude');           // provider value
    expect(text).toContain('same-session');     // context strategy value
    expect(text).toContain('1.00M tok');        // configured maxTokens is an active cap
  });

  it('shows compact preflight and final-audit status without exposing absolute artifact paths', () => {
    const state = activeState();
    state.config.audit = {
      finalAuditMode: 'gate',
      preflightMode: 'record',
      planPacketMode: 'prompted',
      cleanlinessScan: true,
    };
    state.preflight = {
      status: 'failed',
      ranAt: 1778310001000,
      commands: [],
    };
    state.latestFinalAudit = {
      status: 'needs-review',
      ranAt: 1778310002000,
      coverage: {
        criteriaTotal: 2,
        criteriaVerified: 1,
        criteriaUnverified: 1,
        verifyCommandRan: true,
        repoComparisonRan: true,
        cleanlinessScanRan: true,
      },
      findings: [],
      changedFiles: ['src/a.ts'],
      reportPath: '/tmp/project/.aio-loop-state/loop-1/AUDIT.md',
    };

    listeners.stateChanged.forEach((cb) => cb({ loopRunId: 'loop-1', state }));
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Preflight failed');
    expect(text).toContain('Audit gate needs review');
    expect(text).toContain('AUDIT.md');
    expect(text).not.toContain('/tmp/project/.aio-loop-state/loop-1/AUDIT.md');
  });

  it('routes visible no-progress banner controls to the loop id', async () => {
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: { ...activeState(), status: 'paused' },
    }));
    listeners.pausedNoProgress.forEach((cb) => cb({
      loopRunId: 'loop-1',
      signal: { id: 'A', message: 'Identical work hash repeated', verdict: 'CRITICAL' },
    }));
    fixture.detectChanges();

    // The banner "Inject hint" opens the in-app modal (window.prompt is a
    // no-op in the sandboxed renderer). The modal element is wired in, and
    // submitting it routes the hint to the active loop id.
    const ci = fixture.componentInstance as unknown as {
      hintModalOpen: () => boolean;
      onHintSubmitted: (message: string) => Promise<void>;
    };
    bannerButton('Inject hint').click();
    await settle(fixture);

    expect(ci.hintModalOpen()).toBe(true);
    expect(fixture.nativeElement.querySelector('app-prompt-modal')).toBeTruthy();

    await ci.onHintSubmitted('try a different verification path');
    await settle(fixture);

    expect(ci.hintModalOpen()).toBe(false);
    expect(ipc.intervene).toHaveBeenCalledWith('loop-1', 'try a different verification path');

    bannerButton('Resume anyway').click();
    await settle(fixture);

    expect(ipc.resume).toHaveBeenCalledWith('loop-1');
    expect(fixture.nativeElement.textContent).not.toContain('Loop paused — no progress');
  });

  it('stops a paused no-progress loop from the banner', async () => {
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: { ...activeState(), status: 'paused' },
    }));
    listeners.pausedNoProgress.forEach((cb) => cb({
      loopRunId: 'loop-1',
      signal: { id: 'A', message: 'Identical work hash repeated', verdict: 'CRITICAL' },
    }));
    fixture.detectChanges();

    bannerButton('Stop').click();
    await settle(fixture);

    expect(ipc.cancel).toHaveBeenCalledWith('loop-1');
    expect(fixture.nativeElement.textContent).not.toContain('Loop ·');
    expect(fixture.nativeElement.textContent).not.toContain('Loop paused — no progress');
  });

  function bannerButton(label: string): HTMLButtonElement {
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('.loop-banner-actions button'),
    ) as HTMLButtonElement[];
    const button = buttons.find((candidate) => candidate.textContent?.trim() === label);
    if (!button) throw new Error(`Missing banner button: ${label}`);
    return button;
  }
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

async function settle(fixture: ComponentFixture<LoopControlComponent>): Promise<void> {
  await fixture.whenStable();
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.detectChanges();
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
    outputFull: 'iteration output that explains the child work',
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
