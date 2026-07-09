import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { buildLoopCheckpoint } from './loop-checkpoint';
import { resolveLoopArtifactPaths } from './loop-artifact-paths';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';

describe('LoopCoordinator checkpoint restore', () => {
  let coordinator: LoopCoordinator;
  let workspace: string;

  beforeEach(() => {
    LoopCoordinator._resetForTesting();
    coordinator = new LoopCoordinator();
    workspace = mkdtempSync(join(tmpdir(), 'loop-restore-'));
  });

  afterEach(async () => {
    for (const loop of coordinator.getActiveLoops()) {
      await coordinator.cancelLoop(loop.id).catch(() => undefined);
    }
    rmSync(workspace, { recursive: true, force: true });
    LoopCoordinator._resetForTesting();
  }, 20_000);

  function pausedState(status: 'paused' | 'provider-limit' = 'paused'): LoopState {
    return {
      id: 'loop-restore-1',
      chatId: 'chat-restore',
      config: defaultLoopConfig(workspace, 'goal'),
      status,
      startedAt: Date.now(),
      endedAt: null,
      totalIterations: 3,
      totalTokens: 100,
      totalCostCents: 0,
      currentStage: 'IMPLEMENT',
      // Legacy checkpoints stored this queue as raw strings (coerced on restore);
      // Task 18: a structured follow-up with a drainMode must survive restore too.
      pendingInterventions: [
        'remember this',
        { id: 'p-followup', kind: 'follow-up', message: 'run before finishing', enqueuedAt: 1, source: 'human', drainMode: 'one-at-a-time' },
      ] as unknown as LoopState['pendingInterventions'],
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
    };
  }

  it('captures and persists a repo baseline when a loop starts', async () => {
    coordinator.on('loop:invoke-iteration', () => { /* keep the loop live until after assertion */ });

    const state = await coordinator.startLoop('chat-baseline', {
      initialPrompt: 'inspect baseline',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 1 },
    });
    const baselinePath = resolveLoopArtifactPaths(workspace, state.id).repoBaseline;

    expect(state.repoBaseline?.workspaceCwd).toBe(workspace);
    expect(existsSync(baselinePath)).toBe(true);
    expect(JSON.parse(readFileSync(baselinePath, 'utf8'))).toMatchObject({
      source: state.repoBaseline?.source,
      workspaceCwd: workspace,
    });
    await coordinator.cancelLoop(state.id);
  }, 15_000);

  it('restores a paused loop without auto-running it', async () => {
    let invocations = 0;
    const invoked = new Promise<void>((resolve) => {
      coordinator.on('loop:invoke-iteration', (payload: unknown) => {
        const p = payload as { callback: (result: LoopChildResult) => void };
        invocations++;
        resolve();
        queueMicrotask(() => {
          p.callback({
            childInstanceId: 'child-restored',
            output: 'restored loop kept working',
            tokens: 1,
            costCents: 0,
            filesChanged: [{ path: 'src/restored.ts', contentHash: 'restored-1' }],
            toolCalls: [],
            errors: [],
            verify: { status: 'passed', output: 'ok' },
          });
        });
      });
    });
    const restored = await coordinator.restoreLoopFromCheckpoint(buildLoopCheckpoint({
      state: pausedState(),
      history: [],
      convergenceNote: 'verify failed',
      planRegenerationCount: 1,
      pendingContextReset: true,
      now: 500,
    }));

    try {
      expect(restored.status).toBe('paused');
      const restoredQueue = coordinator.getLoop('loop-restore-1')?.pendingInterventions ?? [];
      expect(restoredQueue.map((item) => item.message)).toEqual(['remember this', 'run before finishing']);
      // Task 18: the follow-up's kind + drainMode survived the checkpoint round-trip.
      const followUp = restoredQueue.find((i) => i.message === 'run before finishing');
      expect(followUp?.kind).toBe('follow-up');
      expect(followUp?.drainMode).toBe('one-at-a-time');
      expect(coordinator.resumeLoop('loop-restore-1')).toBe(true);
      expect(coordinator.getLoop('loop-restore-1')?.status).toBe('running');
      await invoked;
      expect(invocations).toBe(1);
    } finally {
      await coordinator.cancelLoop(restored.id);
    }
  }, 15_000);

  it('materializes audit defaults when restoring a legacy checkpoint without audit config', async () => {
    const legacy = pausedState();
    const legacyConfig = { ...legacy.config } as Partial<LoopState['config']>;
    delete legacyConfig.audit;
    legacy.config = legacyConfig as LoopState['config'];

    const restored = await coordinator.restoreLoopFromCheckpoint(buildLoopCheckpoint({
      state: legacy,
      history: [],
      convergenceNote: 'legacy paused checkpoint',
      now: 500,
    }));

    expect(restored.config.audit).toEqual(defaultLoopConfig(workspace, 'goal').audit);
  });

  it('treats a running checkpoint as an interrupted paused loop on restore', async () => {
    const interrupted = {
      ...pausedState(),
      status: 'running' as const,
      inFlightIteration: {
        seq: 3,
        stage: 'IMPLEMENT' as const,
        startedAt: 1_700_000_000_000,
        idempotencyKey: 'loop-restore-1:iteration:3',
      },
    };

    const restored = await coordinator.restoreLoopFromCheckpoint(buildLoopCheckpoint({
      state: interrupted,
      history: [],
      convergenceNote: 'app restarted mid-iteration',
      now: 500,
    }));

    expect(restored.status).toBe('paused');
    expect(restored.inFlightIteration).toEqual(interrupted.inFlightIteration);
    expect(coordinator.getLoop('loop-restore-1')?.status).toBe('paused');
  });

  // P2 / Decision D fail-closed on restore: an isolated loop whose worktree is
  // gone (crash + manual cleanup, or executionCwd never persisted) must surface
  // a block rather than silently restoring against the shared repo root. A
  // silent fallback recreates the exact collision/data-loss class isolation is
  // meant to prevent.
  function isolatedPausedState(over: Partial<LoopState['config']> = {}): LoopState {
    const base = pausedState();
    return {
      ...base,
      config: {
        ...base.config,
        isolateLoopWorkspaces: true,
        ...over,
      },
    };
  }

  it('rejects restore + writes BLOCKED.md when isolated loop has no executionCwd (fail-closed)', async () => {
    const state = isolatedPausedState({ executionCwd: undefined });

    await expect(
      coordinator.restoreLoopFromCheckpoint(buildLoopCheckpoint({ state, history: [], now: 500 })),
    ).rejects.toThrow('isolateLoopWorkspaces: worktree missing on restore (fail-closed)');

    // It must NOT have been restored into the active set under the shared root.
    expect(coordinator.getLoop(state.id)).toBeUndefined();

    // A BLOCKED.md is written to the loop's (root-anchored) artifact dir so the
    // operator can diagnose the missing worktree.
    const blockedPath = resolveLoopArtifactPaths(state.config.workspaceCwd, state.id).blocked;
    expect(existsSync(blockedPath)).toBe(true);
    expect(readFileSync(blockedPath, 'utf-8')).toContain('Worktree Missing on Restore');
  });

  it('rejects restore when the isolated worktree path no longer exists on disk (fail-closed)', async () => {
    const ghostWorktree = join(workspace, '.worktrees', 'task-ghost-deadbeef');
    const state = isolatedPausedState({ executionCwd: ghostWorktree });

    await expect(
      coordinator.restoreLoopFromCheckpoint(buildLoopCheckpoint({ state, history: [], now: 500 })),
    ).rejects.toThrow('isolateLoopWorkspaces: worktree missing on restore (fail-closed)');

    expect(coordinator.getLoop(state.id)).toBeUndefined();
    const blockedPath = resolveLoopArtifactPaths(state.config.workspaceCwd, state.id).blocked;
    expect(existsSync(blockedPath)).toBe(true);
    expect(readFileSync(blockedPath, 'utf-8')).toContain(ghostWorktree);
  });

  it('restores and manually resumes a provider-limit checkpoint', async () => {
    let invocations = 0;
    const invoked = new Promise<void>((resolve) => {
      coordinator.on('loop:invoke-iteration', (payload: unknown) => {
        const p = payload as { callback: (result: LoopChildResult) => void };
        invocations++;
        resolve();
        queueMicrotask(() => {
          p.callback({
            childInstanceId: 'child-provider-limit',
            output: 'provider-limit checkpoint resumed',
            tokens: 1,
            costCents: 0,
            filesChanged: [{ path: 'src/resumed.ts', contentHash: 'resumed-1' }],
            toolCalls: [],
            errors: [],
            verify: { status: 'passed', output: 'ok' },
          });
        });
      });
    });
    const restored = await coordinator.restoreLoopFromCheckpoint(buildLoopCheckpoint({
      state: pausedState('provider-limit'),
      history: [],
      convergenceNote: 'provider window exhausted',
      now: 500,
    }));

    try {
      expect(restored.status).toBe('provider-limit');
      expect(coordinator.resumeLoop('loop-restore-1')).toBe(true);
      expect(coordinator.getLoop('loop-restore-1')?.status).toBe('running');
      await invoked;
      expect(invocations).toBe(1);
    } finally {
      await coordinator.cancelLoop(restored.id);
    }
  }, 15_000);

  it('allows cancelling a restored provider-limit checkpoint before resume', async () => {
    await coordinator.restoreLoopFromCheckpoint(buildLoopCheckpoint({
      state: pausedState('provider-limit'),
      history: [],
      convergenceNote: 'provider window exhausted',
      now: 500,
    }));

    await expect(coordinator.cancelLoop('loop-restore-1')).resolves.toBe(true);
    expect(coordinator.getLoop('loop-restore-1')?.status).toBe('cancelled');
  });

  it('treats a restored provider-limit checkpoint as active for same-chat starts', async () => {
    await coordinator.restoreLoopFromCheckpoint(buildLoopCheckpoint({
      state: pausedState('provider-limit'),
      history: [],
      convergenceNote: 'provider window exhausted',
      now: 500,
    }));

    await expect(
      coordinator.startLoop('chat-restore', {
        initialPrompt: 'another loop',
        workspaceCwd: workspace,
      }),
    ).rejects.toThrow('A loop is already provider-limit for this chat');
  });

  it('rejects terminal provider-limit checkpoints instead of restoring them as resumable', async () => {
    const state = {
      ...pausedState('provider-limit'),
      endedAt: Date.now(),
      endReason: 'provider limit reached without a reset window',
    };

    await expect(
      coordinator.restoreLoopFromCheckpoint(buildLoopCheckpoint({
        state,
        history: [],
        convergenceNote: 'provider window exhausted',
        now: 500,
      })),
    ).rejects.toThrow('Cannot restore terminal provider-limit loop checkpoint');

    expect(coordinator.getLoop(state.id)).toBeUndefined();
  });
});
