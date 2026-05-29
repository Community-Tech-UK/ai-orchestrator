/**
 * LF-7 (loopfixex §12.1) — completion-attempt budget.
 *
 * Guards the oscillation where an agent repeatedly declares done and passes
 * verify, but never performs the required `*_Completed.md` rename, so the
 * belt-and-braces gate keeps rejecting completion and the loop spins until
 * `maxIterations`. With the budget, the loop instead stops as `cap-reached`
 * after `caps.maxCompletionAttempts` such verified-but-ungated attempts, with a
 * clear reason — no new terminal status required.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { defaultLoopConfig } from '../../shared/types/loop.types';

let workspace: string;
let coordinator: LoopCoordinator;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-completion-budget-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  coordinator = new LoopCoordinator();
});

afterEach(() => {
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

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
  it('stops as cap-reached after maxCompletionAttempts when verify passes but the *_Completed.md rename never happens', async () => {
    // A plan file is present (auto-enables requireCompletedFileRename), and the
    // agent declares done + writes DONE.txt each iteration but NEVER renames it.
    writeFileSync(join(workspace, 'plan.md'), '# Plan\n');

    let capReached: { cap: string; reason?: string } | null = null;
    coordinator.on('loop:cap-reached', (p: unknown) => {
      capReached = p as { cap: string; reason?: string };
    });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      // Declare done (DONE.txt) but do NOT rename plan.md → rename gate blocks.
      writeFileSync(join(workspace, 'DONE.txt'), `${new Date().toISOString()}\n`);
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
        verifyCommand: 'true', // verify always passes
        runVerifyTwice: false,
        requireCompletedFileRename: true,
      },
    });

    // Poll for a terminal state (the budget terminates on the first attempt, so
    // this resolves quickly without waiting on the per-iteration sleep guard).
    const live = () =>
      (coordinator as unknown as {
        active: Map<string, { status: string; endReason?: string; completionAttempts: number }>;
      }).active.get(state.id);
    for (let i = 0; i < 60 && !capReached && live()?.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    if (live()?.status === 'running') coordinator.cancelLoop(state.id);

    expect(capReached).not.toBeNull();
    expect(capReached!.cap).toBe('completion-attempts');
    expect(capReached!.reason ?? '').toContain('completion attempts');
    expect(live()?.status).toBe('cap-reached');
    expect(live()?.completionAttempts).toBeGreaterThanOrEqual(1);
  });
});
