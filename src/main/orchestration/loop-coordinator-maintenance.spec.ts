import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import type { LoopStageMachine } from './loop-stage-machine';

type LoopExecution = (state: LoopState, stageMachine: LoopStageMachine) => Promise<void>;

describe('LoopCoordinator maintenance gate', () => {
  let workspace: string;
  let coordinator: LoopCoordinator;
  let execution: MockInstance<LoopExecution>;

  beforeEach(() => {
    LoopCoordinator._resetForTesting();
    workspace = mkdtempSync(join(tmpdir(), 'loop-maintenance-gate-'));
    writeFileSync(join(workspace, 'package.json'), '{"scripts":{"test":"true"}}\n');
    coordinator = new LoopCoordinator();
    // Cancellation changes state immediately; the running iteration still has
    // asynchronous writes to finish before its workspace can be removed.
    execution = vi.spyOn(coordinator as unknown as { runLoop: LoopExecution }, 'runLoop');
  });

  afterEach(async () => {
    coordinator.setMaintenanceGate(null);
    for (const loop of coordinator.getActiveLoops()) {
      await coordinator.cancelLoop(loop.id).catch(() => undefined);
    }
    for (const result of execution.mock.results) {
      if (result.type === 'return') await result.value;
    }
    execution.mockRestore();
    rmSync(workspace, { recursive: true, force: true });
    LoopCoordinator._resetForTesting();
  });

  it('does not invoke a child while maintenance is active and proceeds after release', async () => {
    let maintenanceActive = true;
    let invocations = 0;
    coordinator.setMaintenanceGate(() => maintenanceActive);
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const event = payload as { callback: (result: LoopChildResult) => void };
      invocations += 1;
      event.callback({
        childInstanceId: 'child-1',
        output: 'work complete',
        tokens: 1,
        filesChanged: [],
        toolCalls: [],
        errors: [],
        testPassCount: null,
        testFailCount: null,
        exitedCleanly: true,
      });
    });

    const state = await coordinator.startLoop('chat-maintenance', {
      ...defaultLoopConfig(workspace, 'finish work'),
      caps: { ...defaultLoopConfig(workspace, 'finish work').caps, maxIterations: 1 },
      completion: {
        ...defaultLoopConfig(workspace, 'finish work').completion,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(invocations).toBe(0);
    expect(coordinator.getLoop(state.id)?.status).toBe('running');

    maintenanceActive = false;
    await vi.waitFor(() => expect(invocations).toBe(1));
  });
});
