/**
 * LF-6 (loopfixex.md) — coordinator wiring for cross-loop memory: prior
 * observations surfaced at start are injected into the prompt, and a learning
 * is recorded when the loop terminates.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

// LT-29x test setup: the real SettingsManager (`conf` under the hood) throws
// "Please specify the `projectName` option" outside a real Electron app
// context, which was silently swallowing `assemblePlanStageContext` in EVERY
// test in this file before this mock (pre-existing environment limitation,
// not introduced by the LT-29x fix) — the LF-6 test above never depended on
// that block, so it never surfaced. Only the lessons-surface test below
// exercises `loop-coordinator.ts`'s one call site for `getSettingsManager()`.
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({ loopSurfaceLessons: true, codememEnabled: false, loopSurfaceCodemem: true }),
  }),
}));
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { passingVerifyCommand } from './loop-test-commands';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import type { LoopMemoryStore } from './loop-memory';
import { getLessonStore, _resetLessonStoreForTesting } from '../memory/lesson-store';
import {
  getRecallTraceStore,
  _resetRecallTraceStoreForTesting,
} from '../memory/retrieval-eval/recall-trace-store';

let workspace: string;
let coordinator: LoopCoordinator;

/**
 * Poll until `predicate` holds or the deadline passes. Deliberately does not
 * throw: the caller keeps its own assertion, so a real wiring break still
 * reports the specific expectation that failed rather than a generic timeout.
 */
async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

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
      completion: { ...defaultLoopConfig(workspace, 'x').completion, verifyCommand: passingVerifyCommand() },
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxCostCents: 100, maxWallTimeMs: 60_000 },
    });

    // surfaceLearnings was consulted at start
    expect(stubStore.surfaceLearnings).toHaveBeenCalledWith(workspace, 3);

    // Wait for the first iteration to capture the prompt. The old budget here
    // was a fixed 60 × 25ms = 1.5s, and assembling the first iteration prompt
    // (lessons/codemem surfacing, stage context, session replay) already costs
    // ~0.7s on an idle dev Mac — so a shared CI runner running several vitest
    // forks blew straight through it and this test was a permanently red CI
    // shard. Wait on the condition with real headroom instead of a fixed tick
    // count; a genuine wiring break still fails, just at the deadline. The
    // explicit 30s test timeout below has to clear this wait plus teardown —
    // vitest's 5s default would abort the wait before it could ever succeed.
    await waitForCondition(() => capturedPrompt !== null, 15_000);
    expect(capturedPrompt).not.toBeNull();
    expect(capturedPrompt!).toContain('verify kept failing');
    expect(capturedPrompt!).toMatch(/Prior Context \(advisory, untrusted\)|Prior Observations \(not binding\)/);

    await coordinator.cancelLoop(state.id);
    // a learning is distilled + recorded on the terminal transition
    expect(recordLearning).toHaveBeenCalled();
    const rec = recordLearning.mock.calls[0][0] as { workspaceCwd: string; status: string };
    expect(rec.workspaceCwd).toBe(workspace);
    expect(rec.status).toBe('cancelled');
  }, 30_000);

  // LT-29x (fable-ws16 livetest, checks 5/lessons + 6): before this fix,
  // nothing in production ever called `getRecallTraceStore().record({surface:
  // 'lessons', …})`, so the 'lessons' surface could never hold a trace and
  // `creditSurfacedLessonUse`'s later `markUsed('lessons', …)` could never
  // credit anything, however the loop terminated.
  it('LT-29x: records a recall trace on the lessons surface when a lesson is surfaced at loop start', async () => {
    _resetLessonStoreForTesting();
    _resetRecallTraceStoreForTesting();
    const { lesson } = getLessonStore().capture('Always pass --port for a custom Electron debug port.');

    const stubStore: LoopMemoryStore = {
      recordLearning: vi.fn(),
      surfaceLearnings: vi.fn(() => []),
    };
    coordinator.setLoopMemoryStore(stubStore);
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      queueMicrotask(() => p.callback({
        childInstanceId: null, output: 'working', tokens: 1, filesChanged: [],
        toolCalls: [], errors: [], testPassCount: null, testFailCount: null, exitedCleanly: true,
      }));
    });

    const state = await coordinator.startLoop('lessons-trace', {
      initialPrompt: 'do the thing',
      workspaceCwd: workspace,
      completion: { ...defaultLoopConfig(workspace, 'x').completion, verifyCommand: passingVerifyCommand() },
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxCostCents: 100, maxWallTimeMs: 60_000 },
    });

    const traces = getRecallTraceStore().bySurface('lessons');
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0].returned.some((r) => r.id === lesson.id)).toBe(true);

    await coordinator.cancelLoop(state.id);
    _resetLessonStoreForTesting();
    _resetRecallTraceStoreForTesting();
  });
});
