import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { defaultLoopConfig } from '../../shared/types/loop.types';

let workspace: string;
let coordinator: LoopCoordinator;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-next-objective-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  coordinator = new LoopCoordinator();
});

afterEach(() => {
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

function iterationResult(output: string): LoopChildResult {
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

function waitForCondition(fn: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fn()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('condition timed out'));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('LoopCoordinator next-objective planner', () => {
  it('injects planner output into the next prompt only while the loop continues', async () => {
    const prompts: string[] = [];
    const plannerCalls: Array<{ lastOutput: string; originalGoal: string; seq: number }> = [];
    let invokeCount = 0;

    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { prompt: string; callback: (result: LoopChildResult) => void };
      prompts.push(p.prompt);
      invokeCount += 1;
      queueMicrotask(() => {
        p.callback(iterationResult(invokeCount === 1 ? 'first iteration output' : 'second iteration output'));
      });
    });

    const state = await coordinator.startLoop('chat-next-objective', {
      initialPrompt: 'Original pinned goal',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 2 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: '',
        requireCompletedFileRename: false,
        crossModelReview: { enabled: false, blockingSeverities: ['critical'], timeoutSeconds: 10, reviewDepth: 'structured' },
      },
      nextObjectivePlanner: async (ctx) => {
        plannerCalls.push(ctx);
        return `Next focus from seq ${ctx.seq}: inspect retry path`;
      },
    });

    try {
      await waitForCondition(() => coordinator.getLoop(state.id)?.status === 'cap-reached', 8000);
      expect(plannerCalls).toHaveLength(1);
      expect(plannerCalls[0]).toEqual({
        lastOutput: 'first iteration output',
        originalGoal: 'Original pinned goal',
        seq: 0,
      });
      expect(prompts[1]).toContain('Next focus from seq 0: inspect retry path');
    } finally {
      await coordinator.cancelLoop(state.id);
    }
  }, 10_000);

  it('does not retain a runtime planner when loop startup fails', async () => {
    const planner = async () => 'next focus';
    const invalidWorkspace = `${workspace}\0bad`;

    await expect(coordinator.startLoop('chat-next-objective-fail', {
      initialPrompt: 'Original pinned goal',
      workspaceCwd: invalidWorkspace,
      nextObjectivePlanner: planner,
    })).rejects.toThrow();

    const internals = coordinator as unknown as {
      nextObjectivePlanners: Map<string, unknown>;
    };
    expect(internals.nextObjectivePlanners.size).toBe(0);
  });
});
