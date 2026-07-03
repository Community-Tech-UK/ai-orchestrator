import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import type { LoopContextSurvivalManager } from './loop-context-survival';
import { loopStateFile, resolveLoopArtifactPaths } from './loop-artifact-paths';
import { passingVerifyCommand } from './loop-test-commands';

function childResult(seq: number): LoopChildResult {
  return {
    childInstanceId: null,
    output: `progress ${seq}`,
    tokens: 1,
    filesChanged: [{ path: `src/progress-${seq}.ts`, additions: 1, deletions: 0, contentHash: `hash-${seq}` }],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
  };
}

function announceOnlyResult(output: string): LoopChildResult {
  return {
    childInstanceId: null,
    output,
    tokens: 1,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
  };
}

describe('LoopCoordinator context survival manager', () => {
  let coordinator: LoopCoordinator;
  let workspace: string;

  beforeEach(() => {
    LoopCoordinator._resetForTesting();
    coordinator = new LoopCoordinator();
    workspace = mkdtempSync(join(tmpdir(), 'loop-context-survival-'));
  });

  afterEach(async () => {
    for (const loop of coordinator.getActiveLoops()) {
      await coordinator.cancelLoop(loop.id).catch(() => undefined);
    }
    rmSync(workspace, { recursive: true, force: true });
    LoopCoordinator._resetForTesting();
  });

  it('applies force-reset and nudge decisions to the next iteration boundary', async () => {
    const manager: LoopContextSurvivalManager = {
      async onIterationSealed() {
        return {
          action: 'fresh-window',
          forceContextReset: true,
          nudge: 'Context budget is still healthy; keep implementing instead of stopping.',
          reason: 'test decision',
        };
      },
    };
    coordinator.setContextSurvivalManager(manager);

    const seqOneInvoked = new Promise<{ forceContextReset: boolean; prompt: string }>((resolve) => {
      coordinator.on('loop:invoke-iteration', (payload: unknown) => {
        const p = payload as {
          seq: number;
          prompt: string;
          forceContextReset?: boolean;
          callback: (result: LoopChildResult) => void;
        };
        if (p.seq === 1) {
          resolve({ forceContextReset: !!p.forceContextReset, prompt: p.prompt });
        }
        queueMicrotask(() => p.callback(childResult(p.seq)));
      });
    });

    const config = defaultLoopConfig(workspace, 'make progress twice');
    config.caps.maxIterations = 2;
    config.caps.maxWallTimeMs = 60_000;
    config.caps.maxCostCents = 100;
    config.completion.verifyCommand = '';

    const state = await coordinator.startLoop('chat-context-survival', config);
    const seqOne = await seqOneInvoked;
    await coordinator.cancelLoop(state.id);

    expect(seqOne.forceContextReset).toBe(true);
    expect(seqOne.prompt).toContain('Context budget is still healthy');
  });

  it('does not queue a next-iteration nudge when the iteration is accepted as terminal', async () => {
    let managerCalls = 0;
    const manager: LoopContextSurvivalManager = {
      async onIterationSealed() {
        managerCalls++;
        return {
          action: 'fresh-window',
          forceContextReset: true,
          nudge: 'This should not be queued after terminal completion.',
          reason: 'test terminal decision',
        };
      },
    };
    coordinator.setContextSurvivalManager(manager);

    const completed = new Promise<void>((resolve) => {
      coordinator.on('loop:completed', () => resolve());
    });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as {
        loopRunId: string;
        workspaceCwd: string;
        callback: (result: LoopChildResult) => void;
      };
      const paths = resolveLoopArtifactPaths(p.workspaceCwd, p.loopRunId);
      mkdirSync(paths.dir, { recursive: true });
      writeFileSync(loopStateFile(paths, 'DONE.txt'), 'done\n');
      queueMicrotask(() => p.callback(childResult(0)));
    });

    const config = defaultLoopConfig(workspace, 'finish once');
    config.caps.maxIterations = 3;
    config.caps.maxWallTimeMs = 60_000;
    config.caps.maxCostCents = 100;
    config.completion.verifyCommand = passingVerifyCommand();
    config.completion.runVerifyTwice = false;

    const state = await coordinator.startLoop('chat-context-survival-terminal', config);
    await completed;

    expect(managerCalls).toBe(0);
    expect(coordinator.getLoop(state.id)?.pendingInterventions).toEqual([]);
  });

  it('queues a continuation prompt when an IMPLEMENT iteration only announces the next action', async () => {
    const seqOneInvoked = new Promise<{ prompt: string }>((resolve) => {
      coordinator.on('loop:invoke-iteration', (payload: unknown) => {
        const p = payload as {
          seq: number;
          prompt: string;
          callback: (result: LoopChildResult) => void;
        };
        if (p.seq === 0) {
          queueMicrotask(() => p.callback(announceOnlyResult("I'll now run the focused tests.")));
          return;
        }
        if (p.seq === 1) {
          resolve({ prompt: p.prompt });
        }
        queueMicrotask(() => p.callback(childResult(p.seq)));
      });
    });

    const config = defaultLoopConfig(workspace, 'make progress after announcing it');
    config.caps.maxIterations = 2;
    config.caps.maxWallTimeMs = 60_000;
    config.caps.maxCostCents = 100;
    config.completion.verifyCommand = '';

    const state = await coordinator.startLoop('chat-announce-then-halt', config);
    const seqOne = await seqOneInvoked;
    await coordinator.cancelLoop(state.id);

    expect(seqOne.prompt).toContain('Continue now');
    expect(seqOne.prompt).toContain('run the focused tests');
    expect(coordinator.getLoop(state.id)?.announceThenHaltNudgeCount).toBe(1);
  });
});
