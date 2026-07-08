/**
 * LF-7 (loopfixex §12.1) — completion-attempt budget.
 *
 * Guards the oscillation where an agent repeatedly declares done and passes
 * verify, but never performs the required `*_Completed.md` rename, so the
 * belt-and-braces gate keeps rejecting completion and the loop spins until
 * `maxIterations`. With the budget, the loop instead stops after
 * `caps.maxCompletionAttempts` verified-but-ungated attempts. Because verify
 * is *passing* (the code is in a good state by the project's own definition),
 * it terminates in the SUCCESSFUL `completed-needs-review` state — not the
 * misleading `cap-reached` — so a human can do the bookkeeping rename / glance.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { resolveLoopArtifactPaths, loopStateFile } from './loop-artifact-paths';
import { passingVerifyCommand } from './loop-test-commands';
import { defaultLoopConfig } from '../../shared/types/loop.types';

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
  workspace = mkdtempSync(join(tmpdir(), 'loop-completion-budget-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  coordinator = new LoopCoordinator();
});

afterEach(async () => {
  for (const loop of coordinator.getActiveLoops()) {
    await coordinator.cancelLoop(loop.id).catch(() => undefined);
  }
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

async function waitForCondition(
  predicate: () => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function makeChildResultThatClaimsDone(): LoopChildResult {
  return {
    childInstanceId: null,
    output: '<promise>DONE</promise>\nTASK COMPLETE',
    tokens: 1,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
  };
}

describe('LoopCoordinator completion-attempt budget (LF-7)', () => {
  it('stops as completed-needs-review after maxCompletionAttempts when verify passes but the *_Completed.md rename never happens', async () => {
    // A plan file is present (auto-enables requireCompletedFileRename), and the
    // agent declares done + writes DONE.txt each iteration but NEVER renames it.
    writeFileSync(join(workspace, 'plan.md'), '# Plan\n');

    let needsReview: { reason?: string; acceptedByOperator?: boolean } | null = null;
    coordinator.on('loop:completed-needs-review', (p: unknown) => {
      needsReview = p as { reason?: string; acceptedByOperator?: boolean };
    });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      // Declare done (DONE.txt) but do NOT rename plan.md → rename gate blocks.
      writeRunState(payload, 'DONE.txt', `${new Date().toISOString()}\n`);
      queueMicrotask(() => p.callback(makeChildResultThatClaimsDone()));
    });

    const state = await coordinator.startLoop('chat-completion-budget', {
      initialPrompt: 'implement plan.md',
      workspaceCwd: workspace,
      caps: {
        // maxIterations is high so the BUDGET (not the iteration cap) is what
        // stops the run — proving the budget is the active mechanism.
        maxIterations: 50,
        maxWallTimeMs: 60_000,
        maxTokens: 1_000_000,
        maxCostCents: 100,
        maxToolCallsPerIteration: 200,
        maxCompletionAttempts: 1,
      },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: passingVerifyCommand(),
        runVerifyTwice: false,
        requireCompletedFileRename: true,
      },
    });

    const live = () =>
      (coordinator as unknown as {
        active: Map<string, { status: string; endReason?: string; completionAttempts: number; lastCompletionOutcome?: string }>;
      }).active.get(state.id);
    await waitForCondition(
      () => needsReview !== null && live()?.status === 'completed-needs-review',
      'completion-attempt budget to stop as completed-needs-review',
    );

    expect(needsReview).not.toBeNull();
    expect(needsReview!.acceptedByOperator).toBe(false);
    expect(needsReview!.reason ?? '').toContain('rename');
    expect(live()?.status).toBe('completed-needs-review');
    expect(live()?.completionAttempts).toBeGreaterThanOrEqual(1);
    expect(live()?.lastCompletionOutcome).toBe('rename-gate');
  });

  it('does not pause for no-progress on a verified-done iteration (converging, not stuck)', async () => {
    // verify always passes, rename never happens; identical work-hash every
    // iteration would normally trip an A/CRITICAL no-progress pause. With the
    // LF-7 guard, a verified-done iteration must never pause for no-progress —
    // it terminates via the budget instead.
    writeFileSync(join(workspace, 'plan.md'), '# Plan\n');

    let pausedForNoProgress = false;
    coordinator.on('loop:paused-no-progress', () => {
      pausedForNoProgress = true;
    });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      writeRunState(payload, 'DONE.txt', 'done\n');
      queueMicrotask(() => p.callback(makeChildResultThatClaimsDone()));
    });

    const state = await coordinator.startLoop('chat-budget-no-pause', {
      initialPrompt: 'implement plan.md',
      workspaceCwd: workspace,
      caps: {
        maxIterations: 50,
        maxWallTimeMs: 60_000,
        maxTokens: 1_000_000,
        maxCostCents: 100,
        maxToolCallsPerIteration: 200,
        maxCompletionAttempts: 3,
      },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: passingVerifyCommand(),
        runVerifyTwice: false,
        requireCompletedFileRename: true,
      },
    });

    const live = () =>
      (coordinator as unknown as { active: Map<string, { status: string }> }).active.get(state.id);
    await waitForCondition(
      () => live()?.status === 'completed-needs-review',
      'verified-done no-progress case to stop as completed-needs-review',
    );

    expect(pausedForNoProgress).toBe(false);
    expect(live()?.status).toBe('completed-needs-review');
  });
});
