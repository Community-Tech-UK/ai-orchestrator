import { describe, expect, it, vi } from 'vitest';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import { LoopPreIterationGuard } from './loop-pre-iteration-guard';

function makeState(): LoopState {
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    config: defaultLoopConfig('/tmp/workspace', 'do work'),
    status: 'running',
    startedAt: Date.now(),
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

function makeHarness(overrides: Partial<ConstructorParameters<typeof LoopPreIterationGuard>[0]> = {}) {
  let cancelled = false;
  let capWrapUp: 'iterations' | 'wall-time' | 'tokens' | 'cost' | undefined;
  const terminate = vi.fn();
  const emit = vi.fn();
  const guard = new LoopPreIterationGuard({
    isCancelled: () => cancelled,
    waitWhilePaused: vi.fn(async () => undefined),
    maintenanceActive: () => false,
    getConvergenceNote: () => undefined,
    getCapWrapUp: () => capWrapUp,
    setCapWrapUp: (_id, cap) => { capWrapUp = cap; },
    terminate,
    emit,
    sleep: vi.fn(async () => undefined),
    ...overrides,
  });
  return { guard, terminate, emit, setCancelled: (value: boolean) => { cancelled = value; } };
}

describe('LoopPreIterationGuard', () => {
  it('terminates immediately when cancellation is already requested', async () => {
    const state = makeState();
    const harness = makeHarness({ isCancelled: () => true });

    await expect(harness.guard.run(state)).resolves.toBe('terminal');
    expect(harness.terminate).toHaveBeenCalledWith(state, 'cancelled');
  });

  it('waits for a parked loop and rechecks cancellation after resume', async () => {
    const state = makeState();
    state.status = 'paused';
    let cancelled = false;
    const waitWhilePaused = vi.fn(async () => { cancelled = true; });
    const harness = makeHarness({ isCancelled: () => cancelled, waitWhilePaused });

    await expect(harness.guard.run(state)).resolves.toBe('terminal');
    expect(waitWhilePaused).toHaveBeenCalledWith(state.id);
    expect(harness.terminate).toHaveBeenCalledWith(state, 'cancelled');
  });

  it('restarts the loop pass while maintenance owns the persistence layer', async () => {
    const state = makeState();
    const sleep = vi.fn(async () => undefined);
    const harness = makeHarness({ maintenanceActive: () => true, sleep });

    await expect(harness.guard.run(state)).resolves.toBe('restart');
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it('allows one cap wrap-up iteration, then terminates on the next pass', async () => {
    const state = makeState();
    state.config.caps.maxIterations = 0;
    const harness = makeHarness();

    await expect(harness.guard.run(state)).resolves.toBe('continue');
    expect(state.pendingInterventions).toHaveLength(1);
    expect(harness.emit).toHaveBeenCalledWith(
      'loop:cap-wrap-up',
      expect.objectContaining({ loopRunId: state.id, cap: 'iterations' }),
    );

    await expect(harness.guard.run(state)).resolves.toBe('terminal');
    expect(harness.terminate).toHaveBeenCalledWith(
      state,
      'cap-reached',
      expect.stringContaining('iterations'),
    );
  });
});
