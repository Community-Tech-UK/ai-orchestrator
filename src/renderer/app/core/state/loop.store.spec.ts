import { TestBed } from '@angular/core/testing';
import type { LoopStatePayload } from '@contracts/schemas/loop';
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
