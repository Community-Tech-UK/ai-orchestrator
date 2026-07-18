import { describe, expect, it, vi } from 'vitest';
import { defaultLoopConfig, type LoopIteration, type LoopState } from '../../shared/types/loop.types';
import { LoopLifecycleStateManager } from './loop-lifecycle-state-manager';

function makeState(id = 'loop-1'): LoopState {
  return {
    id,
    chatId: `chat-${id}`,
    config: defaultLoopConfig('/tmp/workspace', 'do work'),
    status: 'running',
    startedAt: 1,
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
    loopTasksLedgerResolvedAtStart: false,
    manualReviewOnly: false,
    tokensSinceLastTestImprovement: 0,
    highestTestPassCount: 0,
    iterationsOnCurrentStage: 0,
    recentWarnIterationSeqs: [],
    completionAttempts: 0,
    recentEvidenceHashes: [],
    repeatedEvidenceCount: 0,
    terminalIntentHistory: [],
  };
}

describe('LoopLifecycleStateManager', () => {
  it('owns active states and their mutable bounded-history buffers', () => {
    const manager = new LoopLifecycleStateManager();
    const state = makeState();
    const history = [] as LoopIteration[];

    manager.register(state, history);

    expect(manager.getState(state.id)).toBe(state);
    expect(manager.listStates()).toEqual([state]);
    expect(manager.historyFor(state.id)).toBe(history);
  });

  it('blocks on a pause gate until resume releases it', async () => {
    const manager = new LoopLifecycleStateManager();
    let resumed = false;
    const waiting = manager.waitUntilResumed('loop-1').then(() => { resumed = true; });

    await Promise.resolve();
    expect(resumed).toBe(false);
    expect(manager.releasePause('loop-1')).toBe(true);
    await waiting;
    expect(resumed).toBe(true);
    expect(manager.releasePause('loop-1')).toBe(false);
  });

  it('tracks cancellation independently for concurrent loops', () => {
    const manager = new LoopLifecycleStateManager();

    manager.setCancelled('loop-a', true);

    expect(manager.isCancelled('loop-a')).toBe(true);
    expect(manager.isCancelled('loop-b')).toBe(false);
  });

  it('owns terminal-cleanup promises and only clears the matching generation', async () => {
    const manager = new LoopLifecycleStateManager();
    const first = Promise.resolve();
    const second = Promise.resolve();

    manager.setTerminalCleanup('loop-1', first);
    manager.setTerminalCleanup('loop-1', second);

    expect(manager.getTerminalCleanup('loop-1')).toBe(second);
    expect(manager.clearTerminalCleanup('loop-1', first)).toBe(false);
    expect(manager.clearTerminalCleanup('loop-1', second)).toBe(true);
    expect(manager.getTerminalCleanup('loop-1')).toBeUndefined();
  });

  it('takes worktree session ownership exactly once', () => {
    const manager = new LoopLifecycleStateManager();

    manager.setWorktreeSession('loop-1', 'session-1');

    expect(manager.hasWorktreeSession('loop-1')).toBe(true);
    expect(manager.takeWorktreeSession('loop-1')).toBe('session-1');
    expect(manager.takeWorktreeSession('loop-1')).toBeUndefined();
  });

  it('resets every lifecycle-owned registry', async () => {
    const manager = new LoopLifecycleStateManager();
    manager.register(makeState(), []);
    manager.setCancelled('loop-1', true);
    const waiting = manager.waitUntilResumed('loop-1');
    manager.setTerminalCleanup('loop-1', Promise.resolve());
    manager.setWorktreeSession('loop-1', 'session-1');
    const resumed = vi.fn();
    void waiting.then(resumed);

    manager.reset();
    await waiting;

    expect(manager.listStates()).toEqual([]);
    expect(manager.historyFor('loop-1')).toEqual([]);
    expect(manager.isCancelled('loop-1')).toBe(false);
    expect(manager.getTerminalCleanup('loop-1')).toBeUndefined();
    expect(manager.hasWorktreeSession('loop-1')).toBe(false);
    expect(resumed).toHaveBeenCalledOnce();
  });
});
