import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { buildLoopCheckpoint } from './loop-checkpoint';
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
  });

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
      pendingInterventions: ['remember this'],
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

    expect(restored.status).toBe('paused');
    expect(coordinator.getLoop('loop-restore-1')?.pendingInterventions).toEqual(['remember this']);
    expect(coordinator.resumeLoop('loop-restore-1')).toBe(true);
    expect(coordinator.getLoop('loop-restore-1')?.status).toBe('running');
    await invoked;
    expect(invocations).toBe(1);
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

    expect(restored.status).toBe('provider-limit');
    expect(coordinator.resumeLoop('loop-restore-1')).toBe(true);
    expect(coordinator.getLoop('loop-restore-1')?.status).toBe('running');
    await invoked;
    expect(invocations).toBe(1);
  });
});
