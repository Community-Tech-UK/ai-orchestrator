/**
 * End-to-end convergence test for Piece B (verified, convergent loop).
 *
 * Proves the loop:
 *   1. does NOT stop while verify is RED (seeded failing test),
 *   2. does NOT stop while a blocking fresh-eyes finding remains,
 *   3. DOES stop only once verify is GREEN *and* the fresh-eyes review is clean,
 *   4. caps with a reason that explains it stopped while still red (non-premature
 *      stop under a hard cap).
 *
 * The verify command is a real shell command run against a real git repo, so
 * the "green signal" is genuine (not a stub return). The agent and the
 * cross-model reviewer are stubbed so the convergence sequence is
 * deterministic.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LoopCoordinator,
  type FreshEyesReviewerInput,
  type FreshEyesReviewerResult,
  type LoopChildResult,
} from './loop-coordinator';
import { defaultLoopConfig } from '../../shared/types/loop.types';

let workspace: string;
let coordinator: LoopCoordinator;

const VERIFY_CMD = 'if grep -q BUG app.js; then exit 1; else exit 0; fi';

function git(args: string[]): void {
  execFileSync('git', args, {
    cwd: workspace,
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-converge-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  // Seed a "failing test": app.js contains the BUG marker the verify greps for.
  writeFileSync(join(workspace, 'app.js'), 'const x = BUG;\n');
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['add', '.']);
  git(['commit', '-q', '-m', 'seed bug']);
  coordinator = new LoopCoordinator();
});

afterEach(async () => {
  try { await coordinator.cancelLoop(coordinator.getActiveLoops()[0]?.id ?? ''); } catch { /* noop */ }
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

function childResult(seq: number): LoopChildResult {
  return {
    childInstanceId: null,
    output: `iteration ${seq}: I believe this is done now.`,
    tokens: 1,
    // Distinct content hash per iteration so identical-work-hash no-progress
    // detection never pre-empts the convergence sequence.
    filesChanged: [{ path: 'app.js', additions: 1, deletions: 1, contentHash: `app-${seq}` }],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
  };
}

const CAPS = {
  maxIterations: 10,
  maxWallTimeMs: 120_000,
  maxTokens: 1_000_000,
  maxCostCents: 100_000,
  maxToolCallsPerIteration: 200,
};

describe('LoopCoordinator convergence (Piece B)', () => {
  it('converges: red verify → fix → blocking review → clean review → stop; never stops early', async () => {
    const phases: string[] = [];
    const reviewerInputs: FreshEyesReviewerInput[] = [];

    coordinator.on('loop:claimed-done-but-failed', () => phases.push('verify-failed'));
    coordinator.on('loop:fresh-eyes-review-blocked', () => phases.push('review-blocked'));
    coordinator.on('loop:completed', () => phases.push('completed'));

    // Stub agent: iteration 0 claims done WITHOUT fixing the bug; iterations
    // 1+ fix it. Every iteration drops a DONE.txt sentinel (sufficient signal).
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { seq: number; callback: (r: LoopChildResult) => void };
      if (p.seq >= 1) {
        writeFileSync(join(workspace, 'app.js'), 'const x = 1;\n'); // remove BUG → verify passes
      }
      writeFileSync(join(workspace, 'DONE.txt'), `done at ${p.seq}\n`);
      queueMicrotask(() => p.callback(childResult(p.seq)));
    });

    // Stub reviewer: blocks on the FIRST green attempt, clean on the second.
    coordinator.setFreshEyesReviewer(async (input): Promise<FreshEyesReviewerResult> => {
      reviewerInputs.push(input);
      if (reviewerInputs.length === 1) {
        return {
          findings: [{ title: 'Blocking design flaw', body: 'The fix masks the symptom but not the cause.', severity: 'high', confidence: 0.9 }],
          reviewersUsed: ['gemini'],
          summary: 'one blocking finding',
        };
      }
      return { findings: [], reviewersUsed: ['gemini'], summary: 'looks clean' };
    });

    const completed = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('loop did not converge in time')), 25_000);
      coordinator.on('loop:completed', () => { clearTimeout(t); resolve(); });
      coordinator.on('loop:error', (d: { error: string }) => { clearTimeout(t); reject(new Error(`loop errored: ${d.error}`)); });
      coordinator.on('loop:failed', (d: { reason: string }) => { clearTimeout(t); reject(new Error(`loop failed: ${d.reason}`)); });
      coordinator.on('loop:cap-reached', (d: { reason?: string }) => { clearTimeout(t); reject(new Error(`cap reached unexpectedly: ${d.reason}`)); });
    });

    const state = await coordinator.startLoop('chat-converge', {
      initialPrompt: 'fix the bug in app.js and keep reviewing with fresh eyes until clean',
      workspaceCwd: workspace,
      caps: CAPS,
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: VERIFY_CMD,
        runVerifyTwice: false,
        crossModelReview: {
          enabled: true,
          blockingSeverities: ['critical', 'high'],
          timeoutSeconds: 10,
          reviewDepth: 'structured',
        },
      },
    });

    await completed;

    // The loop only stopped after a red verify AND a blocking review were each
    // resolved — i.e. it did NOT stop prematurely.
    expect(phases).toEqual(['verify-failed', 'review-blocked', 'completed']);

    const final = coordinator.getLoop(state.id);
    expect(final?.status).toBe('completed');
    expect(final?.totalIterations).toBe(3);

    // The reviewer was fed the real git diff (clean context), not the transcript.
    expect(reviewerInputs.length).toBe(2);
    expect(reviewerInputs[0].diffSource).toBe('git');
    expect(reviewerInputs[0].diff ?? '').toContain('app.js');
    // The agent's self-narration must NOT be the review payload.
    expect(reviewerInputs[0].diff ?? '').not.toContain('I believe this is done now.');
  }, 30_000);

  it('caps while verify stays RED and reports why (never completes on a red signal)', async () => {
    let completedFired = false;
    coordinator.on('loop:completed', () => { completedFired = true; });

    // Agent always claims done but never fixes the bug → verify stays red.
    coordinator.on('loop:invoke-iteration', (payload: unknown) => {
      const p = payload as { seq: number; callback: (r: LoopChildResult) => void };
      writeFileSync(join(workspace, 'DONE.txt'), `done at ${p.seq}\n`);
      queueMicrotask(() => p.callback(childResult(p.seq)));
    });
    // Reviewer should never even run (verify never passes); make it loud if it does.
    coordinator.setFreshEyesReviewer(async (): Promise<FreshEyesReviewerResult> => {
      throw new Error('reviewer must not run while verify is red');
    });

    const capped = new Promise<{ reason?: string }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('loop did not cap in time')), 25_000);
      coordinator.on('loop:cap-reached', (d: { reason?: string }) => { clearTimeout(t); resolve(d); });
      coordinator.on('loop:completed', () => { clearTimeout(t); reject(new Error('loop completed on a RED verify — premature stop')); });
    });

    const state = await coordinator.startLoop('chat-red', {
      initialPrompt: 'fix the bug',
      workspaceCwd: workspace,
      caps: { ...CAPS, maxIterations: 2 },
      completion: {
        ...defaultLoopConfig(workspace, 'x').completion,
        verifyCommand: VERIFY_CMD,
        runVerifyTwice: false,
      },
    });

    const capEvent = await capped;
    expect(completedFired).toBe(false);

    const final = coordinator.getLoop(state.id);
    expect(final?.status).toBe('cap-reached');
    // Cap reason explains it stopped while still red, not just "cap=iterations".
    expect(capEvent.reason ?? '').toContain('cap=iterations');
    expect(final?.endReason ?? '').toMatch(/verify/i);
  }, 30_000);
});
