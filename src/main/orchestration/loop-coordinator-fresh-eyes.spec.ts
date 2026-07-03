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
 *   3. When the reviewer throws or fails infrastructurally, an explicitly
 *      enabled review gate does not silently pass — the loop pauses for
 *      operator review instead of auto-completing.
 *   4. The review block stays opt-in even when `uncompletedPlanFilesAtStart`
 *      is non-empty.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult, type FreshEyesReviewerResult } from './loop-coordinator';
import { resolveLoopArtifactPaths, loopStateFile } from './loop-artifact-paths';
import { passingVerifyCommand } from './loop-test-commands';
import { defaultLoopConfig, type LoopPendingInput } from '../../shared/types/loop.types';

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

async function waitForCondition(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
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
        verifyCommand: passingVerifyCommand(),
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

    const active = (coordinator as unknown as {
      active: Map<string, { pendingInterventions: LoopPendingInput[]; status: string; endReason?: string }>;
    }).active;
    let live = active.get(state.id);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      live = active.get(state.id);
      if (endedFlag || !live || live.status !== 'running' || live.pendingInterventions.length > 0) {
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    const pendingInterventions = live?.pendingInterventions.map((item) => item.message) ?? [];
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

  it('dedupes corroborated findings and orders the intervention worst-first', async () => {
    const r = await runOneIterationAttempt({
      reviewResult: {
        findings: [
          // Two reviewers flag the SAME critical issue (same title+file) ...
          {
            title: 'Auth bypass in handler',
            body: 'gemini phrasing',
            severity: 'critical',
            file: 'src/auth.ts',
            confidence: 0.8,
          },
          {
            title: 'Auth bypass in handler',
            body: 'codex phrasing',
            severity: 'critical',
            file: 'src/auth.ts',
            confidence: 0.95,
          },
          // ... plus one distinct lower-severity issue.
          {
            title: 'Unhandled promise rejection',
            body: 'A rejected promise is swallowed.',
            severity: 'high',
            file: 'src/x.ts',
            confidence: 0.7,
          },
        ],
        reviewersUsed: ['gemini', 'codex'],
        summary: 'two issues, one corroborated',
      },
      completedRenameFile: 'plan_completed.md',
    });

    expect(r.ended).toBe(false);
    const msg = r.pendingInterventions[0];
    // Deduped to 2 distinct issues (not 3 raw findings).
    expect(msg).toContain('blocked completion with 2 issues');
    // Critical issue is listed first, corroborated by 2 reviewers, keeping the
    // higher-confidence representative body.
    expect(msg).toContain('1. [CRITICAL] Auth bypass in handler (src/auth.ts) [flagged 2 times]');
    expect(msg).toContain('codex phrasing');
    expect(msg).not.toContain('gemini phrasing');
    // The high finding is listed after the critical one.
    expect(msg).toContain('2. [HIGH] Unhandled promise rejection');
    expect(msg.indexOf('[CRITICAL]')).toBeLessThan(msg.indexOf('[HIGH]'));
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

  it('records lastVerifiedWorkHash on state when verify passes at the gate (D6 #7)', async () => {
    let lastBroadcastState: { lastVerifiedWorkHash?: string } | null = null;
    coordinator.on('loop:state-changed', (payload: unknown) => {
      lastBroadcastState = (payload as { state: { lastVerifiedWorkHash?: string } }).state;
    });

    const r = await runOneIterationAttempt({
      reviewResult: { findings: [], reviewersUsed: ['gemini'], summary: 'clean' },
      completedRenameFile: 'plan_completed.md',
    });

    expect(r.ended).toBe(true);
    // computeWorkHash produces a sha256 hex digest; the passing verify at the
    // completion gate must have anchored it on state (edit-invalidates-proof).
    expect(lastBroadcastState?.lastVerifiedWorkHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('PAUSES when the reviewer is unavailable even if a verify command passed', async () => {
    // runOneIterationAttempt always configures a passing verify command.
    // A configured review gate that returns zero reviewers is an infrastructure
    // failure, not a clean review. It must not be silently bypassed.
    const r = await runOneIterationAttempt({
      reviewResult: {
        findings: [],
        reviewersUsed: [],
        summary: 'No reviewers available for headless review.',
        infrastructureError: 'No alternative CLIs detected',
      },
      completedRenameFile: 'plan_completed.md',
    });

    expect(r.ended).toBe(false);
    expect(r.endReason).toContain('operator review');
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

    const active = (coordinator as unknown as {
      active: Map<string, { status: string }>;
    }).active;
    await waitForCondition(() => claimedDoneButFailed || completed || active.get(state.id)?.status === 'paused');
    const live = active.get(state.id);
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

  it('PAUSES when the reviewer throws instead of silently completing', async () => {
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
    let claimedDoneButFailed = false;
    let claimedFailure = '';
    coordinator.on('loop:completed', () => { ended = true; });
    coordinator.on('loop:claimed-done-but-failed', (e: unknown) => {
      claimedDoneButFailed = true;
      claimedFailure = (e as { failure: string }).failure;
    });

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
        verifyCommand: passingVerifyCommand(),
        runVerifyTwice: false,
        crossModelReview: {
          enabled: true,
          blockingSeverities: ['critical', 'high'],
          timeoutSeconds: 10,
          reviewDepth: 'structured',
        },
      },
    });

    const active = (coordinator as unknown as {
      active: Map<string, { status: string; endReason?: string }>;
    }).active;
    await waitForCondition(() => claimedDoneButFailed || ended || active.get(state.id)?.status === 'paused');
    if (active.get(state.id)?.status === 'running') {
      coordinator.cancelLoop(state.id);
    }
    const live = active.get(state.id);
    expect(ended).toBe(false);
    expect(claimedDoneButFailed).toBe(true);
    expect(claimedFailure).toContain('fresh-eyes review');
    expect(live?.status).toBe('paused');
    expect(live?.endReason).toContain('operator review');
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
        verifyCommand: passingVerifyCommand(),
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
