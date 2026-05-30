/**
 * LF-6 (loopfixex.md) — coordinator wiring for cross-loop memory: prior
 * observations surfaced at start are injected into the prompt, and a learning
 * is recorded when the loop terminates.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import type { LoopMemoryStore } from './loop-memory';

let workspace: string;
let coordinator: LoopCoordinator;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-memory-coord-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  coordinator = new LoopCoordinator();
});

afterEach(async () => {
  for (const loop of coordinator.getActiveLoops()) {
    try { await coordinator.cancelLoop(loop.id); } catch { /* noop */ }
  }
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('LoopCoordinator cross-loop memory wiring (LF-6)', () => {
  it('injects surfaced prior observations into the iteration prompt and records a learning on terminate', async () => {
    const recordLearning = vi.fn();
    const stubStore: LoopMemoryStore = {
      recordLearning,
      surfaceLearnings: vi.fn(() => ['[cap-reached] goal "x" — verify kept failing · dead-end: broken regex']),
    };
    coordinator.setLoopMemoryStore(stubStore);

    let capturedPrompt: string | null = null;
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { prompt: string; callback: (r: LoopChildResult) => void };
      if (capturedPrompt === null) capturedPrompt = p.prompt;
      queueMicrotask(() => p.callback({
        childInstanceId: null, output: 'working', tokens: 1, filesChanged: [],
        toolCalls: [], errors: [], testPassCount: null, testFailCount: null, exitedCleanly: true,
      }));
    });

    const state = await coordinator.startLoop('chat-memory', {
      initialPrompt: 'do the thing',
      workspaceCwd: workspace,
      completion: { ...defaultLoopConfig(workspace, 'x').completion, verifyCommand: 'true' },
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxCostCents: 100, maxWallTimeMs: 60_000 },
    });

    // surfaceLearnings was consulted at start
    expect(stubStore.surfaceLearnings).toHaveBeenCalledWith(workspace, 3);

    // wait for the first iteration to capture the prompt
    for (let i = 0; i < 60 && capturedPrompt === null; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(capturedPrompt).not.toBeNull();
    expect(capturedPrompt!).toContain('Prior Observations (not binding)');
    expect(capturedPrompt!).toContain('verify kept failing');

    await coordinator.cancelLoop(state.id);
    // a learning is distilled + recorded on the terminal transition
    expect(recordLearning).toHaveBeenCalled();
    const rec = recordLearning.mock.calls[0][0] as { workspaceCwd: string; status: string };
    expect(rec.workspaceCwd).toBe(workspace);
    expect(rec.status).toBe('cancelled');
  });
});
