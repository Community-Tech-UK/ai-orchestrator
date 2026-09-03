/**
 * Coordinator wiring for bounded auto-unstick: a fixable CRITICAL (same tool
 * repeated) must inject a next-iteration steer instead of pausing first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const log = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => log,
}));

import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { buildLoopCheckpoint } from './loop-checkpoint';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import { passingVerifyCommand } from './loop-test-commands';
import { loopStateFile, resolveLoopArtifactPaths } from './loop-artifact-paths';

let workspace: string;
let coordinator: LoopCoordinator;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-auto-unstick-'));
  coordinator = new LoopCoordinator();
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const loop of coordinator.getActiveLoops()) {
    try { await coordinator.cancelLoop(loop.id); } catch { /* noop */ }
  }
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

function repeatedEdit(): LoopChildResult {
  return {
    childInstanceId: null,
    output: 'editing the same file again',
    tokens: 1,
    filesChanged: [{ path: 'src/app.ts', additions: 1, deletions: 1, contentHash: 'edit-1' }],
    toolCalls: Array.from({ length: 8 }, () => ({
      toolName: 'Edit',
      argsHash: 'same-edit',
      success: true,
      durationMs: 10,
    })),
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
  };
}

function progressingEdit(): LoopChildResult {
  return {
    childInstanceId: null,
    output: 'changed approach and edited a different file',
    tokens: 1,
    filesChanged: [{ path: 'src/next.ts', additions: 1, deletions: 0, contentHash: 'edit-2' }],
    toolCalls: [{
      toolName: 'Edit',
      argsHash: 'different-edit',
      success: true,
      durationMs: 10,
    }],
    errors: [],
    testPassCount: 1,
    testFailCount: 0,
    exitedCleanly: true,
  };
}

function completedEdit(): LoopChildResult {
  return {
    childInstanceId: null,
    output: '<promise>DONE</promise>\nTASK COMPLETE',
    tokens: 1,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: 1,
    testFailCount: 0,
    exitedCleanly: true,
  };
}

describe('loop auto-unstick', () => {
  it('injects a change-of-approach nudge on tool-repetition CRITICAL instead of pausing', async () => {
    writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
    let paused = false;
    let autoUnsticks = 0;
    coordinator.on('loop:paused-no-progress', () => { paused = true; });
    coordinator.on('loop:auto-unstick', () => { autoUnsticks++; });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      queueMicrotask(() => p.callback(repeatedEdit()));
    });

    const base = defaultLoopConfig(workspace, 'do the thing');
    const state = await coordinator.startLoop('chat-auto-unstick', {
      initialPrompt: 'do the thing',
      workspaceCwd: workspace,
      completion: { ...base.completion, verifyCommand: passingVerifyCommand() },
      caps: { ...base.caps, maxCostCents: 100, maxWallTimeMs: 60_000 },
      progressThresholds: {
        ...base.progressThresholds,
        toolRepeatCriticalPerIteration: 8,
      },
    });

    const live = () => coordinator.getLoop(state.id);
    for (let i = 0; i < 120 && autoUnsticks === 0 && live()?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(autoUnsticks).toBeGreaterThanOrEqual(1);
    expect(paused).toBe(false);
    const after = live();
    expect(after?.status).toBe('running');
    expect(after?.autoUnstick?.signalId).toBe('G');
    const steered = (after?.pendingInterventions ?? []).some((item) =>
      item.source === 'auto-unstick' || item.message.includes('AUTOMATIC UNSTICK'),
    );
    expect(steered || after?.autoUnstick?.attempt === 1).toBe(true);
    expect(log.info).toHaveBeenCalledWith(
      'Suppressed no-progress pause',
      expect.objectContaining({ loopRunId: state.id, reason: 'auto-unstick' }),
    );

    if (after?.status === 'running') await coordinator.cancelLoop(state.id);
  }, 15_000);

  it('restores the attempt cap from persisted autoUnstick so a restart cannot inject extra nudges', async () => {
    writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
    let autoUnsticks = 0;
    let paused = false;
    coordinator.on('loop:auto-unstick', () => { autoUnsticks++; });
    coordinator.on('loop:paused-no-progress', () => { paused = true; });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      queueMicrotask(() => p.callback(repeatedEdit()));
    });

    const base = defaultLoopConfig(workspace, 'do the thing');
    const pausedState: LoopState = {
      id: 'loop-restore-unstick',
      chatId: 'chat-restore-unstick',
      config: {
        ...base,
        completion: { ...base.completion, mode: 'gated', verifyCommand: passingVerifyCommand() },
        caps: { ...base.caps, maxCostCents: 100, maxWallTimeMs: 60_000 },
        progressThresholds: {
          ...base.progressThresholds,
          toolRepeatCriticalPerIteration: 8,
        },
      },
      status: 'paused',
      startedAt: Date.now(),
      endedAt: null,
      totalIterations: 5,
      totalTokens: 10,
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
      iterationsOnCurrentStage: 1,
      recentWarnIterationSeqs: [],
      completionAttempts: 0,
      loopTasksLedgerResolvedAtStart: false,
      autoUnstick: { seq: 5, attempt: 2, max: 2, signalId: 'G' },
    };

    const restored = await coordinator.restoreLoopFromCheckpoint(buildLoopCheckpoint({
      state: pausedState,
      history: [],
    }));
    expect(coordinator.resumeLoop(restored.id)).toBe(true);

    const live = () => coordinator.getLoop(restored.id);
    for (let i = 0; i < 120 && live()?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(autoUnsticks).toBe(0);
    expect(paused).toBe(true);
    expect(live()?.status).toBe('paused');
    expect(live()?.autoUnstick?.attempt).toBe(2);

    if (live()?.status === 'running') await coordinator.cancelLoop(restored.id);
  }, 15_000);

  it('broadcasts a recovered streak so checkpoint persistence cannot restore a stale cap', async () => {
    writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
    let invocation = 0;
    let autoUnsticks = 0;
    const broadcasts: Array<{
      status: LoopState['status'];
      totalIterations: number;
      attempt: number | undefined;
    }> = [];
    coordinator.on('loop:auto-unstick', () => { autoUnsticks++; });
    coordinator.on('loop:state-changed', (payload: unknown) => {
      const snapshot = (payload as { state: LoopState }).state;
      broadcasts.push({
        status: snapshot.status,
        totalIterations: snapshot.totalIterations,
        attempt: snapshot.autoUnstick?.attempt,
      });
    });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      const result = invocation++ < 2 ? repeatedEdit() : progressingEdit();
      queueMicrotask(() => p.callback(result));
    });

    const base = defaultLoopConfig(workspace, 'do the thing');
    const state = await coordinator.startLoop('chat-auto-unstick-reset', {
      initialPrompt: 'do the thing',
      workspaceCwd: workspace,
      completion: { ...base.completion, verifyCommand: passingVerifyCommand() },
      caps: { ...base.caps, maxCostCents: 100, maxWallTimeMs: 60_000 },
      progressThresholds: {
        ...base.progressThresholds,
        toolRepeatCriticalPerIteration: 8,
      },
    });

    for (let i = 0; i < 240 && (coordinator.getLoop(state.id)?.totalIterations ?? 0) < 3; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(autoUnsticks).toBe(1);
    expect(broadcasts.some((snapshot) => (
      snapshot.status === 'running'
      && snapshot.totalIterations === 3
      && snapshot.attempt === undefined
    ))).toBe(true);

    if (coordinator.getLoop(state.id)?.status === 'running') {
      await coordinator.cancelLoop(state.id);
    }
  }, 15_000);

  it('clears a stale streak before a passing-verify fresh-eyes failure pauses the loop', async () => {
    writeFileSync(join(workspace, 'plan.md'), '# Plan\n');
    coordinator.setFreshEyesReviewer(async () => {
      throw new Error('synthetic reviewer crash');
    });

    const pausedBroadcastAttempts: Array<number | undefined> = [];
    coordinator.on('loop:state-changed', (payload: unknown) => {
      const snapshot = (payload as { state: LoopState }).state;
      if (snapshot.status === 'paused') {
        pausedBroadcastAttempts.push(snapshot.autoUnstick?.attempt);
      }
    });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as {
        callback: (r: LoopChildResult) => void;
        loopRunId: string;
        workspaceCwd: string;
      };
      const internals = coordinator as unknown as {
        active: Map<string, LoopState>;
        completionContext: { setAutoUnstickCount: (loopRunId: string, count: number) => void };
      };
      const live = internals.active.get(p.loopRunId);
      if (live) {
        live.autoUnstick = { seq: 1, attempt: 2, max: 2, signalId: 'G' };
        internals.completionContext.setAutoUnstickCount(p.loopRunId, 2);
      }
      const paths = resolveLoopArtifactPaths(p.workspaceCwd, p.loopRunId);
      mkdirSync(paths.dir, { recursive: true });
      writeFileSync(loopStateFile(paths, 'DONE.txt'), 'done\n');
      writeFileSync(join(workspace, 'plan_completed.md'), '# Done\n');
      queueMicrotask(() => p.callback(completedEdit()));
    });

    const base = defaultLoopConfig(workspace, 'implement plan.md');
    const state = await coordinator.startLoop('chat-auto-unstick-review-failure', {
      initialPrompt: 'implement plan.md',
      workspaceCwd: workspace,
      caps: { ...base.caps, maxIterations: 1, maxWallTimeMs: 60_000, maxCostCents: 100 },
      completion: {
        ...base.completion,
        verifyCommand: passingVerifyCommand(),
        runVerifyTwice: false,
        crossModelReview: {
          enabled: true,
          blockingSeverities: ['critical', 'high'],
          timeoutSeconds: 10,
          reviewDepth: 'structured',
        },
      },
    });

    for (let i = 0; i < 400 && coordinator.getLoop(state.id)?.status === 'running'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const paused = coordinator.getLoop(state.id);
    expect(paused?.status).toBe('paused');
    expect(paused?.lastIteration?.verifyStatus).toBe('passed');
    expect(paused?.autoUnstick).toBeUndefined();
    expect(pausedBroadcastAttempts).toContain(undefined);
  }, 15_000);
});
