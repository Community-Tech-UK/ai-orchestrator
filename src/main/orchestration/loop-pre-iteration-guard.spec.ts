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
  let capWrapUp: {
    cap: 'iterations' | 'wall-time' | 'tokens' | 'cost';
    originalReason: string;
    triggerIteration: number;
    phase: 'pending-turn' | 'turn-complete';
  } | undefined;
  const terminate = vi.fn();
  const emit = vi.fn();
  const guard = new LoopPreIterationGuard({
    isCancelled: () => cancelled,
    waitWhilePaused: vi.fn(async () => undefined),
    maintenanceActive: () => false,
    getConvergenceNote: () => undefined,
    getCapWrapUp: () => capWrapUp,
    setCapWrapUp: (_id, intent) => { capWrapUp = intent; },
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

  // T45 (Decision 4): a run that already blew its token or cost cap must not
  // pay another full scaffold to overshoot the budget that stopped it.
  it('skips the wrap-up turn when the tripped cap is tokens', async () => {
    const state = makeState();
    state.config.caps.maxTokens = 1_000;
    state.totalTokens = 5_000;
    const harness = makeHarness();

    await expect(harness.guard.run(state)).resolves.toBe('terminal');
    expect(state.pendingInterventions).toHaveLength(0);
    expect(harness.emit).not.toHaveBeenCalledWith('loop:cap-wrap-up', expect.anything());
    expect(harness.terminate).toHaveBeenCalledWith(state, 'cap-reached', expect.stringContaining('oken'));
  });

  it('skips the wrap-up turn when the tripped cap is cost', async () => {
    const state = makeState();
    state.config.caps.maxCostCents = 100;
    state.totalCostCents = 500;
    const harness = makeHarness();

    await expect(harness.guard.run(state)).resolves.toBe('terminal');
    expect(state.pendingInterventions).toHaveLength(0);
    expect(harness.emit).not.toHaveBeenCalledWith('loop:cap-wrap-up', expect.anything());
  });

  // T45 (Wave 2): the wrap-up is only a hand-off when "do not start new work"
  // is enforced. A prompt-only provider keeps every tool and may start work it
  // will never finish, so the extra paid turn is pure waste.
  it('skips the wrap-up turn on a provider that cannot enforce tools-disable', async () => {
    const state = makeState();
    state.config.provider = 'gemini';
    state.config.caps.maxIterations = 0;
    const harness = makeHarness();

    await expect(harness.guard.run(state)).resolves.toBe('terminal');
    expect(state.pendingInterventions).toHaveLength(0);
    expect(harness.emit).not.toHaveBeenCalledWith('loop:cap-wrap-up', expect.anything());
  });

  it('still wraps up on a wall-time cap', async () => {
    const state = makeState();
    state.config.caps.maxWallTimeMs = 1;
    state.startedAt = Date.now() - 10_000;
    const harness = makeHarness();

    await expect(harness.guard.run(state)).resolves.toBe('continue');
    expect(state.pendingInterventions).toHaveLength(1);
  });

  it('terminalizes a restored pending cap intent without reopening the work budget', async () => {
    const state = makeState();
    state.capWrapUpIntent = {
      cap: 'cost',
      originalReason: 'Original cost limit reason',
      triggerIteration: 4,
      measurement: 400,
      limit: 400,
      phase: 'pending-turn',
    };
    // Simulate a compatibility restore whose current config no longer proves
    // the cap numerically. The persisted terminal intent remains authoritative.
    state.config.caps.maxCostCents = null;
    const harness = makeHarness();

    await expect(harness.guard.run(state)).resolves.toBe('terminal');
    expect(harness.terminate).toHaveBeenCalledWith(
      state,
      'cap-reached',
      'Original cost limit reason',
    );
  });
});
