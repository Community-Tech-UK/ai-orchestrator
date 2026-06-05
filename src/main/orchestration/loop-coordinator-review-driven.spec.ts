/**
 * Tests for review-driven completion mode (the default for user-started loops).
 *
 * The loop's engine is a relentless fresh-eyes self-review: each iteration the
 * model fixes what it finds, and the loop converges only after
 * `requiredCleanReviewPasses` consecutive CLEAN passes — a clean pass being an
 * iteration where the model emitted the no-outstanding phrase AND changed no
 * production code. Behaviours guarded here:
 *   1. Converges to `completed` after N consecutive clean passes; not before.
 *   2. A production-code change resets the clean-pass streak.
 *   3. Loop bookkeeping (.aio-loop-state/*) does NOT count as a production change.
 *   4. Converges to `completed-needs-review` when OUTSTANDING.md flags human items.
 *   5. Emitting the phrase without the exact text is not a clean pass.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult, type FreshEyesReviewerResult } from './loop-coordinator';
import { resolveLoopArtifactPaths, loopStateFile } from './loop-artifact-paths';
import { defaultLoopConfig, type LoopFileChange } from '../../shared/types/loop.types';

const PHRASE = 'There are no outstanding issues';

let workspace: string;
let coordinator: LoopCoordinator;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-review-driven-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  coordinator = new LoopCoordinator();
});

afterEach(() => {
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

function fileChange(path: string): LoopFileChange {
  return { path, additions: 1, deletions: 0, contentHash: `h-${path}` };
}

function childResult(output: string, filesChanged: LoopFileChange[] = []): LoopChildResult {
  return {
    childInstanceId: null,
    output,
    tokens: 1,
    filesChanged,
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    exitedCleanly: true,
  };
}

/**
 * Drive a review-driven loop with a scripted sequence of child results. Once
 * the script is exhausted, every further iteration returns a NON-clean result
 * (no phrase) so the loop never accidentally converges while we assert.
 */
function driveLoop(
  script: LoopChildResult[],
  opts: { outstanding?: string } = {},
): { invocations: () => number } {
  let i = 0;
  coordinator.on('loop:invoke-iteration', (payload: unknown) => {
    const p = payload as { callback: (r: LoopChildResult) => void };
    if (opts.outstanding !== undefined) {
      writeRunState(payload, 'OUTSTANDING.md', opts.outstanding);
    }
    const r = i < script.length ? script[i] : childResult('still working, more to do');
    i += 1;
    queueMicrotask(() => p.callback(r));
  });
  return { invocations: () => i };
}

function writeRunState(payload: unknown, name: string, content: string): void {
  const p = payload as { loopRunId: string; workspaceCwd: string };
  const paths = resolveLoopArtifactPaths(p.workspaceCwd, p.loopRunId);
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(loopStateFile(paths, name), content);
}

function reviewDrivenCompletion(extra: Record<string, unknown> = {}) {
  return {
    ...defaultLoopConfig(workspace, 'x').completion,
    mode: 'review-driven' as const,
    verifyCommand: '',
    requireCompletedFileRename: false,
    requiredCleanReviewPasses: 2,
    noOutstandingPhrase: PHRASE,
    ...extra,
  };
}

function startReviewDrivenLoop(chatId: string, completionExtra: Record<string, unknown> = {}) {
  return coordinator.startLoop(chatId, {
    initialPrompt: 'implement everything',
    workspaceCwd: workspace,
    caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 10 },
    completion: reviewDrivenCompletion(completionExtra),
  });
}

function waitForEvent<T>(event: string, timeoutMs = 20_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    coordinator.on(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('LoopCoordinator review-driven completion', () => {
  it('converges to `completed` after N consecutive clean passes, not before', async () => {
    const completed = waitForEvent<{ signal: string }>('loop:completed');
    // Two clean passes (phrase + no changes) → converge at iteration 2.
    const driver = driveLoop([
      childResult(`Did some work.\n${PHRASE}`),
      childResult(`Re-reviewed, nothing left.\n${PHRASE}`),
    ]);

    let state: Awaited<ReturnType<LoopCoordinator['startLoop']>> | undefined;
    try {
      state = await startReviewDrivenLoop('chat-rd-converge');
      await completed;
      await waitForCondition(() => coordinator.getLoop(state!.id)?.status === 'completed');
      expect(coordinator.getLoop(state.id)?.status).toBe('completed');
      // Exactly 2 iterations (one clean pass is not enough).
      expect(driver.invocations()).toBe(2);
    } finally {
      if (state) await coordinator.cancelLoop(state.id);
    }
  }, 25_000);

  it('resets the clean-pass streak when production code changes', async () => {
    // clean, then a production change (resets), then clean → only 1 in the
    // streak, so it must NOT have converged after these three iterations.
    driveLoop([
      childResult(`Work.\n${PHRASE}`),
      childResult(`Found a bug, fixed it.\n${PHRASE}`, [fileChange('src/app.ts')]),
      childResult(`Re-reviewed.\n${PHRASE}`),
    ]);

    let completed = false;
    coordinator.on('loop:completed', () => { completed = true; });

    let state: Awaited<ReturnType<LoopCoordinator['startLoop']>> | undefined;
    try {
      state = await startReviewDrivenLoop('chat-rd-reset');
      // Wait long enough for ~4 iterations (1.5s tail each) to elapse.
      await sleep(7_000);
      expect(completed).toBe(false);
      expect(coordinator.getLoop(state.id)?.consecutiveCleanReviewPasses ?? 0).toBeLessThan(2);
    } finally {
      if (state) await coordinator.cancelLoop(state.id);
    }
  }, 25_000);

  it('does not count loop bookkeeping (.aio-loop-state/*) as a production change', async () => {
    const completed = waitForEvent<{ signal: string }>('loop:completed');
    // Both iterations "change" only loop state files → still clean → converge.
    const driver = driveLoop([
      childResult(`Work.\n${PHRASE}`, [fileChange('.aio-loop-state/run/NOTES.md')]),
      childResult(`Re-review.\n${PHRASE}`, [fileChange('.aio-loop-state/run/OUTSTANDING.md')]),
    ]);

    let state: Awaited<ReturnType<LoopCoordinator['startLoop']>> | undefined;
    try {
      state = await startReviewDrivenLoop('chat-rd-bookkeeping');
      await completed;
      expect(driver.invocations()).toBe(2);
    } finally {
      if (state) await coordinator.cancelLoop(state.id);
    }
  }, 25_000);

  it('converges to `completed-needs-review` when OUTSTANDING.md flags human items', async () => {
    const needsReview = waitForEvent<{ reason: string }>('loop:completed-needs-review');
    driveLoop(
      [
        childResult(`Work.\n${PHRASE}`),
        childResult(`Re-review.\n${PHRASE}`),
      ],
      {
        outstanding: '## Needs human\n- Deploy to physical device and confirm camera works — I cannot access hardware.\n\n## Open questions\n- (none)\n',
      },
    );

    let state: Awaited<ReturnType<LoopCoordinator['startLoop']>> | undefined;
    try {
      state = await startReviewDrivenLoop('chat-rd-needs-human');
      const ev = await needsReview;
      expect(ev.reason).toContain('physical device');
      await waitForCondition(() => coordinator.getLoop(state!.id)?.status === 'completed-needs-review');
      expect(coordinator.getLoop(state.id)?.status).toBe('completed-needs-review');
    } finally {
      if (state) await coordinator.cancelLoop(state.id);
    }
  }, 25_000);

  it('takes an opt-in external second opinion at the finish line: a blocking finding resets the streak and re-opens the loop', async () => {
    // crossModelReview enabled → at the convergence threshold, run a second
    // opinion. First check blocks (critical finding) → reset + intervention;
    // later checks come back clean → converge.
    let reviewCalls = 0;
    coordinator.setFreshEyesReviewer(async (): Promise<FreshEyesReviewerResult> => {
      reviewCalls += 1;
      if (reviewCalls === 1) {
        return {
          findings: [{ title: 'Missing error handling', body: 'parsePayload can throw', severity: 'critical', confidence: 0.9 }],
          reviewersUsed: ['gemini'],
          summary: '1 finding',
        };
      }
      return { findings: [], reviewersUsed: ['gemini'], summary: 'clean' };
    });

    const completed = waitForEvent<{ signal: string }>('loop:completed');
    let interventionAfterBlock = false;
    coordinator.on('loop:fresh-eyes-review-blocked', () => { interventionAfterBlock = true; });

    // Every iteration the (mocked) primary reports clean. The external reviewer
    // is what gates the first convergence attempt.
    const driver = driveLoop(Array.from({ length: 8 }, () => childResult(`Re-reviewed.\n${PHRASE}`)));

    let state: Awaited<ReturnType<LoopCoordinator['startLoop']>> | undefined;
    try {
      state = await startReviewDrivenLoop('chat-rd-external', {
        crossModelReview: { enabled: true, blockingSeverities: ['critical', 'high'], timeoutSeconds: 10, reviewDepth: 'structured' },
      });
      await completed;
      expect(coordinator.getLoop(state.id)?.status).toBe('completed');
      expect(interventionAfterBlock).toBe(true);
      // First convergence attempt (iter 1) blocked; converged on a later attempt.
      expect(reviewCalls).toBeGreaterThanOrEqual(2);
      expect(driver.invocations()).toBeGreaterThan(2);
    } finally {
      if (state) await coordinator.cancelLoop(state.id);
    }
  }, 30_000);

  it('still converges when the external reviewer is unavailable (suggester, not a gate)', async () => {
    // No reviewers available → errored → must NOT pin the loop open.
    coordinator.setFreshEyesReviewer(async (): Promise<FreshEyesReviewerResult> => ({
      findings: [],
      reviewersUsed: [],
      summary: 'No reviewers available',
      infrastructureError: 'no alternative CLIs',
    }));

    const completed = waitForEvent<{ signal: string }>('loop:completed');
    driveLoop([
      childResult(`Work.\n${PHRASE}`),
      childResult(`Re-review.\n${PHRASE}`),
    ]);

    let state: Awaited<ReturnType<LoopCoordinator['startLoop']>> | undefined;
    try {
      state = await startReviewDrivenLoop('chat-rd-external-down', {
        crossModelReview: { enabled: true, blockingSeverities: ['critical', 'high'], timeoutSeconds: 10, reviewDepth: 'structured' },
      });
      await completed;
      expect(coordinator.getLoop(state.id)?.status).toBe('completed');
    } finally {
      if (state) await coordinator.cancelLoop(state.id);
    }
  }, 30_000);

  it('stops a spinning review loop as completed-needs-review instead of running to a cap', async () => {
    // Regression for the one-more-floor 3h/$8 spin: a review-driven loop that
    // makes no production changes and never emits the phrase (re-reviewing
    // settled work) produces an identical work hash each iteration → CRITICAL
    // no-progress. Review-driven loops are exempt from the no-progress *pause*,
    // so without the stall guard this runs to a hard cap / trips the circuit
    // breaker (surfaced as a misleading `error`). It must self-terminate.
    const needsReview = waitForEvent<{ reason: string }>('loop:completed-needs-review');
    // Empty script → every iteration returns the same no-phrase, no-change result.
    const driver = driveLoop([]);

    let state: Awaited<ReturnType<LoopCoordinator['startLoop']>> | undefined;
    try {
      state = await startReviewDrivenLoop('chat-rd-stall', { maxStalledReviewIterations: 2 });
      const ev = await needsReview;
      expect(ev.reason).toContain('stalled');
      await waitForCondition(() => coordinator.getLoop(state!.id)?.status === 'completed-needs-review');
      expect(coordinator.getLoop(state.id)?.status).toBe('completed-needs-review');
      // Must stop well before the 10-iteration cap.
      expect(driver.invocations()).toBeLessThan(10);
    } finally {
      if (state) await coordinator.cancelLoop(state.id);
    }
  }, 30_000);

  it('does not treat output without the exact phrase as a clean pass', async () => {
    driveLoop([
      childResult('I think it is basically done now.'),
      childResult('Looks fine to me, shipping.'),
    ]);

    let completed = false;
    coordinator.on('loop:completed', () => { completed = true; });

    let state: Awaited<ReturnType<LoopCoordinator['startLoop']>> | undefined;
    try {
      state = await startReviewDrivenLoop('chat-rd-no-phrase');
      await sleep(5_000);
      expect(completed).toBe(false);
      expect(coordinator.getLoop(state.id)?.consecutiveCleanReviewPasses ?? 0).toBe(0);
    } finally {
      if (state) await coordinator.cancelLoop(state.id);
    }
  }, 25_000);
});

async function waitForCondition(fn: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error('timeout waiting for condition');
    await sleep(50);
  }
}
