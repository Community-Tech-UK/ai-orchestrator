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
    terminalIntentRecorded: Listener<{ loopRunId: string; intent: NonNullable<LoopStatePayload['terminalIntentPending']> }>[];
    terminalIntentRejected: Listener<{ loopRunId: string; intent: NonNullable<LoopStatePayload['terminalIntentPending']>; reason: string }>[];
    freshEyesReviewStarted: Listener<{ loopRunId: string; signal: string }>[];
    freshEyesReviewPassed: Listener<{ loopRunId: string; signal: string; reviewersUsed: string[]; nonBlockingFindings: number; summary?: string }>[];
    freshEyesReviewFailed: Listener<{ loopRunId: string; signal: string; error: string }>[];
    freshEyesReviewBlocked: Listener<{ loopRunId: string; signal: string; reviewersUsed: string[]; blockingFindings: unknown[]; summary?: string }>[];
    steeringDowngraded: Listener<{ loopRunId: string; requestedKind: 'steer'; effectiveKind: 'queue'; reason: string }>[];
    followUpDrained: Listener<{ loopRunId: string; seq: number; count: number; remaining: number }>[];
    completed: Listener<{ loopRunId: string; signal: string; verifyOutput: string }>[];
    completedNeedsReview: Listener<{ loopRunId: string; reason: string; acceptedByOperator: boolean }>[];
    failed: Listener<{ loopRunId: string; reason: string }>[];
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
    listRuns: ReturnType<typeof vi.fn>;
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
    onSteeringDowngraded: ReturnType<typeof vi.fn>;
    onFollowUpDrained: ReturnType<typeof vi.fn>;
    onCompleted: ReturnType<typeof vi.fn>;
    onCompletedNeedsReview: ReturnType<typeof vi.fn>;
    onFailed: ReturnType<typeof vi.fn>;
    onCapReached: ReturnType<typeof vi.fn>;
    onError: ReturnType<typeof vi.fn>;
    onOutstandingChanged: ReturnType<typeof vi.fn>;
    acceptCompletion: ReturnType<typeof vi.fn>;
    listOutstanding: ReturnType<typeof vi.fn>;
    setOutstandingStatus: ReturnType<typeof vi.fn>;
    exportOutstanding: ReturnType<typeof vi.fn>;
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
      terminalIntentRecorded: [],
      terminalIntentRejected: [],
      freshEyesReviewStarted: [],
      freshEyesReviewPassed: [],
      freshEyesReviewFailed: [],
      freshEyesReviewBlocked: [],
      steeringDowngraded: [],
      followUpDrained: [],
      completed: [],
      completedNeedsReview: [],
      failed: [],
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
      listRuns: vi.fn(),
      getIterations: vi.fn(),
      onStateChanged: vi.fn((cb) => subscribe(listeners.stateChanged, cb)),
      onIterationStarted: vi.fn((cb) => subscribe(listeners.iterationStarted, cb)),
      onActivity: vi.fn((cb) => subscribe(listeners.activity, cb)),
      onIterationComplete: vi.fn((cb) => subscribe(listeners.iterationComplete, cb)),
      onPausedNoProgress: vi.fn((cb) => subscribe(listeners.pausedNoProgress, cb)),
      onClaimedDoneButFailed: vi.fn((cb) => subscribe(listeners.claimedDoneButFailed, cb)),
      onTerminalIntentRecorded: vi.fn((cb) => subscribe(listeners.terminalIntentRecorded, cb)),
      onTerminalIntentRejected: vi.fn((cb) => subscribe(listeners.terminalIntentRejected, cb)),
      onFreshEyesReviewStarted: vi.fn((cb) => subscribe(listeners.freshEyesReviewStarted, cb)),
      onFreshEyesReviewPassed: vi.fn((cb) => subscribe(listeners.freshEyesReviewPassed, cb)),
      onFreshEyesReviewFailed: vi.fn((cb) => subscribe(listeners.freshEyesReviewFailed, cb)),
      onFreshEyesReviewBlocked: vi.fn((cb) => subscribe(listeners.freshEyesReviewBlocked, cb)),
      onSteeringDowngraded: vi.fn((cb) => subscribe(listeners.steeringDowngraded, cb)),
      onFollowUpDrained: vi.fn((cb) => subscribe(listeners.followUpDrained, cb)),
      onCompleted: vi.fn((cb) => subscribe(listeners.completed, cb)),
      onCompletedNeedsReview: vi.fn((cb) => subscribe(listeners.completedNeedsReview, cb)),
      onFailed: vi.fn((cb) => subscribe(listeners.failed, cb)),
      onCapReached: vi.fn((cb) => subscribe(listeners.capReached, cb)),
      onError: vi.fn((cb) => subscribe(listeners.error, cb)),
      onOutstandingChanged: vi.fn(() => () => { /* noop unsubscribe */ }),
      acceptCompletion: vi.fn(),
      listOutstanding: vi.fn(async () => ({ success: true, data: { items: [] } })),
      setOutstandingStatus: vi.fn(async () => ({ success: true, data: { ok: true } })),
      exportOutstanding: vi.fn(async () => ({ success: true, data: { path: '/tmp/OUTSTANDING.md', itemCount: 0 } })),
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
    listeners.activity.forEach((cb) => cb({
      loopRunId: 'loop-1',
      seq: 1,
      stage: 'IMPLEMENT',
      kind: 'tool_result',
      message: 'Read completed',
      timestamp: 1778310000100,
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
    }, {
      loopRunId: 'loop-1',
      seq: 1,
      stage: 'IMPLEMENT',
      kind: 'tool_result',
      message: 'Read completed',
      timestamp: 1778310000100,
    }]);
    expect(store.activityForLoop('loop-1')()).toEqual(store.activityForChat('chat-1')());
  });

  it('surfaces fresh-eyes review lifecycle events as loop activity', () => {
    store.ensureWired();
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: { ...activeState(), totalIterations: 2 },
    }));

    listeners.freshEyesReviewStarted.forEach((cb) => cb({
      loopRunId: 'loop-1',
      signal: 'declared-complete',
    }));
    listeners.freshEyesReviewBlocked.forEach((cb) => cb({
      loopRunId: 'loop-1',
      signal: 'declared-complete',
      reviewersUsed: ['gemini'],
      blockingFindings: [{ severity: 'high', title: 'Missing test' }],
      summary: 'one blocker',
    }));

    expect(store.activityForLoop('loop-1')().map((activity) => activity.message)).toEqual([
      'Fresh-eyes review started for declared-complete',
      'Fresh-eyes review blocked declared-complete',
    ]);
    expect(store.activityForLoop('loop-1')()[1]?.kind).toBe('input_required');
  });

  it('surfaces steering downgrade and follow-up drain events as loop activity', () => {
    store.ensureWired();
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: { ...activeState(), totalIterations: 4, currentStage: 'IMPLEMENT' },
    }));

    listeners.steeringDowngraded.forEach((cb) => cb({
      loopRunId: 'loop-1',
      requestedKind: 'steer',
      effectiveKind: 'queue',
      reason: 'active loop provider does not accept mid-iteration input',
    }));
    listeners.followUpDrained.forEach((cb) => cb({
      loopRunId: 'loop-1',
      seq: 5,
      count: 1,
      remaining: 2,
    }));

    expect(store.activityForLoop('loop-1')().map((activity) => activity.message)).toEqual([
      'Live steering unavailable; queued for the next iteration',
      'Queued follow-up drained (1); 2 remaining',
    ]);
    expect(store.activityForLoop('loop-1')()[0]).toMatchObject({
      kind: 'status',
      detail: {
        effectiveKind: 'queue',
        requestedKind: 'steer',
      },
    });
    expect(store.activityForLoop('loop-1')()[1]).toMatchObject({
      seq: 5,
      detail: { count: 1, remaining: 2 },
    });
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

  it('applies loop control returned state when the push event is missed', async () => {
    store.ensureWired();
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: { ...activeState(), status: 'paused' },
    }));
    listeners.pausedNoProgress.forEach((cb) => cb({
      loopRunId: 'loop-1',
      signal: { id: 'D-prime', message: 'Tests unchanged at null pass for 5 iterations', verdict: 'CRITICAL' },
    }));
    ipc.resume.mockResolvedValueOnce({
      success: true,
      data: { ok: true, state: { ...activeState(), status: 'running' } },
    });

    await store.resume('loop-1');

    expect(store.activeForChat('chat-1')()?.status).toBe('running');
    expect(store.bannerForChat('chat-1')()).toBeNull();
  });

  it('keeps the no-progress banner visible when resume is rejected', async () => {
    store.ensureWired();
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: { ...activeState(), status: 'paused' },
    }));
    listeners.pausedNoProgress.forEach((cb) => cb({
      loopRunId: 'loop-1',
      signal: { id: 'D-prime', message: 'Tests unchanged at null pass for 5 iterations', verdict: 'CRITICAL' },
    }));
    ipc.resume.mockResolvedValueOnce({
      success: true,
      data: { ok: false },
    });

    await store.resume('loop-1');

    expect(store.bannerForChat('chat-1')()).not.toBeNull();
    expect(store.activityForLoop('loop-1')().at(-1)).toMatchObject({
      kind: 'error',
      message: 'Loop resume was rejected by the main process',
    });
  });

  it('clears active loop locally when cancel succeeds without a returned state', async () => {
    store.ensureWired();
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: { ...activeState(), status: 'paused' },
    }));
    ipc.cancel.mockResolvedValueOnce({
      success: true,
      data: { ok: true },
    });

    await store.cancel('loop-1');

    expect(store.activeForChat('chat-1')()).toBeUndefined();
    expect(store.summaryForChat('chat-1')()).toMatchObject({
      loopRunId: 'loop-1',
      status: 'cancelled',
      reason: 'user cancelled',
    });
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

  it('treats failed as terminal and captures a failed summary', () => {
    store.ensureWired();
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: activeState(),
    }));

    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: {
        ...activeState(),
        status: 'failed',
        totalIterations: 1,
        endedAt: 1778310600000,
        endReason: 'declared failed',
      },
    }));

    expect(store.activeForChat('chat-1')()).toBeUndefined();
    expect(store.summaryForChat('chat-1')()).toMatchObject({
      status: 'failed',
      reason: 'declared failed',
    });
  });

  it('treats ended provider-limit as terminal and captures a stopped summary', () => {
    store.ensureWired();
    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: activeState(),
    }));

    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: {
        ...activeState(),
        status: 'provider-limit',
        totalIterations: 0,
        endedAt: 1778310600000,
        endReason: '5-hour session exhausted',
      },
    }));

    expect(store.activeForChat('chat-1')()).toBeUndefined();
    expect(store.summaryForChat('chat-1')()).toMatchObject({
      status: 'provider-limit',
      iterations: 0,
      reason: '5-hour session exhausted',
    });
  });

  it('keeps a provider-limit checkpoint with no endedAt active for resume', () => {
    store.ensureWired();

    listeners.stateChanged.forEach((cb) => cb({
      loopRunId: 'loop-1',
      state: {
        ...activeState(),
        status: 'provider-limit',
        endedAt: null,
        endReason: 'provider window exhausted',
      },
    }));

    expect(store.activeForChat('chat-1')()).toMatchObject({
      id: 'loop-1',
      status: 'provider-limit',
    });
    expect(store.runningChatIds().has('chat-1')).toBe(true);
    expect(store.summaryForChat('chat-1')()).toBeNull();
  });

  it('treats ping-pong terminal statuses as terminal and captures summaries', () => {
    store.ensureWired();
    const terminalStatuses: LoopStatePayload['status'][] = [
      'cost-exceeded',
      'needs-human-arbitration',
      'reviewer-unreliable',
      'reviewer-unavailable',
      'builder-unreliable',
    ];

    for (const status of terminalStatuses) {
      listeners.stateChanged.forEach((cb) => cb({
        loopRunId: 'loop-1',
        state: activeState(),
      }));

      listeners.stateChanged.forEach((cb) => cb({
        loopRunId: 'loop-1',
        state: {
          ...activeState(),
          status,
          totalIterations: 3,
          endedAt: 1778310600000,
          endReason: `ping-pong terminal: ${status}`,
        },
      }));

      expect(store.activeForChat('chat-1')(), status).toBeUndefined();
      expect(store.runningChatIds().has('chat-1'), status).toBe(false);
      expect(store.summaryForChat('chat-1')(), status).toMatchObject({
        status,
        iterations: 3,
        reason: `ping-pong terminal: ${status}`,
      });
    }
  });

  it('snapshots the last iteration onto the terminal summary so the card can recap without an extra IPC', () => {
    store.ensureWired();
    const base = activeState();
    const last = loopIteration({
      seq: 3,
      stage: 'IMPLEMENT',
      outputExcerpt: 'head…tail',
      outputFull: 'Implemented and verified the change. Full closing message here.',
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
        outputExcerpt: 'head…tail',
        outputFull: 'Implemented and verified the change. Full closing message here.',
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

  it('bulk-resolves every open outstanding item and applies an optimistic update', async () => {
    ipc.listOutstanding.mockResolvedValueOnce({
      success: true,
      data: {
        items: [
          { id: 'o1', status: 'open' },
          { id: 'o2', status: 'open' },
          { id: 'o3', status: 'resolved' },
        ],
      },
    });
    await store.loadOutstanding({ workspaceCwd: '/tmp/project' });

    const resolved = await store.setOutstandingStatusBulk(['o1', 'o2'], 'resolved');

    expect(resolved).toBe(2);
    expect(ipc.setOutstandingStatus).toHaveBeenCalledTimes(2);
    expect(ipc.setOutstandingStatus).toHaveBeenCalledWith('o1', 'resolved');
    expect(ipc.setOutstandingStatus).toHaveBeenCalledWith('o2', 'resolved');
    expect(store.outstanding().every((i) => i.status === 'resolved')).toBe(true);
    expect(store.openOutstandingCount()).toBe(0);
  });

  it('loads outstanding items using a session scope', async () => {
    await store.loadOutstanding({ chatId: 'chat-1', status: 'open' });

    expect(ipc.listOutstanding).toHaveBeenCalledWith({ chatId: 'chat-1', status: 'open' });
  });

  it('exports outstanding items using a session scope when provided', async () => {
    await store.exportOutstanding('/tmp/project', undefined, 'chat-1');

    expect(ipc.exportOutstanding).toHaveBeenCalledWith('/tmp/project', undefined, 'chat-1');
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

  it('Task 18: forwards kind + drainMode through intervene to the IPC layer', async () => {
    ipc.intervene.mockResolvedValue({ success: true, data: { ok: true } });

    await store.intervene('loop-1', 'run before finishing', 'follow-up', 'one-at-a-time');
    expect(ipc.intervene).toHaveBeenCalledWith('loop-1', 'run before finishing', 'follow-up', 'one-at-a-time');

    await store.intervene('loop-1', 'plain hint');
    expect(ipc.intervene).toHaveBeenLastCalledWith('loop-1', 'plain hint', undefined, undefined);
  });

  describe('recent-run read model (Workboard)', () => {
    it('refreshRecentRuns replaces recentRuns with the returned newest-first list', async () => {
      ipc.listRuns.mockResolvedValueOnce({
        success: true,
        data: {
          runs: [
            runSummary({ id: 'loop-old', startedAt: 1, status: 'completed' }),
            runSummary({ id: 'loop-review', startedAt: 3, status: 'completed-needs-review' }),
            runSummary({ id: 'loop-active', startedAt: 2, status: 'running' }),
          ],
        },
      });

      const result = await store.refreshRecentRuns();

      expect(ipc.listRuns).toHaveBeenCalledWith(100);
      expect(result).toEqual({ ok: true, runs: expect.any(Array) });
      expect(store.recentRuns().map((r) => r.id)).toEqual(['loop-review', 'loop-active', 'loop-old']);
    });

    it('preserves the prior list and returns a recoverable error when a refresh fails', async () => {
      ipc.listRuns.mockResolvedValueOnce({
        success: true,
        data: { runs: [runSummary({ id: 'loop-keep', startedAt: 5 })] },
      });
      await store.refreshRecentRuns();

      ipc.listRuns.mockResolvedValueOnce({ success: false, error: { message: 'store offline' } });
      const result = await store.refreshRecentRuns();

      expect(result).toEqual({ ok: false, error: 'store offline' });
      expect(store.recentRuns().map((r) => r.id)).toEqual(['loop-keep']);
    });

    it('upserts a changed run from an onStateChanged event without duplicating its ID', () => {
      store.ensureWired();

      listeners.stateChanged.forEach((cb) => cb({ loopRunId: 'loop-1', state: activeState() }));
      expect(store.recentRuns()).toHaveLength(1);
      expect(store.recentRuns()[0]).toMatchObject({ id: 'loop-1', status: 'running', workspaceCwd: '/tmp/project' });

      listeners.stateChanged.forEach((cb) => cb({
        loopRunId: 'loop-1',
        state: { ...activeState(), status: 'paused', totalIterations: 2 },
      }));

      expect(store.recentRuns()).toHaveLength(1);
      expect(store.recentRuns()[0]).toMatchObject({ id: 'loop-1', status: 'paused', totalIterations: 2 });
    });

    it('keeps a terminal run in recentRuns after it leaves the active map', () => {
      store.ensureWired();

      listeners.stateChanged.forEach((cb) => cb({ loopRunId: 'loop-1', state: activeState() }));
      listeners.stateChanged.forEach((cb) => cb({
        loopRunId: 'loop-1',
        state: { ...activeState(), status: 'completed', endedAt: 1778310120000, endReason: 'done' },
      }));

      expect(store.activeForChat('chat-1')()).toBeUndefined();
      expect(store.recentRuns()).toHaveLength(1);
      expect(store.recentRuns()[0]).toMatchObject({ id: 'loop-1', status: 'completed' });
    });

    it('does not expose any selection behaviour when a passive loop event arrives', () => {
      store.ensureWired();
      // The LoopStore is a passive projection; a background loop event must not
      // introduce instance/Workboard selection into this store.
      expect('setSelectedInstance' in store).toBe(false);
      expect('selectedInstance' in store).toBe(false);

      listeners.stateChanged.forEach((cb) => cb({ loopRunId: 'loop-1', state: activeState() }));

      expect(store.recentRuns()).toHaveLength(1);
    });
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

function runSummary(
  overrides: Partial<import('@contracts/schemas/loop').LoopRunSummaryPayload> = {},
): import('@contracts/schemas/loop').LoopRunSummaryPayload {
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    status: 'running',
    totalIterations: 0,
    totalTokens: 0,
    totalCostCents: 0,
    startedAt: 1778310000000,
    endedAt: null,
    endReason: null,
    workspaceCwd: '/tmp/project',
    initialPrompt: 'continue until done',
    iterationPrompt: null,
    ...overrides,
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
    endedAt: null,
    pendingInterventions: [],
    terminalIntentHistory: [],
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
    announceThenHaltNudgeCount: 0,
    loopTasksLedgerResolvedAtStart: false,
    config: {
      ...validConfig(),
      provider: 'claude' as const,
      reviewStyle: 'single' as const,
      contextStrategy: 'same-session' as const,
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
        similarityWarnMean: 0.85,
        similarityCriticalMean: 0.92,
        stageWarnIterations: { PLAN: 3, REVIEW: 2, IMPLEMENT: 8 },
        stageCriticalIterations: { PLAN: 5, REVIEW: 3, IMPLEMENT: 12 },
        errorRepeatWarnInWindow: 3,
        errorRepeatCriticalInWindow: 4,
        tokensWithoutProgressWarn: 25_000,
        tokensWithoutProgressCritical: 60_000,
        pauseOnTokenBurn: false,
        toolRepeatWarnPerIteration: 5,
        toolRepeatCriticalPerIteration: 8,
        identicalToolCallConsecutiveCritical: 3,
        idempotentReadRepeatWarn: 3,
        testStagnationWarnIterations: 3,
        testStagnationCriticalIterations: 5,
        churnRatioWarn: 0.30,
        churnRatioCritical: 0.50,
        warnEscalationWindow: 5,
        warnEscalationCount: 3,
      },
      audit: {
        finalAuditMode: 'observe' as const,
        preflightMode: 'off' as const,
        planPacketMode: 'off' as const,
        cleanlinessScan: true,
      },
      completion: {
        completedFilenamePattern: '_completed',
        donePromiseRegex: '',
        doneSentinelFile: '',
        verifyCommand: '',
        allowOperatorReviewedCompletion: false,
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
    filesRead: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    unresolvedToolCalls: false,
    workHash: 'hash',
    outputSimilarityToPrev: null,
    outputExcerpt: 'iteration output',
    outputFull: 'iteration output',
    progressVerdict: 'OK',
    progressSignals: [],
    completionSignalsFired: [],
    verifyStatus: 'not-run',
    verifyOutputExcerpt: '',
    ...overrides,
  };
}
