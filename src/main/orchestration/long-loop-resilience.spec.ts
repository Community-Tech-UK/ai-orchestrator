import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { passingVerifyCommand } from './loop-test-commands';
import { defaultLoopConfig } from '../../shared/types/loop.types';

describe('long-loop resilience', () => {
  let workspace: string;
  let coordinator: LoopCoordinator;

  beforeEach(() => {
    LoopCoordinator._resetForTesting();
    workspace = mkdtempSync(join(tmpdir(), 'long-loop-resilience-'));
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ scripts: { test: passingVerifyCommand() } }));
    writeFileSync(join(workspace, 'plan.md'), '# Plan\n- [ ] Finish the work\n');
    coordinator = new LoopCoordinator();
  });

  afterEach(async () => {
    for (const loop of coordinator.getActiveLoops()) {
      await coordinator.cancelLoop(loop.id).catch(() => undefined);
    }
    rmSync(workspace, { recursive: true, force: true });
    LoopCoordinator._resetForTesting();
  });

  it('continues loop iterations when optional context and codemem workers are degraded', async () => {
    let invocations = 0;
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (result: LoopChildResult) => void };
      invocations++;
      if (invocations === 3) {
        renameSync(join(workspace, 'plan.md'), join(workspace, 'plan_completed.md'));
      }
      queueMicrotask(() => {
        p.callback({
          childInstanceId: `child-${invocations}`,
          output: invocations < 3 ? 'still working' : '<promise>DONE</promise>\nTASK COMPLETE',
          tokens: 1,
          costCents: 0,
          filesChanged: [{ path: 'src/progress.ts', contentHash: `hash-${invocations}` }],
          toolCalls: [],
          errors: [],
          verify: { status: 'passed', output: 'ok' },
        });
      });
    });

    const completed = new Promise<void>((resolve) => coordinator.on('loop:completed', () => resolve()));
    const state = await coordinator.startLoop('chat-long', {
      ...defaultLoopConfig(workspace, 'finish the work'),
      planFile: 'plan.md',
      caps: { ...defaultLoopConfig(workspace, 'finish the work').caps, maxIterations: 4 },
      completion: {
        ...defaultLoopConfig(workspace, 'finish the work').completion,
        verifyCommand: passingVerifyCommand(),
        runVerifyTwice: false,
        requireCompletedFileRename: false,
      },
    });

    await completed;
    expect(coordinator.getLoop(state.id)?.status).toBe('completed');
    expect(invocations).toBeGreaterThanOrEqual(3);
  }, 15_000);
});
