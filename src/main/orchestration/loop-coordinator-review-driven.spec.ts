/**
 * Tests for review-driven completion mode (the default for user-started loops).
 *
 * The loop's engine is a relentless fresh-eyes self-review: each iteration the
 * model fixes what it finds, and the loop converges only after
 * `requiredCleanReviewPasses` consecutive CLEAN passes — a clean pass being an
 * iteration where the review output semantically reports no actionable issues
 * AND changed no production code. Behaviours guarded here:
 *   1. Converges to `completed` after N consecutive clean passes; not before.
 *   2. A production-code change resets the clean-pass streak.
 *   3. Loop bookkeeping (.aio-loop-state/*) does NOT count as a production change.
 *   4. Converges to `completed-needs-review` when OUTSTANDING.md flags human items.
 *   5. Ambiguous completion claims are not clean passes.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoopCoordinator, type LoopChildResult, type FreshEyesReviewerResult } from './loop-coordinator';
import { resolveLoopArtifactPaths, loopStateFile } from './loop-artifact-paths';
import { defaultLoopConfig, type LoopFileChange } from '../../shared/types/loop.types';
import { classifyCleanReviewText } from './loop-clean-review-classifier';

const PHRASE = 'There are no outstanding issues';

let workspace: string;
let coordinator: LoopCoordinator;
const gitOk = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;
const maybe = gitOk ? it : it.skip;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'loop-review-driven-'));
  writeFileSync(join(workspace, 'STAGE.md'), 'IMPLEMENT\n');
  coordinator = new LoopCoordinator();
  coordinator.setCleanReviewClassifier(async (input) =>
    classifyCleanReviewText(input.iterationOutput, input.config.noOutstandingPhrase),
  );
});

afterEach(() => {
  try { rmSync(workspace, { recursive: true, force: true }); } catch { /* noop */ }
});

function fileChange(path: string): LoopFileChange {
  return { path, additions: 1, deletions: 0, contentHash: `h-${path}` };
}

function childResult(
  output: string,
  filesChanged: LoopFileChange[] = [],
  extra: Partial<LoopChildResult> = {},
): LoopChildResult {
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
    ...extra,
  };
}

/**
 * Drive a review-driven loop with a scripted sequence of child results. Once
 * the script is exhausted, every further iteration returns a NON-clean result
 * (no phrase) so the loop never accidentally converges while we assert.
 */
function driveLoop(
  script: LoopChildResult[],
  opts: { outstanding?: string; tasks?: string } = {},
): { invocations: () => number } {
  let i = 0;
  coordinator.on('loop:invoke-iteration', (payload: unknown) => {
    const p = payload as { callback: (r: LoopChildResult) => void };
    if (opts.outstanding !== undefined) {
      writeRunState(payload, 'OUTSTANDING.md', opts.outstanding);
    }
    if (opts.tasks !== undefined) {
      writeRunState(payload, 'LOOP_TASKS.md', opts.tasks);
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
    // Two clean passes (clear no-issues review + no changes) → converge at iteration 2.
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

  it('runs the final audit gate before accepting review-driven convergence', async () => {
    const rejected = waitForEvent<{ failure: string }>('loop:claimed-done-but-failed');
    driveLoop(
      [
        childResult(`Did some work.\n${PHRASE}`),
        childResult(`Re-reviewed, nothing left.\n${PHRASE}`),
      ],
      { tasks: '# Loop Tasks\n\n- [ ] Finish the deliverable\n' },
    );

    let state: Awaited<ReturnType<LoopCoordinator['startLoop']>> | undefined;
    try {
      state = await coordinator.startLoop('chat-rd-final-audit', {
        initialPrompt: 'implement everything',
        workspaceCwd: workspace,
        caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 10 },
        completion: reviewDrivenCompletion(),
        audit: {
          finalAuditMode: 'gate',
          preflightMode: 'off',
          planPacketMode: 'off',
          cleanlinessScan: true,
        },
      });

      const ev = await rejected;

      expect(ev.failure).toContain('final audit');
      expect(coordinator.getLoop(state.id)?.status).toBe('running');
      expect(coordinator.getLoop(state.id)?.latestFinalAudit?.status).toBe('failed');
      expect(coordinator.getLoop(state.id)?.pendingInterventions.at(-1)?.message).toContain('final audit');
    } finally {
      if (state) await coordinator.cancelLoop(state.id);
    }
  }, 25_000);

  it('broadcasts the sealed iteration after final audit rejects completion', async () => {
    const rejected = waitForEvent<{ failure: string }>('loop:claimed-done-but-failed');
    let broadcastAuditStatus: string | undefined;
    coordinator.on('loop:state-changed', (payload: unknown) => {
      const state = (payload as { state?: { lastIteration?: { finalAudit?: { status?: string } } } }).state;
      broadcastAuditStatus = state?.lastIteration?.finalAudit?.status ?? broadcastAuditStatus;
    });
    driveLoop(
      [
        childResult(`Did some work.\n${PHRASE}`),
        childResult(`Re-reviewed, nothing left.\n${PHRASE}`),
      ],
      { tasks: '# Loop Tasks\n\n- [ ] Finish the deliverable\n' },
    );

    let state: Awaited<ReturnType<LoopCoordinator['startLoop']>> | undefined;
    try {
      state = await coordinator.startLoop('chat-rd-final-audit-broadcast', {
        initialPrompt: 'implement everything',
        workspaceCwd: workspace,
        caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 10 },
        completion: reviewDrivenCompletion(),
        audit: {
          finalAuditMode: 'gate',
          preflightMode: 'off',
          planPacketMode: 'off',
          cleanlinessScan: true,
        },
      });

      await rejected;
      await waitForCondition(() => broadcastAuditStatus === 'failed', 2_000);

      expect(coordinator.getLoop(state.id)?.latestFinalAudit?.status).toBe('failed');
    } finally {
      if (state) await coordinator.cancelLoop(state.id);
    }
  }, 25_000);

  it('runs the final audit gate before accepting ping-pong convergence', async () => {
    coordinator.setPingPongSubjectResolver(async () => 'impl');
    coordinator.setPingPongReviewerForTesting(async () => ({
      verdict: 'APPROVED',
      reviewerProvider: 'codex',
      findings: [],
      ledgerClassifications: [],
      summary: 'approved',
      tokensUsed: 0,
      costCents: 0,
      spawnOutcome: 'settled',
    }));
    const rejected = waitForEvent<{ failure: string }>('loop:claimed-done-but-failed');
    driveLoop(
      [
        childResult(`Ping-pong-ready completion.\n${PHRASE}`),
      ],
      { tasks: '# Loop Tasks\n\n- [ ] Finish the deliverable\n' },
    );

    let state: Awaited<ReturnType<LoopCoordinator['startLoop']>> | undefined;
    try {
      state = await coordinator.startLoop('chat-rd-pingpong-final-audit', {
        initialPrompt: 'implement everything',
        workspaceCwd: workspace,
        caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 10 },
        completion: reviewDrivenCompletion({
          crossModelReview: {
            enabled: true,
            blockingSeverities: ['critical', 'high'],
            timeoutSeconds: 10,
            reviewDepth: 'structured',
            pingPong: { enabled: true, reviewerProvider: 'auto', subject: 'impl', maxRounds: 15 },
          },
        }),
        audit: {
          finalAuditMode: 'gate',
          preflightMode: 'off',
          planPacketMode: 'off',
          cleanlinessScan: true,
        },
      });

      const ev = await rejected;

      expect(ev.failure).toContain('final audit');
      expect(coordinator.getLoop(state.id)?.status).toBe('running');
      expect(coordinator.getLoop(state.id)?.latestFinalAudit?.status).toBe('failed');
      expect(coordinator.getLoop(state.id)?.pendingInterventions.at(-1)?.message).toContain('final audit');
    } finally {
      if (state) await coordinator.cancelLoop(state.id);
    }
  }, 25_000);

  maybe('keeps a verified clean ping-pong convergence completed after the final audit gate', async () => {
    initGitRepo();
    coordinator.setPingPongSubjectResolver(async () => 'impl');
    coordinator.setPingPongReviewerForTesting(async () => ({
      verdict: 'APPROVED',
      reviewerProvider: 'codex',
      findings: [],
      ledgerClassifications: [],
      summary: 'approved',
      tokensUsed: 0,
      costCents: 0,
      spawnOutcome: 'settled',
    }));
    const terminal = Promise.race([
      waitForEvent<{ loopRunId: string }>('loop:completed')
        .then((ev) => ({ type: 'completed' as const, loopRunId: ev.loopRunId })),
      waitForEvent<{ reason: string }>('loop:completed-needs-review')
        .then((ev) => ({ type: 'needs-review' as const, reason: ev.reason })),
    ]);
    driveLoop([
      childResult(`Ping-pong-ready completion.\n${PHRASE}`, [fileChange('src/pingpong.ts')]),
    ]);
    coordinator.once('loop:invoke-iteration', () => {
      mkdirSync(join(workspace, 'src'), { recursive: true });
      writeFileSync(join(workspace, 'src', 'pingpong.ts'), 'export const pingpong = true;\n', 'utf8');
    });

    let state: Awaited<ReturnType<LoopCoordinator['startLoop']>> | undefined;
    try {
      state = await coordinator.startLoop('chat-rd-pingpong-audit-passed', {
        initialPrompt: 'implement everything',
        workspaceCwd: workspace,
        caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 10 },
        completion: reviewDrivenCompletion({
          verifyCommand: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
          crossModelReview: {
            enabled: true,
            blockingSeverities: ['critical', 'high'],
            timeoutSeconds: 10,
            reviewDepth: 'structured',
            pingPong: { enabled: true, reviewerProvider: 'auto', subject: 'impl', maxRounds: 15 },
          },
        }),
        audit: {
          finalAuditMode: 'gate',
          preflightMode: 'off',
          planPacketMode: 'off',
          cleanlinessScan: true,
        },
      });

      const ev = await terminal;
      expect(ev.type).toBe('completed');
      await waitForCondition(() => coordinator.getLoop(state!.id)?.status === 'completed');

      expect(coordinator.getLoop(state.id)?.latestFinalAudit?.status).toBe('passed');
      expect(coordinator.getLoop(state.id)?.lastIteration?.verifyStatus).toBe('passed');
    } finally {
      if (state) await coordinator.cancelLoop(state.id);
    }
  }, 25_000);

  it('keeps ping-pong terminal statuses terminal when a later cancel is requested', async () => {
    coordinator.setPingPongSubjectResolver(async () => 'impl');
    coordinator.setPingPongReviewerForTesting(async () => ({
      verdict: 'APPROVED',
      reviewerProvider: 'codex',
      findings: [],
      ledgerClassifications: [],
      summary: 'approved',
      tokensUsed: 0,
      costCents: 0,
      spawnOutcome: 'settled',
    }));
    driveLoop([
      childResult(`Ping-pong-ready completion.\n${PHRASE}`, [], { costUsd: 0.01 }),
    ]);

    const state = await coordinator.startLoop('chat-rd-pingpong-terminal-idempotent', {
      initialPrompt: 'implement everything',
      workspaceCwd: workspace,
      caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 10, maxCostCents: 1 },
      completion: reviewDrivenCompletion({
        crossModelReview: {
          enabled: true,
          blockingSeverities: ['critical', 'high'],
          timeoutSeconds: 10,
          reviewDepth: 'structured',
          pingPong: { enabled: true, reviewerProvider: 'auto', subject: 'impl', maxRounds: 15 },
        },
      }),
      audit: {
        finalAuditMode: 'off',
        preflightMode: 'off',
        planPacketMode: 'off',
        cleanlinessScan: false,
      },
    });

    await waitForCondition(() => coordinator.getLoop(state.id)?.status === 'cost-exceeded');

    expect(coordinator.getLoop(state.id)?.status).toBe('cost-exceeded');
    await expect(coordinator.cancelLoop(state.id)).resolves.toBe(false);
    expect(coordinator.getLoop(state.id)?.status).toBe('cost-exceeded');
  }, 25_000);

  it('writes a phase fix spec and stops with a handoff after repeated final-audit failures', async () => {
    driveLoop(
      Array.from({ length: 5 }, () => childResult(`Still convinced this is done.\n${PHRASE}`)),
      { tasks: '# Loop Tasks\n\n- [ ] Phase 1: Finish the deliverable\n' },
    );

    let state: Awaited<ReturnType<LoopCoordinator['startLoop']>> | undefined;
    try {
      state = await coordinator.startLoop('chat-rd-phase-recovery', {
        initialPrompt: 'implement everything',
        workspaceCwd: workspace,
        caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 10 },
        completion: reviewDrivenCompletion({ requiredCleanReviewPasses: 1 }),
        audit: {
          finalAuditMode: 'gate',
          preflightMode: 'off',
          planPacketMode: 'off',
          cleanlinessScan: true,
        },
      });

      await waitForCondition(() => coordinator.getLoop(state!.id)?.status === 'no-progress');

      const current = coordinator.getLoop(state.id);
      const paths = resolveLoopArtifactPaths(workspace, state.id);
      const fixSpec = join(paths.phasesDir, 'phase-1.fix.md');

      expect(current?.phaseRecovery?.['phase-1']?.consecutiveFailures).toBe(3);
      expect(current?.endReason).toContain('phase-1');
      expect(existsSync(fixSpec)).toBe(true);
      expect(readFileSync(fixSpec, 'utf8')).toContain('ledger-open');
    } finally {
      if (state) await coordinator.cancelLoop(state.id);
    }
  }, 30_000);

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

  it('counts semantic no-issues review output as clean without the exact phrase', async () => {
    const completed = waitForEvent<{ signal: string }>('loop:completed', 8_000);
    const driver = driveLoop([
      childResult('I re-reviewed the implementation and did not find any actionable issues.'),
      childResult('I checked again and found no remaining work to do.'),
    ]);

    let state: Awaited<ReturnType<LoopCoordinator['startLoop']>> | undefined;
    try {
      state = await startReviewDrivenLoop('chat-rd-semantic-clean');
      await completed;
      expect(coordinator.getLoop(state.id)?.status).toBe('completed');
      expect(driver.invocations()).toBe(2);
    } finally {
      if (state) await coordinator.cancelLoop(state.id);
    }
  }, 12_000);

  it('ignores generated server runtime artifacts when deciding a review pass is clean', async () => {
    const completed = waitForEvent<{ signal: string }>('loop:completed', 8_000);
    const runtimeFiles = [
      fileChange('server/logs/latest.log'),
      fileChange('server/plugins/CoreProtect/database.db'),
      fileChange('server/plugins/OneMoreFloor/database.db-wal'),
      fileChange('server/plugins/FancyHolograms/holograms.yml'),
    ];
    const driver = driveLoop([
      childResult('Fresh review found no actionable issues left.', runtimeFiles),
      childResult('Second review also found nothing left to fix.', runtimeFiles),
    ]);

    let state: Awaited<ReturnType<LoopCoordinator['startLoop']>> | undefined;
    try {
      state = await startReviewDrivenLoop('chat-rd-runtime-artifacts');
      await completed;
      expect(coordinator.getLoop(state.id)?.status).toBe('completed');
      expect(driver.invocations()).toBe(2);
    } finally {
      if (state) await coordinator.cancelLoop(state.id);
    }
  }, 12_000);

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

  it('treats repeated no-change completion with verification evidence as done-needs-review, not a critical stall', async () => {
    const needsReview = waitForEvent<{ reason: string }>('loop:completed-needs-review');
    const driver = driveLoop(Array.from({ length: 8 }, () =>
      childResult('Task complete.\nVerification run:\n- `mvn test` passed.'),
    ));

    let state: Awaited<ReturnType<LoopCoordinator['startLoop']>> | undefined;
    try {
      state = await startReviewDrivenLoop('chat-rd-verified-no-change', {
        maxStalledReviewIterations: 5,
      });
      const ev = await needsReview;
      expect(ev.reason).toContain('verified completion');
      await waitForCondition(() => coordinator.getLoop(state!.id)?.status === 'completed-needs-review');
      expect(coordinator.getLoop(state.id)?.status).toBe('completed-needs-review');
      expect(driver.invocations()).toBe(3);
    } finally {
      if (state) await coordinator.cancelLoop(state.id);
    }
  }, 30_000);

  it('runs the final audit gate before the verified no-change fallback terminates', async () => {
    const terminalOrRejected = Promise.race([
      waitForEvent<{ failure: string }>('loop:claimed-done-but-failed', 15_000)
        .then((ev) => ({ type: 'rejected' as const, failure: ev.failure })),
      waitForEvent<{ reason: string }>('loop:completed-needs-review', 15_000)
        .then((ev) => ({ type: 'needs-review' as const, reason: ev.reason })),
    ]);
    driveLoop(
      Array.from({ length: 8 }, () =>
        childResult('Task complete.\nVerification run:\n- `mvn test` passed.'),
      ),
      { tasks: '# Loop Tasks\n\n- [ ] Finish the deliverable\n' },
    );

    let state: Awaited<ReturnType<LoopCoordinator['startLoop']>> | undefined;
    try {
      state = await coordinator.startLoop('chat-rd-verified-no-change-audit', {
        initialPrompt: 'implement everything',
        workspaceCwd: workspace,
        caps: { ...defaultLoopConfig(workspace, 'x').caps, maxIterations: 10 },
        completion: reviewDrivenCompletion({ maxStalledReviewIterations: 5 }),
        audit: {
          finalAuditMode: 'gate',
          preflightMode: 'off',
          planPacketMode: 'off',
          cleanlinessScan: true,
        },
      });

      const ev = await terminalOrRejected;

      expect(ev.type).toBe('rejected');
      expect(ev.type === 'rejected' ? ev.failure : ev.reason).toContain('final audit');
      expect(coordinator.getLoop(state.id)?.status).toBe('running');
      expect(coordinator.getLoop(state.id)?.latestFinalAudit?.status).toBe('failed');
      expect(coordinator.getLoop(state.id)?.pendingInterventions.at(-1)?.message).toContain('final audit');
    } finally {
      if (state) await coordinator.cancelLoop(state.id);
    }
  }, 30_000);

  it('does not treat ambiguous completion claims as a clean pass', async () => {
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

function initGitRepo(): void {
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(workspace, 'src'), { recursive: true });
  writeFileSync(join(workspace, 'src', 'baseline.ts'), 'export const baseline = true;\n', 'utf8');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
}

function git(...args: string[]): void {
  const result = spawnSync('git', args, {
    cwd: workspace,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
}
