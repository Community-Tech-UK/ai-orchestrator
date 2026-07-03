/**
 * LF-4 RPI (loopfixex.md) — PLAN→IMPLEMENT context reset + disposable-plan
 * regenerate-on-stall.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { resolveLoopArtifactPaths, loopStateFile } from './loop-artifact-paths';
import { passingVerifyCommand } from './loop-test-commands';
import { defaultLoopConfig, LOOP_MAX_PLAN_REGENERATIONS } from '../../shared/types/loop.types';

/** Write a loop-state file into the run's per-run state dir (.aio-loop-state/<runId>/). */
function writeRunState(payload: unknown, name: string, content: string): void {
  const p = payload as { loopRunId: string; workspaceCwd: string };
  const paths = resolveLoopArtifactPaths(p.workspaceCwd, p.loopRunId);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(loopStateFile(paths, name), content);
}

let workspace: string;
let coordinator: LoopCoordinator;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-rpi-'));
  coordinator = new LoopCoordinator();
});

afterEach(async () => {
  for (const loop of coordinator.getActiveLoops()) {
    try { await coordinator.cancelLoop(loop.id); } catch { /* noop */ }
  }
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

function noOp(): LoopChildResult {
  return {
    childInstanceId: null, output: 'working', tokens: 1, filesChanged: [], toolCalls: [],
    errors: [], testPassCount: null, testFailCount: null, exitedCleanly: true,
  };
}

describe('LF-4 RPI — PLAN→IMPLEMENT context reset', () => {
  it('requests a context reset on the first IMPLEMENT iteration after PLAN', async () => {
    const resetFlags: boolean[] = [];
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { seq: number; forceContextReset?: boolean; callback: (r: LoopChildResult) => void };
      resetFlags[p.seq] = !!p.forceContextReset;
      // After the PLAN iteration, advance STAGE.md to IMPLEMENT (the agent owns
      // STAGE.md — written into the run's per-run state dir).
      if (p.seq === 0) writeRunState(payload, 'STAGE.md', 'IMPLEMENT\n');
      queueMicrotask(() => p.callback(noOp()));
    });

    const base = defaultLoopConfig(workspace, 'g');
    const state = await coordinator.startLoop('chat-rpi-reset', {
      initialPrompt: 'plan then implement',
      workspaceCwd: workspace,
      contextStrategy: 'same-session',
      initialStage: 'PLAN',
      completion: { ...base.completion, verifyCommand: passingVerifyCommand() },
      caps: { ...base.caps, maxCostCents: 100, maxWallTimeMs: 60_000 },
      // context discipline on (default) gates the reset
    });

    const live = () => (coordinator as unknown as { active: Map<string, unknown> }).active.get(state.id);
    for (let i = 0; i < 120 && resetFlags[1] === undefined && live(); i++) {
      await new Promise((r) => setTimeout(r, 25));
    }

    expect(resetFlags[0]).toBe(false);       // PLAN iteration — no reset
    expect(resetFlags[1]).toBe(true);        // first IMPLEMENT iteration — reset requested
  });
});

describe('LF-4 RPI — disposable plan regenerate-on-stall', () => {
  it('injects regeneration on stall (bounded), then pauses after the cap', async () => {
    writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
    let regenerations = 0;
    let paused = false;
    coordinator.on('loop:plan-regenerated', () => { regenerations++; });
    coordinator.on('loop:paused-no-progress', () => { paused = true; });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      queueMicrotask(() => p.callback(noOp())); // identical no-op → no-progress CRITICAL
    });

    const base = defaultLoopConfig(workspace, 'g');
    const state = await coordinator.startLoop('chat-rpi-regen', {
      initialPrompt: 'do the thing',
      workspaceCwd: workspace,
      completion: { ...base.completion, verifyCommand: passingVerifyCommand() },
      caps: { ...base.caps, maxCostCents: 100, maxWallTimeMs: 60_000 },
      plan: { regenerateOnStall: true },
      progressThresholds: { ...base.progressThresholds, identicalHashWarnConsecutive: 2, identicalHashCriticalConsecutive: 2 },
    });

    const live = () => (coordinator as unknown as { active: Map<string, { status: string }> }).active.get(state.id);
    for (let i = 0; i < 200 && !paused && live()?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (live()?.status === 'running') await coordinator.cancelLoop(state.id);

    // Regenerated up to the cap, then paused.
    expect(regenerations).toBe(LOOP_MAX_PLAN_REGENERATIONS);
    expect(paused).toBe(true);
  });

  it('does not regenerate when disabled (pauses on the first stall)', async () => {
    writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
    let regenerations = 0;
    let paused = false;
    coordinator.on('loop:plan-regenerated', () => { regenerations++; });
    coordinator.on('loop:paused-no-progress', () => { paused = true; });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      queueMicrotask(() => p.callback(noOp()));
    });

    const base = defaultLoopConfig(workspace, 'g');
    const state = await coordinator.startLoop('chat-rpi-noregen', {
      initialPrompt: 'do the thing',
      workspaceCwd: workspace,
      completion: { ...base.completion, verifyCommand: passingVerifyCommand() },
      caps: { ...base.caps, maxCostCents: 100, maxWallTimeMs: 60_000 },
      plan: { regenerateOnStall: false },
      progressThresholds: { ...base.progressThresholds, identicalHashWarnConsecutive: 2, identicalHashCriticalConsecutive: 2 },
    });

    const live = () => (coordinator as unknown as { active: Map<string, { status: string }> }).active.get(state.id);
    for (let i = 0; i < 120 && !paused && live()?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (live()?.status === 'running') await coordinator.cancelLoop(state.id);

    expect(regenerations).toBe(0);
    expect(paused).toBe(true);
  });
});
