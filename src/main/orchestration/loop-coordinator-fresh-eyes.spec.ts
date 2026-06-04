/**
 * Regression tests for the mandatory fresh-eyes cross-model review gate
 * that runs **before** the loop accepts a completion signal.
 *
 * Behaviours guarded here:
 *   1. When `crossModelReview.enabled` is true and the reviewer returns at
 *      least one blocking finding (severity ∈ blockingSeverities), the
 *      loop does NOT stop — instead the finding is injected as a user
 *      intervention and the loop continues.
 *   2. When the reviewer returns no blocking findings, the loop stops
 *      normally (review gate is transparent).
 *   3. When the reviewer throws or fails infrastructurally, the loop
 *      does NOT pin open — it lets completion proceed. (A broken reviewer
 *      shouldn't trap an otherwise-done agent forever.)
 *   4. The review block stays opt-in even when `uncompletedPlanFilesAtStart`
 *      is non-empty.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult, type FreshEyesReviewerResult } from './loop-coordinator';
import { resolveLoopArtifactPaths, loopStateFile } from './loop-artifact-paths';
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
  workspace = mkdtempSync(join(tmpdir(), 'loop-fresh-eyes-'));
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

describe('LoopCoordinator fresh-eyes review gate', () => {
  it('leaves crossModelReview undefined when uncompleted plan files exist but the caller did not opt in', async () => {
    writeFileSync(join(workspace, 'plan.md'), '# Plan\n');

    const state = await coordinator.startLoop('chat-fresh-eyes-optin', {
      initialPrompt: 'implement plan.md',
      workspaceCwd: workspace,
    });

    try {
      // Fresh-eyes review is opt-in (FU-7). Previously the coordinator
      // auto-enabled it whenever uncompleted plan files were present, which
      // surprised users with extra cross-CLI calls on every completion
      // attempt. Callers who want the gate must pass an explicit
      // `crossModelReview: { enabled: true, ... }`.
      expect(state.config.completion.crossModelReview).toBeUndefined();
    } finally {
      coordinator.cancelLoop(state.id);
    }
  });

  it('respects an explicit { enabled: false } from the caller', async () => {
    writeFileSync(join(workspace, 'plan.md'), '# Plan\n');
    const base = defaultLoopConfig(workspace, 'x').completion;

    const state = await coordinator.startLoop('chat-fresh-eyes-opt-out', {
      initialPrompt: 'implement plan.md',
      workspaceCwd: workspace,
      completion: {
        ...base,
        crossModelReview: {
          enabled: false,
          blockingSeverities: ['critical'],
          timeoutSeconds: 30,
          reviewDepth: 'structured',
        },
      },
    });

    try {
      expect(state.config.completion.crossModelReview?.enabled).toBe(false);
    } finally {
      coordinator.cancelLoop(state.id);
    }
  });

  it('keeps crossModelReview undefined when no plan files and no explicit config', async () => {
    const state = await coordinator.startLoop('chat-fresh-eyes-noplans', {
      initialPrompt: 'continuation task',
      workspaceCwd: workspace,
    });

    try {
      expect(state.config.completion.crossModelReview).toBeUndefined();
    } finally {
      coordinator.cancelLoop(state.id);
    }
  });
});

describe('LoopCoordinator fresh-eyes review — behaviour at completion', () => {
  /**
   * Helper: install a stub reviewer that returns the given findings, then
   * start a loop, feed it one IMPLEMENT iteration that claims done, and
   * return the resulting state for assertion.
   */
  async function runOneIterationAttempt(opts: {
    reviewResult: FreshEyesReviewerResult;
    completedRenameFile?: string;
  }): Promise<{ stateId: string; ended: boolean; pendingInterventions: string[]; endReason?: string }> {
    writeFileSync(join(workspace, 'plan.md'), '# Plan\n');
    // Pre-create DONE.txt removal by bootstrap (loop machine deletes it).
    coordinator.setFreshEyesReviewer(async () => opts.reviewResult);

    let endedFlag = false;
    coordinator.on('loop:completed', () => { endedFlag = true; });
    coordinator.on('loop:cancelled', () => { /* noop */ });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      // Synchronously create the durable evidence the loop expects:
      // 1. DONE.txt sentinel
      // 2. A *_completed.md rename of the plan file (belt-and-braces)
      writeRunState(payload, 'DONE.txt', `${new Date().toISOString()}\n`);
      if (opts.completedRenameFile) {
        writeFileSync(join(workspace, opts.completedRenameFile), '# Done\n');
      }
      queueMicrotask(() => p.callback(makeChildResultThatClaimsDone()));
    });

    const state = await coordinator.startLoop('chat-fresh-eyes-run', {
      initialPrompt: 'implement plan.md',
      workspaceCwd: workspace,
      // Cap to one iteration so the test terminates if the gate doesn't catch.
      caps: {
        maxIterations: 1,
        maxWallTimeMs: 60_000,
        maxTokens: 1_000_000,
        maxCostCents: 100,
        maxToolCallsPerIteration: 200,
      },
      // Always set verifyCommand to a no-op success so verify-before-stop passes.
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: 'true',
        runVerifyTwice: false,
        crossModelReview: {
          enabled: true,
          blockingSeverities: ['critical', 'high'],
          timeoutSeconds: 10,
          reviewDepth: 'structured',
        },
      },
    });
    const initialEndReason = state.endReason;

    // Wait briefly for the run to complete or cap out.
    await new Promise((r) => setTimeout(r, 200));

    const live = (coordinator as unknown as {
      active: Map<string, { pendingInterventions: string[]; status: string; endReason?: string }>;
    }).active.get(state.id);
    const pendingInterventions = live?.pendingInterventions ?? [];
    const status = live?.status;
    const reason = live?.endReason;

    if (state.id && status === 'running') {
      coordinator.cancelLoop(state.id);
    }

    return {
      stateId: state.id,
      ended: endedFlag || status === 'completed',
      pendingInterventions,
      endReason: reason ?? initialEndReason,
    };
  }

  it('BLOCKS completion when reviewer returns a critical finding', async () => {
    const r = await runOneIterationAttempt({
      reviewResult: {
        findings: [
          {
            title: 'Plan claims X but code shows Y',
            body: 'The implementation does not match the spec.',
            severity: 'critical',
            confidence: 0.9,
          },
        ],
        reviewersUsed: ['gemini'],
        summary: 'one critical finding',
      },
      completedRenameFile: 'plan_completed.md',
    });

    expect(r.ended).toBe(false);
    expect(r.pendingInterventions.length).toBeGreaterThanOrEqual(1);
    expect(r.pendingInterventions[0]).toContain('CRITICAL');
    expect(r.pendingInterventions[0]).toContain('Plan claims X but code shows Y');
  });

  it('ALLOWS completion when reviewer returns only low/medium findings', async () => {
    const r = await runOneIterationAttempt({
      reviewResult: {
        findings: [
          {
            title: 'Minor naming inconsistency',
            body: 'Nice to fix later.',
            severity: 'low',
            confidence: 0.7,
          },
        ],
        reviewersUsed: ['gemini'],
        summary: 'low-severity only',
      },
      completedRenameFile: 'plan_completed.md',
    });

    expect(r.ended).toBe(true);
    expect(r.pendingInterventions.length).toBe(0);
  });

  it('ALLOWS completion when the reviewer is unavailable BUT a verify command carries authority', async () => {
    // runOneIterationAttempt always configures verifyCommand: 'true' (passing).
    // With an independent verify authority, an unavailable reviewer (empty
    // reviewersUsed) is correctly non-blocking — the loop still completes.
    const r = await runOneIterationAttempt({
      reviewResult: {
        findings: [],
        reviewersUsed: [],
        summary: 'No reviewers available for headless review.',
        infrastructureError: 'No alternative CLIs detected',
      },
      completedRenameFile: 'plan_completed.md',
    });

    expect(r.ended).toBe(true);
  });

  it('does NOT false-complete a no-verify loop when no reviewers are available', async () => {
    // Regression: a no-verify loop whose ONLY completion authority is the
    // fresh-eyes review must NOT rubber-stamp completion when the review service
    // returns zero reviewers (no alternative CLIs / infra down). An empty
    // findings list there means "nobody looked", not "looked and found it
    // clean", so the loop must pause for operator review instead of declaring
    // done on the agent's self-declared evidence alone.
    writeFileSync(join(workspace, 'plan.md'), '# Plan\n');
    coordinator.setFreshEyesReviewer(async () => ({
      findings: [],
      reviewersUsed: [],
      summary: 'No reviewers available for headless review.',
      infrastructureError: 'No alternative CLIs detected',
    }));

    let completed = false;
    let claimedDoneButFailed = false;
    let claimedFailure = '';
    coordinator.on('loop:completed', () => { completed = true; });
    coordinator.on('loop:claimed-done-but-failed', (e: unknown) => {
      claimedDoneButFailed = true;
      claimedFailure = (e as { failure: string }).failure;
    });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      writeRunState(payload, 'DONE.txt', `${new Date().toISOString()}\n`);
      writeFileSync(join(workspace, 'plan_completed.md'), '# Done\n');
      queueMicrotask(() => p.callback(makeChildResultThatClaimsDone()));
    });

    const base = defaultLoopConfig(workspace, 'x').completion;
    const state = await coordinator.startLoop('chat-no-verify-no-reviewers', {
      initialPrompt: 'implement plan.md',
      workspaceCwd: workspace,
      caps: {
        maxIterations: 1,
        maxWallTimeMs: 60_000,
        maxTokens: 1_000_000,
        maxCostCents: 100,
        maxToolCallsPerIteration: 200,
      },
      completion: {
        ...base,
        // No verify command — the fresh-eyes review is the sole authority.
        verifyCommand: '',
        runVerifyTwice: false,
        crossModelReview: {
          enabled: true,
          blockingSeverities: ['critical', 'high'],
          timeoutSeconds: 10,
          reviewDepth: 'structured',
        },
      },
    });

    await new Promise((r) => setTimeout(r, 200));
    const live = (coordinator as unknown as {
      active: Map<string, { status: string }>;
    }).active.get(state.id);
    if (live?.status === 'running') {
      coordinator.cancelLoop(state.id);
    }

    expect(completed).toBe(false);
    expect(claimedDoneButFailed).toBe(true);
    expect(live?.status).toBe('paused');

    // Regression for the misleading "no verify command configured" message:
    // when the fresh-eyes review RAN but produced no verdict (no reviewers /
    // unparseable output), the operator-facing text must blame the failed
    // review, not pin it on a missing verify command. The review is enabled
    // here, so neither the rejection reason nor the failure should claim it is
    // "not enabled".
    expect(claimedFailure).toContain('fresh-eyes review');
    expect(claimedFailure).toMatch(/could not produce a verdict|unparseable|none were available/);
    expect(claimedFailure).not.toContain('fresh-eyes review is not enabled');
  });

  it('ALLOWS completion when the reviewer throws (does not pin loop open)', async () => {
    writeFileSync(join(workspace, 'plan.md'), '# Plan\n');
    coordinator.setFreshEyesReviewer(async () => {
      throw new Error('synthetic reviewer crash');
    });

    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      writeRunState(payload, 'DONE.txt', 'x\n');
      writeFileSync(join(workspace, 'plan_completed.md'), '# Done\n');
      queueMicrotask(() => p.callback(makeChildResultThatClaimsDone()));
    });

    let ended = false;
    coordinator.on('loop:completed', () => { ended = true; });

    const state = await coordinator.startLoop('chat-fresh-eyes-reviewer-throws', {
      initialPrompt: 'implement plan.md',
      workspaceCwd: workspace,
      caps: {
        maxIterations: 1,
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
          enabled: true,
          blockingSeverities: ['critical', 'high'],
          timeoutSeconds: 10,
          reviewDepth: 'structured',
        },
      },
    });

    await new Promise((r) => setTimeout(r, 200));
    if ((coordinator as unknown as { active: Map<string, { status: string }> }).active.get(state.id)?.status === 'running') {
      coordinator.cancelLoop(state.id);
    }
    expect(ended).toBe(true);
  });

  it('SKIPS the gate entirely when crossModelReview.enabled is false', async () => {
    writeFileSync(join(workspace, 'plan.md'), '# Plan\n');
    let reviewerCalls = 0;
    coordinator.setFreshEyesReviewer(async () => {
      reviewerCalls += 1;
      return { findings: [], reviewersUsed: [], summary: '' };
    });
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { callback: (r: LoopChildResult) => void };
      writeRunState(payload, 'DONE.txt', 'x\n');
      writeFileSync(join(workspace, 'plan_completed.md'), '# Done\n');
      queueMicrotask(() => p.callback(makeChildResultThatClaimsDone()));
    });

    const state = await coordinator.startLoop('chat-fresh-eyes-disabled', {
      initialPrompt: 'implement plan.md',
      workspaceCwd: workspace,
      caps: {
        maxIterations: 1,
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

    await new Promise((r) => setTimeout(r, 200));
    if ((coordinator as unknown as { active: Map<string, { status: string }> }).active.get(state.id)?.status === 'running') {
      coordinator.cancelLoop(state.id);
    }
    expect(reviewerCalls).toBe(0);
  });
});
