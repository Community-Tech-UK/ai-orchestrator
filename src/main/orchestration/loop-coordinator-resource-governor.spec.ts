import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { defaultLoopConfig, type ProgressSignalEvidence } from '../../shared/types/loop.types';

describe('LoopCoordinator resource governor', () => {
  let workspace: string;
  let coordinator: LoopCoordinator;

  beforeEach(() => {
    LoopCoordinator._resetForTesting();
    workspace = mkdtempSync(join(tmpdir(), 'loop-resource-governor-'));
    writeFileSync(join(workspace, 'package.json'), '{"scripts":{"test":"true"}}\n');
    coordinator = new LoopCoordinator();
  });

  afterEach(async () => {
    for (const loop of coordinator.getActiveLoops()) {
      await coordinator.cancelLoop(loop.id).catch(() => undefined);
    }
    rmSync(workspace, { recursive: true, force: true });
    LoopCoordinator._resetForTesting();
  });

  it('pauses before starting the next iteration when the resource governor returns pause-loop', async () => {
    let invocations = 0;
    const paused = new Promise<{ signal: ProgressSignalEvidence }>((resolve) => {
      coordinator.on('loop:paused-no-progress', (payload) => resolve(payload as { signal: ProgressSignalEvidence }));
    });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (result: LoopChildResult) => void };
      invocations++;
      p.callback({
        childInstanceId: `child-${invocations}`,
        output: 'still working',
        tokens: 1,
        filesChanged: [],
        toolCalls: [],
        errors: [],
        testPassCount: null,
        testFailCount: null,
        exitedCleanly: true,
      });
    });
    coordinator.setResourceGovernor((state) => state.totalIterations > 0
      ? { level: 'critical', actions: ['pause-loop'], reasons: ['rss-above-critical'] }
      : null);

    const state = await coordinator.startLoop('chat-resource', {
      ...defaultLoopConfig(workspace, 'finish the work'),
      caps: { ...defaultLoopConfig(workspace, 'finish the work').caps, maxIterations: 4 },
      completion: { ...defaultLoopConfig(workspace, 'finish the work').completion },
    });

    const pausedPayload = await paused;

    expect(invocations).toBe(1);
    expect(coordinator.getLoop(state.id)?.status).toBe('paused');
    expect(pausedPayload.signal).toMatchObject({
      id: 'BLOCKED',
      verdict: 'CRITICAL',
      message: 'Paused by resource governor: rss-above-critical',
    });
  });
});
