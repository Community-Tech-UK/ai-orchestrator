/**
 * Regression tests for the false-positive completion signals that terminated
 * loops on iteration 0 when the workspace already contained stale artefacts
 * from a prior run (a `*_Completed.md`, a `DONE.txt`, or a fully-ticked
 * `PLAN.md`).
 *
 * Behaviours guarded here:
 *   1. Pre-existing `*_Completed.md` files do NOT seed
 *      `state.completedFileRenameObserved`. Only an in-run rename does.
 *   2. When a `planFile` is configured and the caller does not explicitly set
 *      `completion.requireCompletedFileRename`, the materialised config
 *      defaults the belt-and-braces gate to ON.
 *   3. `state.doneSentinelPresentAtStart` reflects whether the sentinel
 *      already existed at boot, so the detector can distinguish stale vs
 *      in-run sentinels.
 *   4. `state.planChecklistFullyCheckedAtStart` reflects whether the planFile
 *      was already fully checked at boot.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { defaultLoopConfig } from '../../shared/types/loop.types';

let workspace: string;
let coordinator: LoopCoordinator;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-completion-seed-'));
  // Bootstrap a stage file so LoopStageMachine doesn't write one we have to
  // clean up; tests stay focused on the seeding behaviour.
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  coordinator = new LoopCoordinator();
  // Register a no-op invoker so runLoop has somewhere to dispatch — but we
  // immediately cancel after startLoop returns, before any iteration callback
  // fires. The point is to inspect the LoopState that `startLoop` produces.
  coordinator.on('loop:invoke-iteration', (payload: unknown) => {
    const p = payload as { callback: (result: LoopChildResult) => void };
    queueMicrotask(() => {
      p.callback({
        childInstanceId: null,
        output: 'ok',
        tokens: 1,
        filesChanged: [],
        toolCalls: [],
        errors: [],
        testPassCount: null,
        testFailCount: null,
        exitedCleanly: true,
      });
    });
  });
});

afterEach(() => {
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

describe('LoopCoordinator pre-existing *_Completed.md seeding', () => {
  it('does NOT set completedFileRenameObserved when a stale *_Completed.md exists at start', async () => {
    // Simulate the AI-orchestrator workspace situation: a prior plan file has
    // already been renamed in a previous session and committed.
    writeFileSync(join(workspace, 'plan_loop_mode_Completed.md'), '# Old completed plan\n');

    const state = await coordinator.startLoop('chat-stale', {
      initialPrompt: 'do something fresh',
      workspaceCwd: workspace,
    });

    try {
      expect(state.completedFileRenameObserved).toBe(false);
    } finally {
      coordinator.cancelLoop(state.id);
    }
  });

  it('still tolerates a workspace with no matching files (sanity)', async () => {
    const state = await coordinator.startLoop('chat-clean', {
      initialPrompt: 'do something fresh',
      workspaceCwd: workspace,
    });

    try {
      expect(state.completedFileRenameObserved).toBe(false);
    } finally {
      coordinator.cancelLoop(state.id);
    }
  });
});

describe('LoopCoordinator materializeConfig — requireCompletedFileRename default', () => {
  it('defaults requireCompletedFileRename=true when planFile is set and value omitted', async () => {
    const state = await coordinator.startLoop('chat-plan', {
      initialPrompt: 'work on the plan',
      workspaceCwd: workspace,
      planFile: 'PLAN.md',
    });

    try {
      expect(state.config.completion.requireCompletedFileRename).toBe(true);
    } finally {
      coordinator.cancelLoop(state.id);
    }
  });

  it('honours explicit requireCompletedFileRename=false even when planFile is set', async () => {
    const baseCompletion = defaultLoopConfig(workspace, 'x').completion;
    const state = await coordinator.startLoop('chat-plan-opt-out', {
      initialPrompt: 'work on the plan',
      workspaceCwd: workspace,
      planFile: 'PLAN.md',
      completion: { ...baseCompletion, requireCompletedFileRename: false },
    });

    try {
      expect(state.config.completion.requireCompletedFileRename).toBe(false);
    } finally {
      coordinator.cancelLoop(state.id);
    }
  });

  it('keeps requireCompletedFileRename=false when no planFile is configured', async () => {
    const state = await coordinator.startLoop('chat-no-plan', {
      initialPrompt: 'general continuation work',
      workspaceCwd: workspace,
    });

    try {
      expect(state.config.completion.requireCompletedFileRename).toBe(false);
    } finally {
      coordinator.cancelLoop(state.id);
    }
  });
});

describe('LoopCoordinator startup workspace snapshot', () => {
  it('LoopStageMachine.bootstrap deletes a pre-existing DONE.txt so the snapshot lands at false', async () => {
    // Bootstrap actively unlinks stale sentinels (see loop-stage-machine.ts).
    // The snapshot captured *after* bootstrap therefore lands at false even
    // when the test workspace had a leftover DONE.txt — that's the layered
    // defence working: bootstrap clears + snapshot agrees.
    writeFileSync(join(workspace, 'DONE.txt'), 'leftover\n');
    expect(existsSync(join(workspace, 'DONE.txt'))).toBe(true);

    const state = await coordinator.startLoop('chat-stale-sentinel', {
      initialPrompt: 'do something fresh',
      workspaceCwd: workspace,
    });

    try {
      expect(state.doneSentinelPresentAtStart).toBe(false);
      // Bootstrap should have removed the file:
      expect(existsSync(join(workspace, 'DONE.txt'))).toBe(false);
    } finally {
      coordinator.cancelLoop(state.id);
    }
  });

  it('records doneSentinelPresentAtStart=false when the workspace is clean', async () => {
    const state = await coordinator.startLoop('chat-clean-sentinel', {
      initialPrompt: 'do something fresh',
      workspaceCwd: workspace,
    });

    try {
      expect(state.doneSentinelPresentAtStart).toBe(false);
    } finally {
      coordinator.cancelLoop(state.id);
    }
  });

  it('records planChecklistFullyCheckedAtStart=true when PLAN.md is already fully ticked', async () => {
    writeFileSync(
      join(workspace, 'PLAN.md'),
      '# Plan\n\n- [x] one\n- [x] two\n- [x] three\n',
    );

    const state = await coordinator.startLoop('chat-full-plan', {
      initialPrompt: 'do something fresh',
      workspaceCwd: workspace,
      planFile: 'PLAN.md',
    });

    try {
      expect(state.planChecklistFullyCheckedAtStart).toBe(true);
    } finally {
      coordinator.cancelLoop(state.id);
    }
  });

  it('records planChecklistFullyCheckedAtStart=false when PLAN.md still has unchecked items', async () => {
    writeFileSync(
      join(workspace, 'PLAN.md'),
      '# Plan\n\n- [x] one\n- [ ] two\n- [x] three\n',
    );

    const state = await coordinator.startLoop('chat-partial-plan', {
      initialPrompt: 'do something fresh',
      workspaceCwd: workspace,
      planFile: 'PLAN.md',
    });

    try {
      expect(state.planChecklistFullyCheckedAtStart).toBe(false);
    } finally {
      coordinator.cancelLoop(state.id);
    }
  });

  it('records planChecklistFullyCheckedAtStart=false when no planFile is configured', async () => {
    const state = await coordinator.startLoop('chat-no-plan-snapshot', {
      initialPrompt: 'general continuation work',
      workspaceCwd: workspace,
    });

    try {
      expect(state.uncompletedPlanFilesAtStart).toEqual([]);
      expect(state.planChecklistFullyCheckedAtStart).toBe(false);
    } finally {
      coordinator.cancelLoop(state.id);
    }
  });
});

describe('LoopCoordinator auto-enables requireCompletedFileRename from uncompleted plan files', () => {
  it('flips requireCompletedFileRename to true when uncompleted plan .md files are present and the caller did not configure it', async () => {
    writeFileSync(join(workspace, 'claude-review.md'), '# review\n');
    writeFileSync(join(workspace, 'gemini-review.md'), '# review\n');

    const state = await coordinator.startLoop('chat-multi-plan-auto', {
      initialPrompt: 'implement all the review files',
      workspaceCwd: workspace,
    });

    try {
      expect(state.uncompletedPlanFilesAtStart.sort()).toEqual([
        'claude-review.md',
        'gemini-review.md',
      ]);
      expect(state.config.completion.requireCompletedFileRename).toBe(true);
    } finally {
      coordinator.cancelLoop(state.id);
    }
  });

  it('keeps requireCompletedFileRename=false when only denylisted docs (README/AGENTS/...) are present', async () => {
    writeFileSync(join(workspace, 'README.md'), '# Readme\n');
    writeFileSync(join(workspace, 'AGENTS.md'), '# Agents\n');
    writeFileSync(join(workspace, 'NOTES.md'), '# Notes\n');

    const state = await coordinator.startLoop('chat-only-docs', {
      initialPrompt: 'continuation task',
      workspaceCwd: workspace,
    });

    try {
      expect(state.uncompletedPlanFilesAtStart).toEqual([]);
      expect(state.config.completion.requireCompletedFileRename).toBe(false);
    } finally {
      coordinator.cancelLoop(state.id);
    }
  });

  it('respects an explicit caller false even when uncompleted plan files exist', async () => {
    writeFileSync(join(workspace, 'plan.md'), '# Plan\n');
    const baseCompletion = defaultLoopConfig(workspace, 'x').completion;

    const state = await coordinator.startLoop('chat-explicit-false', {
      initialPrompt: 'do work',
      workspaceCwd: workspace,
      completion: { ...baseCompletion, requireCompletedFileRename: false },
    });

    try {
      expect(state.uncompletedPlanFilesAtStart).toEqual(['plan.md']);
      // Caller said false explicitly — coordinator must not override.
      expect(state.config.completion.requireCompletedFileRename).toBe(false);
    } finally {
      coordinator.cancelLoop(state.id);
    }
  });

  it('ignores files already matching the completion suffix', async () => {
    writeFileSync(join(workspace, 'already_completed.md'), '# Done\n');
    writeFileSync(join(workspace, 'other_Completed.md'), '# Done\n');

    const state = await coordinator.startLoop('chat-only-completed', {
      initialPrompt: 'do work',
      workspaceCwd: workspace,
    });

    try {
      expect(state.uncompletedPlanFilesAtStart).toEqual([]);
      expect(state.config.completion.requireCompletedFileRename).toBe(false);
    } finally {
      coordinator.cancelLoop(state.id);
    }
  });
});

describe('LoopCoordinator completion classification hardening', () => {
  it('completes after a nested configured plan rename in REVIEW instead of spawning a second iteration that can error', async () => {
    writeFileSync(join(workspace, 'STAGE.md'), 'REVIEW\n');
    mkdirSync(join(workspace, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(workspace, 'docs', 'plans', 'phase.md'), '# Plan\n');
    let invocations = 0;
    coordinator.removeAllListeners('loop:invoke-iteration');
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      invocations += 1;
      const p = payload as { callback: (result: LoopChildResult | { error: string }) => void };
      if (invocations > 1) {
        p.callback({ error: 'second iteration should not have been spawned' });
        return;
      }
      renameSync(
        join(workspace, 'docs', 'plans', 'phase.md'),
        join(workspace, 'docs', 'plans', 'phase_completed.md'),
      );
      writeFileSync(join(workspace, 'DONE.txt'), 'finished\n');
      queueMicrotask(() => {
        p.callback({
          childInstanceId: null,
          output: 'TASK COMPLETE\n<promise>DONE</promise>\n',
          tokens: 10,
          filesChanged: [
            {
              path: 'docs/plans/phase_completed.md',
              additions: 1,
              deletions: 0,
              contentHash: 'abc123',
            },
          ],
          toolCalls: [],
          errors: [],
          testPassCount: null,
          testFailCount: null,
          exitedCleanly: true,
        });
      });
    });

    const terminalState = new Promise<{ status: string; endReason?: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('loop did not reach terminal state')), 2_000);
      coordinator.on('loop:state-changed', (data: unknown) => {
        const state = (data as { state: { status: string; endReason?: string } }).state;
        if (!['completed', 'cancelled', 'cap-reached', 'error', 'no-progress'].includes(state.status)) return;
        clearTimeout(timeout);
        resolve({ status: state.status, endReason: state.endReason });
      });
    });

    const state = await coordinator.startLoop('chat-nested-review-complete', {
      initialPrompt: 'implement docs/plans/phase.md',
      workspaceCwd: workspace,
      planFile: 'docs/plans/phase.md',
      caps: {
        maxIterations: 2,
        maxWallTimeMs: 60_000,
        maxTokens: 1_000_000,
        maxCostCents: 100,
        maxToolCallsPerIteration: 200,
      },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'true',
        runVerifyTwice: false,
        crossModelReview: {
          enabled: false,
          blockingSeverities: ['critical'],
          timeoutSeconds: 10,
          reviewDepth: 'structured',
        },
      },
    });

    try {
      await expect(terminalState).resolves.toEqual({
        status: 'completed',
        endReason: 'signal=completed-rename',
      });
      expect(invocations).toBe(1);
    } finally {
      coordinator.cancelLoop(state.id);
    }
  });
});
