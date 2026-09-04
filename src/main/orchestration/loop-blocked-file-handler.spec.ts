import { describe, expect, it, vi } from 'vitest';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import { LoopBlockedFileHandler } from './loop-blocked-file-handler';

function makeState(): LoopState {
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    config: defaultLoopConfig('/tmp/workspace', 'do work'),
    status: 'running',
    startedAt: Date.now(),
    endedAt: null,
    totalIterations: 2,
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

function makeHarness(
  overrides: Partial<ConstructorParameters<typeof LoopBlockedFileHandler>[0]> = {},
) {
  const emit = vi.fn();
  const moveBlockedFileAside = vi.fn(async () => undefined);
  const runLivenessProbe = vi.fn(async () => ({ alive: true, detail: 'exec-ok; fs-ok' }));
  const handler = new LoopBlockedFileHandler({
    readBlockedFile: vi.fn(async () => ({ message: 'toolchain returns empty output' })),
    isToolchainClassBlock: vi.fn(() => true),
    runLivenessProbe,
    moveBlockedFileAside,
    setConvergenceNote: vi.fn(),
    cloneStateForBroadcast: (state) => ({ ...state }),
    emit,
    onOverridden: vi.fn(),
    onPaused: vi.fn(),
    ...overrides,
  });
  return { handler, emit, moveBlockedFileAside, runLivenessProbe };
}

describe('LoopBlockedFileHandler', () => {
  it('continues when no BLOCKED.md content is present', async () => {
    const state = makeState();
    const harness = makeHarness({ readBlockedFile: vi.fn(async () => null) });

    await expect(harness.handler.handle(state)).resolves.toBe('continue');
    expect(state.status).toBe('running');
    expect(harness.emit).not.toHaveBeenCalled();
  });

  /**
   * The probe result can OVERRIDE a block, so probing the wrong directory is a
   * safety failure: under isolation the repo root is trivially alive while the
   * agent's worktree is wedged, which would silently discard a legitimate
   * block. See `loop-cwd.ts`.
   */
  it('probes the execution cwd, not the repo root, when isolation is active', async () => {
    const state = makeState();
    state.config.executionCwd = '/tmp/workspace/.worktrees/session';
    state.config.isolateLoopWorkspaces = true;
    const harness = makeHarness();

    await harness.handler.handle(state);

    expect(harness.runLivenessProbe).toHaveBeenCalledWith(
      '/tmp/workspace/.worktrees/session',
      expect.any(Number),
    );
  });

  it('probes the repo root when isolation is off', async () => {
    const state = makeState();
    const harness = makeHarness();

    await harness.handler.handle(state);

    expect(harness.runLivenessProbe).toHaveBeenCalledWith('/tmp/workspace', expect.any(Number));
  });

  it('overrides a toolchain block when the liveness probe succeeds', async () => {
    const state = makeState();
    const setConvergenceNote = vi.fn();
    const harness = makeHarness({ setConvergenceNote });

    await expect(harness.handler.handle(state)).resolves.toBe('restart');
    expect(state.pendingInterventions).toEqual([
      expect.objectContaining({ source: 'block-override' }),
    ]);
    expect(setConvergenceNote).toHaveBeenCalledWith(
      state.id,
      'BLOCKED.md overridden by liveness probe',
    );
    expect(harness.moveBlockedFileAside).toHaveBeenCalledWith(state);
    expect(harness.emit).toHaveBeenCalledWith(
      'loop:activity',
      expect.objectContaining({ loopRunId: state.id, kind: 'status' }),
    );
  });

  it('pauses with probe evidence when the toolchain is genuinely unresponsive', async () => {
    const state = makeState();
    const harness = makeHarness({
      runLivenessProbe: vi.fn(async () => ({ alive: false, detail: 'exec-failed' })),
    });

    await expect(harness.handler.handle(state)).resolves.toBe('restart');
    expect(state.status).toBe('paused');
    expect(state.pausedForInput).toBe(true);
    expect(harness.emit).toHaveBeenCalledWith(
      'loop:paused-no-progress',
      expect.objectContaining({
        loopRunId: state.id,
        signal: expect.objectContaining({
          id: 'BLOCKED',
          message: expect.stringContaining('liveness probe failed: exec-failed'),
        }),
      }),
    );
  });

  it('honors a non-toolchain block without probing', async () => {
    const state = makeState();
    const harness = makeHarness({ isToolchainClassBlock: vi.fn(() => false) });

    await expect(harness.handler.handle(state)).resolves.toBe('restart');
    expect(state.status).toBe('paused');
    expect(harness.runLivenessProbe).not.toHaveBeenCalled();
  });
});
