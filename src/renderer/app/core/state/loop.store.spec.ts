import { TestBed } from '@angular/core/testing';
import type { LoopIterationPayload, LoopStatePayload } from '@contracts/schemas/loop';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LoopIpcService, type LoopActivityPayload, type LoopStartConfigInput } from '../services/ipc/loop-ipc.service';
import { LoopStore } from './loop.store';

describe('LoopStore', () => {
  let listeners: {
    stateChanged: Listener<{ loopRunId: string; state: LoopStatePayload }>[];
    iterationStarted: Listener<{ loopRunId: string; seq: number; stage: string }>[];
    activity: Listener<LoopActivityPayload>[];
    iterationComplete: Listener<{ loopRunId: string; seq: number; verdict: string }>[];
    pausedNoProgress: Listener<{ loopRunId: string; signal: { id: string; message: string; verdict: string } }>[];
    claimedDoneButFailed: Listener<{ loopRunId: string; signal: string; failure: string }>[];
    completed: Listener<{ loopRunId: string; signal: string; verifyOutput: string }>[];
    capReached: Listener<{ loopRunId: string; cap: string }>[];
    error: Listener<{ loopRunId: string; error: string }>[];
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
    onCompleted: ReturnType<typeof vi.fn>;
    onCapReached: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
  };
  let store: LoopStore;

  beforeEach(() => {
    TestBed.resetTestingModule();
    listeners = {
      stateChanged: [],
      iterationStarted: [],
      activity: [],
      iterationComplete: [],
      pausedNoProgress: [],
      claimedDoneButFailed: [],
      completed: [],
      capReached: [],
      error: [],
    };
    ipc = {
      start: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      intervene: vi.fn(),
      cancel: vi.fn(),
      listRunsForChat: vi.fn(),
      getIterations: vi.fn(),
      onStateChanged: vi.fn((cb) => subscribe(listeners.stateChanged, cb)),
      onIterationStarted: vi.fn((cb) => subscribe(listeners.iterationStarted, cb)),
      onActivity: vi.fn((cb) => subscribe(listeners.activity, cb)),
      onIterationComplete: vi.fn((cb) => subscribe(listeners.iterationComplete, cb)),
      onPausedNoProgress: vi.fn((cb) => subscribe(listeners.pausedNoProgress, cb)),
      onClaimedDoneButFailed: vi.fn((cb) => subscribe(listeners.claimedDoneButFailed, cb)),
      onCompleted: vi.fn((cb) => subscribe(listeners.completed, cb)),
      onCapReached: vi.fn((cb) => subscribe(listeners.capReached, cb)),
      onError: vi.fn((cb) => subscribe(listeners.error, cb)),
    };

    TestBed.configureTestingModule({
      providers: [
        LoopStore,
        { provide: LoopIpcService, useValue: ipc },
      ],
    });

    store = TestBed.inject(LoopStore);
  });

  it('returns a loop start failure instead of throwing when IPC rejects', async () => {
    ipc.start
      .mockRejectedValueOnce(new Error('preload loopStart failed'))
      .mockResolvedValueOnce({
        success: false,
        error: { message: 'backend rejected start' },
      });

    await expect(store.start('chat-1', validConfig())).resolves.toEqual({
      ok: false,
      error: 'preload loopStart failed',
    });

    await expect(store.start('chat-1', validConfig())).resolves.toEqual({
      ok: false,
      error: 'backend rejected start',
    });
    expect(ipc.start).toHaveBeenCalledTimes(2);
  });

  it('surfaces running iteration and child activity for the active chat', () => {
    store.ensureWired();
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: activeState(),
    }));

    listeners.iterationStarted.forEach((cb) => cb({
      loopRunId: 'loop-1',
      seq: 1,
      stage: 'IMPLEMENT',
    }));
    listeners.activity.forEach((cb) => cb({
      loopRunId: 'loop-1',
      seq: 1,
      stage: 'IMPLEMENT',
      kind: 'tool_use',
      message: 'Read src/main/orchestration/default-invokers.ts',
      timestamp: 1778310000000,
    }));

    expect(store.runningIterationForChat('chat-1')()).toMatchObject({
      loopRunId: 'loop-1',
      seq: 1,
      stage: 'IMPLEMENT',
    });
    expect(store.activityForChat('chat-1')()).toEqual([{
      loopRunId: 'loop-1',
      seq: 1,
      stage: 'IMPLEMENT',
      kind: 'tool_use',
      message: 'Read src/main/orchestration/default-invokers.ts',
      timestamp: 1778310000000,
    }]);
    expect(store.activityForLoop('loop-1')()).toEqual(store.activityForChat('chat-1')());
  });

  it('clears the no-progress banner when the loop reaches a terminal state', () => {
    // Reproduces the "I cant press any of the buttons in the orange bar" report:
    // when a paused-no-progress loop is then cancelled (or terminates as
    // 'no-progress'), the banner used to linger on screen with buttons that
    // silently no-opped because `active()` had been cleared by the same
    // state-change. The banner must clear in lockstep with the active state.
    store.ensureWired();

    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: { ...activeState(), status: 'paused' },
    }));
    listeners.pausedNoProgress.forEach((cb) => cb({
      loopRunId: 'loop-1',
      signal: { id: 'D-prime', message: 'Tests unchanged at null pass for 5 iterations', verdict: 'CRITICAL' },
    }));
    expect(store.bannerForChat('chat-1')()).not.toBeNull();

    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: {
        ...activeState(),
        status: 'cancelled',
        totalIterations: 1,
        endedAt: 1778310300000,
        endReason: 'user cancelled',
      },
    }));

    expect(store.bannerForChat('chat-1')()).toBeNull();
    expect(store.activeForChat('chat-1')()).toBeUndefined();
  });

  it('clears running activity linkage when the loop reaches a terminal state', () => {
    store.ensureWired();
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: activeState(),
    }));
    listeners.iterationStarted.forEach((cb) => cb({
      loopRunId: 'loop-1',
      seq: 1,
      stage: 'IMPLEMENT',
    }));

    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: {
        ...activeState(),
        status: 'cancelled',
        totalIterations: 1,
        endedAt: 1778310300000,
        endReason: 'user cancelled',
      },
    }));

    expect(store.activeForChat('chat-1')()).toBeUndefined();
    expect(store.runningIterationForChat('chat-1')()).toBeNull();
    expect(store.summaryForChat('chat-1')()).toMatchObject({
      loopRunId: 'loop-1',
      status: 'cancelled',
      iterations: 1,
      reason: 'user cancelled',
    });
  });

  it('captures initialPrompt and iterationPrompt into the summary on terminal state', () => {
    store.ensureWired();
    const base = activeState();
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: {
        ...base,
        config: {
          ...base.config,
          initialPrompt: 'goal-of-the-loop',
          iterationPrompt: 'continue with fresh eyes',
        },
        status: 'completed',
        totalIterations: 5,
        endedAt: 1778310600000,
        endReason: 'signal=completed-rename',
      },
    }));

    expect(store.summaryForChat('chat-1')()).toMatchObject({
      initialPrompt: 'goal-of-the-loop',
      iterationPrompt: 'continue with fresh eyes',
      iterations: 5,
      status: 'completed',
    });
  });

  it('snapshots the last iteration onto the terminal summary so the card can recap without an extra IPC', () => {
    store.ensureWired();
    const base = activeState();
    const last = loopIteration({
      seq: 3,
      stage: 'IMPLEMENT',
      outputExcerpt: 'Implemented and verified the change.',
      filesChanged: [
        { path: 'src/a.ts', additions: 12, deletions: 3, contentHash: 'a' },
        { path: 'src/b.ts', additions: 4, deletions: 0, contentHash: 'b' },
      ],
      testPassCount: 42,
      testFailCount: 0,
      verifyStatus: 'passed',
      verifyOutputExcerpt: 'all checks passed',
      progressVerdict: 'OK',
    });
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: {
        ...base,
        status: 'completed',
        totalIterations: 4,
        endedAt: 1778310600000,
        lastIteration: last,
      },
    }));

    expect(store.summaryForChat('chat-1')()).toMatchObject({
      status: 'completed',
      lastIteration: {
        seq: 3,
        stage: 'IMPLEMENT',
        outputExcerpt: 'Implemented and verified the change.',
        testPassCount: 42,
        testFailCount: 0,
        verifyStatus: 'passed',
        verifyOutputExcerpt: 'all checks passed',
        progressVerdict: 'OK',
        filesChanged: [
          { path: 'src/a.ts', additions: 12, deletions: 3 },
          { path: 'src/b.ts', additions: 4, deletions: 0 },
        ],
      },
    });
  });

  it('leaves lastIteration undefined when the loop terminated before any iteration completed', () => {
    store.ensureWired();
    const base = activeState();
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: {
        ...base,
        status: 'cancelled',
        totalIterations: 0,
        endedAt: 1778310300000,
        // no lastIteration provided
      },
    }));

    expect(store.summaryForChat('chat-1')()?.lastIteration).toBeUndefined();
  });

  it('exposes runningChatIds for list-view consumers and tracks paused loops', () => {
    store.ensureWired();

    expect(store.runningChatIds().size).toBe(0);

    // Loop becomes active for chat-1 → should appear in the set.
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: activeState(),
    }));
    expect(store.runningChatIds().has('chat-1')).toBe(true);

    // Pausing keeps the chat in the running set — paused is non-terminal,
    // and the rail spinner should keep showing so the user knows the loop
    // is still attached, just not advancing right now.
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: { ...activeState(), status: 'paused' },
    }));
    expect(store.runningChatIds().has('chat-1')).toBe(true);

    // Terminal state clears it.
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: {
        ...activeState(),
        status: 'completed',
        totalIterations: 3,
        endedAt: 1778310300000,
      },
    }));
    expect(store.runningChatIds().has('chat-1')).toBe(false);
  });

  it('leaves iterationPrompt undefined when the loop reused initialPrompt', () => {
    store.ensureWired();
    const base = activeState();
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: {
        ...base,
        config: {
          ...base.config,
          initialPrompt: 'one-prompt-fits-all',
          iterationPrompt: undefined,
        },
        status: 'completed',
        totalIterations: 1,
        endedAt: 1778310300000,
      },
    }));

    const summary = store.summaryForChat('chat-1')();
    expect(summary?.initialPrompt).toBe('one-prompt-fits-all');
    expect(summary?.iterationPrompt).toBeUndefined();
  });

  it('refreshes persisted loop iterations for inspection', async () => {
    const iteration = loopIteration({ seq: 2, outputExcerpt: 'full enough evidence' });
    ipc.getIterations.mockResolvedValueOnce({
      success: true,
      data: { iterations: [iteration] },
    });

    await store.refreshIterations('loop-1');

    expect(ipc.getIterations).toHaveBeenCalledWith('loop-1');
    expect(store.iterationsForLoop('loop-1')()).toEqual([iteration]);
  });
});

function validConfig(): LoopStartConfigInput {
  return {
    initialPrompt: 'continue until done',
    workspaceCwd: '/tmp/project',
    provider: 'claude',
    contextStrategy: 'same-session',
  };
}

function subscribe<T>(target: ((data: T) => void)[], cb: (data: T) => void): () => void {
  target.push(cb);
  return () => {
    const index = target.indexOf(cb);
    if (index >= 0) target.splice(index, 1);
  };
}

type Listener<T> = (data: T) => void;

function activeState(): LoopStatePayload {
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    status: 'running',
    currentStage: 'PLAN',
    totalIterations: 0,
    totalTokens: 0,
    totalCostCents: 0,
    startedAt: 1778310000000,
    config: {
      ...validConfig(),
      reviewStyle: 'single' as const,
      contextStrategy: 'same-session' as const,
      caps: {
        maxIterations: 50,
        maxWallTimeMs: 14_400_000,
        maxTokens: 1_000_000,
        maxCostCents: 50_000,
        maxToolCallsPerIteration: 200,
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
      initialStage: 'IMPLEMENT' as const,
      allowDestructiveOps: false,
      iterationTimeoutMs: 3_600_000,
      streamIdleTimeoutMs: 300_000,
    },
  };
}

function loopIteration(overrides: Partial<LoopIterationPayload> = {}): LoopIterationPayload {
  return {
    id: 'iter-loop-1-0',
    loopRunId: 'loop-1',
    seq: 0,
    stage: 'IMPLEMENT',
    startedAt: 1778310000000,
    endedAt: 1778310060000,
    childInstanceId: 'child-1',
    tokens: 1000,
    costCents: 2,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    workHash: 'hash',
    outputSimilarityToPrev: null,
    outputExcerpt: 'iteration output',
    progressVerdict: 'OK',
    progressSignals: [],
    completionSignalsFired: [],
    verifyStatus: 'not-run',
    verifyOutputExcerpt: '',
    ...overrides,
  };
}
