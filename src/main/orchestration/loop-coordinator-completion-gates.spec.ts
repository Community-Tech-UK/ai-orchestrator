/**
 * Unit tests for the extracted completion-gate helpers:
 *
 * 1. `trackRepeatedCompletionEvidence` — bounded evidence-hash ring buffer
 *    (claude2_todo #1c), extracted verbatim from the coordinator.
 * 2. `runFreshEyesReviewGate` D6 (#7) part 3 — instant ALLOW for non-edit
 *    turns: a cached clean verdict (`state.freshEyesCleanForWorkState`) is
 *    reused when the completion attempt's iteration touched no production
 *    files; any production change or blocked review invalidates the cache,
 *    and a contradiction-forced review always runs for real.
 */

import { describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  runFreshEyesReviewGate,
  trackRepeatedCompletionEvidence,
} from './loop-coordinator-completion-gates';
import { classifyFreshEyesBlocking } from './fresh-eyes-blocking';
import type { FreshEyesFinding, FreshEyesReviewer } from './loop-fresh-eyes-reviewer';
import {
  defaultLoopConfig,
  type LoopIteration,
  type LoopState,
} from '../../shared/types/loop.types';

function makeIteration(over: Partial<LoopIteration> = {}): LoopIteration {
  return {
    id: 'iter',
    loopRunId: 'loop-1',
    seq: 0,
    stage: 'IMPLEMENT',
    startedAt: 0,
    endedAt: 0,
    childInstanceId: null,
    tokens: 0,
    costCents: 0,
    filesChanged: [],
    filesRead: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    unresolvedToolCalls: false,
    workHash: 'wh',
    outputSimilarityToPrev: null,
    outputExcerpt: '',
    outputFull: '',
    progressVerdict: 'OK',
    progressSignals: [],
    completionSignalsFired: [],
    verifyStatus: 'not-run',
    verifyOutputExcerpt: '',
    ...over,
  };
}

function makeState(over: Partial<LoopState> = {}): LoopState {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-spec-'));
  const cfg = defaultLoopConfig(workspace, 'do thing');
  cfg.completion.antiSelfGrading = true;
  cfg.completion.crossModelReview = {
    enabled: true,
    blockingSeverities: ['critical', 'high'],
    timeoutSeconds: 10,
    reviewDepth: 'structured',
  };
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    config: cfg,
    status: 'running',
    startedAt: 0,
    endedAt: null,
    totalIterations: 0,
    totalTokens: 0,
    totalCostCents: 0,
    currentStage: 'IMPLEMENT',
    pendingInterventions: [],
    completedFileRenameObserved: false,
    doneSentinelPresentAtStart: false,
    planChecklistFullyCheckedAtStart: false,
    uncompletedPlanFilesAtStart: [],
    manualReviewOnly: false,
    tokensSinceLastTestImprovement: 0,
    highestTestPassCount: 0,
    iterationsOnCurrentStage: 0,
    recentWarnIterationSeqs: [],
    completionAttempts: 0,
    loopTasksLedgerResolvedAtStart: false,
    ...over,
  };
}

const cleanReview: FreshEyesReviewer = async () => ({
  findings: [],
  reviewersUsed: ['stub'],
  summary: 'clean',
});

// WS-A3: a severity-blocking finding needs anchor-verified evidence (or a
// deterministic-gate classification) to actually block completion — a bare
// severity-only finding with no anchor is now DEMOTED (see the "WS-A3
// evidence-anchored blocking" describe block below). This fixture uses
// `deterministic-gate` so the pre-existing "a review blocks" tests exercise
// that always-blocks path without needing a real git-backed diff artifact.
const blockedReview: FreshEyesReviewer = async () => ({
  findings: [
    { title: 'Bug', body: 'Broken', severity: 'critical', confidence: 0.9, evidenceClass: 'deterministic-gate' },
  ],
  reviewersUsed: ['stub'],
  summary: 'blocked',
});

function gateArgs(state: LoopState, iteration: LoopIteration, reviewer: FreshEyesReviewer) {
  return {
    state,
    signalId: 'declared-complete',
    iteration,
    verifyOutput: '',
    reviewer,
    emit: vi.fn(),
    setConvergenceNote: vi.fn(),
  };
}

describe('runFreshEyesReviewGate — D6 instant ALLOW (anti-self-grading)', () => {
  it('reuses a cached clean verdict for a non-edit iteration without invoking the reviewer', async () => {
    const state = makeState({ freshEyesCleanForWorkState: true });
    const reviewer = vi.fn(cleanReview);
    const args = gateArgs(state, makeIteration({ filesChanged: [] }), reviewer);

    const result = await runFreshEyesReviewGate(args);

    expect(result).toEqual({ blocked: false, ran: true, errored: false });
    expect(reviewer).not.toHaveBeenCalled();
    expect(args.emit).toHaveBeenCalledWith(
      'loop:fresh-eyes-review-passed',
      expect.objectContaining({ instantAllow: true }),
    );
  });

  it('runs the reviewer when the iteration changed production files despite a cached verdict', async () => {
    const state = makeState({ freshEyesCleanForWorkState: true });
    const reviewer = vi.fn(cleanReview);
    const iteration = makeIteration({
      filesChanged: [{ path: 'src/app.ts', additions: 1, deletions: 0, contentHash: 'h' }],
    });

    const result = await runFreshEyesReviewGate(gateArgs(state, iteration, reviewer));

    expect(reviewer).toHaveBeenCalledOnce();
    expect(result.ran).toBe(true);
  });

  // L2: the instant ALLOW stays behind the `antiSelfGrading` opt-in. Skipping a
  // real cross-model review by default is a trust-boundary change the plan does
  // not authorise, so the shipped default must still run the reviewer.
  it('runs the reviewer when antiSelfGrading is off even with a cached verdict', async () => {
    const state = makeState({ freshEyesCleanForWorkState: true });
    state.config.completion.antiSelfGrading = false;
    const reviewer = vi.fn(cleanReview);

    await runFreshEyesReviewGate(gateArgs(state, makeIteration({ filesChanged: [] }), reviewer));

    expect(reviewer).toHaveBeenCalledOnce();
  });

  it('runs the reviewer when no clean verdict is cached', async () => {
    const state = makeState({ freshEyesCleanForWorkState: undefined });
    const reviewer = vi.fn(cleanReview);

    await runFreshEyesReviewGate(gateArgs(state, makeIteration(), reviewer));

    expect(reviewer).toHaveBeenCalledOnce();
  });

  it('a contradiction-forced review bypasses the cache and runs for real', async () => {
    const state = makeState({
      freshEyesCleanForWorkState: true,
      freshEyesForcedByContradiction: true,
    });
    const reviewer = vi.fn(cleanReview);

    await runFreshEyesReviewGate(gateArgs(state, makeIteration(), reviewer));

    expect(reviewer).toHaveBeenCalledOnce();
    expect(state.freshEyesForcedByContradiction).toBe(false);
  });

  it('caches the clean verdict after a real clean review', async () => {
    const state = makeState();
    expect(state.freshEyesCleanForWorkState).toBeUndefined();

    const result = await runFreshEyesReviewGate(gateArgs(state, makeIteration(), cleanReview));

    expect(result).toEqual({ blocked: false, ran: true, errored: false });
    expect(state.freshEyesCleanForWorkState).toBe(true);
  });

  it('invalidates the cached verdict when a review blocks', async () => {
    const state = makeState({ freshEyesCleanForWorkState: true });
    // Production change forces the real review to run (no instant allow).
    const iteration = makeIteration({
      filesChanged: [{ path: 'src/app.ts', additions: 1, deletions: 0, contentHash: 'h' }],
    });

    const result = await runFreshEyesReviewGate(gateArgs(state, iteration, blockedReview));

    expect(result.blocked).toBe(true);
    expect(state.freshEyesCleanForWorkState).toBe(false);
  });

  it('does not treat loop-state-dir noise as a production change', async () => {
    const state = makeState({ freshEyesCleanForWorkState: true });
    const reviewer = vi.fn(cleanReview);
    const iteration = makeIteration({
      filesChanged: [
        { path: '.aio-loop-state/loop-1/NOTES.md', additions: 1, deletions: 0, contentHash: 'h' },
      ],
    });

    const result = await runFreshEyesReviewGate(gateArgs(state, iteration, reviewer));

    expect(reviewer).not.toHaveBeenCalled();
    expect(result).toEqual({ blocked: false, ran: true, errored: false });
  });

  it('WS6 Task 4: fires captureReviewLesson with the blocking verdict on a block', async () => {
    const state = makeState({ freshEyesCleanForWorkState: true });
    const iteration = makeIteration({
      filesChanged: [{ path: 'src/app.ts', additions: 1, deletions: 0, contentHash: 'h' }],
    });
    const captureReviewLesson = vi.fn();

    const result = await runFreshEyesReviewGate({
      ...gateArgs(state, iteration, blockedReview),
      captureReviewLesson,
    });

    expect(result.blocked).toBe(true);
    expect(captureReviewLesson).toHaveBeenCalledTimes(1);
    const verdict = captureReviewLesson.mock.calls[0][0];
    expect(verdict.reviewers).toEqual(['stub']);
    expect(verdict.findings[0]).toMatchObject({ title: 'Bug', severity: 'critical' });
    expect(verdict.summary).toBe('blocked');
  });

  it('WS6 Task 4: does NOT fire captureReviewLesson on a clean pass', async () => {
    const state = makeState({ freshEyesCleanForWorkState: undefined });
    const captureReviewLesson = vi.fn();

    await runFreshEyesReviewGate({
      ...gateArgs(state, makeIteration(), cleanReview),
      captureReviewLesson,
    });

    expect(captureReviewLesson).not.toHaveBeenCalled();
  });
});

describe('classifyFreshEyesBlocking (WS-A3 blocking-rule matrix)', () => {
  const DIFF = [
    'diff --git a/src/a.ts b/src/a.ts',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,1 +1,2 @@',
    ' unchanged',
    '+const guard = checkAuth();',
  ].join('\n');

  it('lets a deterministic-gate finding block unconditionally, with no anchor needed', () => {
    const finding: FreshEyesFinding = {
      title: 'Potential secret redacted before external review',
      body: '1 potential secret was redacted from the review payload.',
      severity: 'critical',
      confidence: 1,
      evidenceClass: 'deterministic-gate',
    };
    const { blocking, demoted } = classifyFreshEyesBlocking([finding], '');
    expect(blocking).toEqual([finding]);
    expect(demoted).toEqual([]);
  });

  it('blocks a severity-blocking finding whose anchor verifies against the persisted artifact', () => {
    const finding: FreshEyesFinding = {
      title: 'Missing auth guard', body: 'The route never checks auth.', severity: 'high', confidence: 0.9,
      anchor: { file: 'src/a.ts', quote: 'const guard = checkAuth();' },
    };
    const { blocking, demoted } = classifyFreshEyesBlocking([finding], DIFF);
    expect(demoted).toEqual([]);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].anchorStatus).toBe('verified');
  });

  it('re-anchors (and still blocks) when the quote is real but at a location the finding did not cite', () => {
    const finding: FreshEyesFinding = {
      title: 'Missing auth guard', body: 'x', severity: 'high', confidence: 0.9,
      anchor: { file: 'src/other.ts', quote: 'const guard = checkAuth();' },
    };
    const { blocking, demoted } = classifyFreshEyesBlocking([finding], DIFF);
    expect(demoted).toEqual([]);
    expect(blocking).toHaveLength(1);
    expect(blocking[0].anchorStatus).toBe('re-anchored');
    expect(blocking[0].anchor?.file).toBe('src/a.ts');
  });

  it('demotes a severity-blocking finding whose anchor cannot be verified, with a reason', () => {
    const finding: FreshEyesFinding = {
      title: 'Hallucinated bug', body: 'x', severity: 'critical', confidence: 0.9,
      anchor: { quote: 'this text is nowhere in the diff' },
    };
    const { blocking, demoted } = classifyFreshEyesBlocking([finding], DIFF);
    expect(blocking).toEqual([]);
    expect(demoted).toHaveLength(1);
    expect(demoted[0].anchorStatus).toBe('evidence_unverified');
    expect(demoted[0].demotedReason).toMatch(/could not be located/);
  });

  it('demotes a severity-blocking finding that cites no evidence at all, with a reason', () => {
    const finding: FreshEyesFinding = { title: 'Vague concern', body: 'x', severity: 'high', confidence: 0.5 };
    const { blocking, demoted } = classifyFreshEyesBlocking([finding], DIFF);
    expect(blocking).toEqual([]);
    expect(demoted).toHaveLength(1);
    expect(demoted[0].demotedReason).toMatch(/No locatable evidence/);
  });
});

describe('runFreshEyesReviewGate (WS-A3 demotion visibility, end to end)', () => {
  it('passes (nothing blocks) but still surfaces a demoted finding on the pass event', async () => {
    const state = makeState();
    const iteration = makeIteration({
      filesChanged: [{ path: 'src/app.ts', additions: 1, deletions: 0, contentHash: 'h' }],
    });
    const unanchoredButSevere: FreshEyesReviewer = async () => ({
      findings: [{ title: 'Unverifiable claim', body: 'x', severity: 'critical', confidence: 0.9 }],
      reviewersUsed: ['stub'],
      summary: 'one unverifiable finding',
    });

    const args = gateArgs(state, iteration, unanchoredButSevere);
    const result = await runFreshEyesReviewGate(args);

    expect(result.blocked).toBe(false);
    expect(result.demotedFindings).toHaveLength(1);
    expect(result.demotedFindings?.[0].demotedReason).toBeTruthy();
    expect(args.emit).toHaveBeenCalledWith(
      'loop:fresh-eyes-review-passed',
      expect.objectContaining({ demotedFindings: expect.arrayContaining([expect.objectContaining({ title: 'Unverifiable claim' })]) }),
    );
  });

  it('blocks on the deterministic-gate finding while a co-occurring unverifiable finding is demoted, not dropped', async () => {
    const state = makeState();
    const iteration = makeIteration({
      filesChanged: [{ path: 'src/app.ts', additions: 1, deletions: 0, contentHash: 'h' }],
    });
    const mixedReview: FreshEyesReviewer = async () => ({
      findings: [
        {
          title: 'Potential secret redacted before external review',
          body: 'redacted', severity: 'critical', confidence: 1, evidenceClass: 'deterministic-gate',
        },
        { title: 'Unverifiable claim', body: 'x', severity: 'high', confidence: 0.7 },
      ],
      reviewersUsed: ['stub'],
      summary: 'mixed',
    });

    const args = gateArgs(state, iteration, mixedReview);
    const result = await runFreshEyesReviewGate(args);

    expect(result.blocked).toBe(true);
    expect(result.demotedFindings).toHaveLength(1);
    expect(result.demotedFindings?.[0].title).toBe('Unverifiable claim');
    expect(args.emit).toHaveBeenCalledWith(
      'loop:fresh-eyes-review-blocked',
      expect.objectContaining({
        blockingFindings: [expect.objectContaining({ title: 'Potential secret redacted before external review' })],
        demotedFindings: expect.arrayContaining([expect.objectContaining({ title: 'Unverifiable claim' })]),
      }),
    );
  });
});

describe('runFreshEyesReviewGate (WS-B9 exact reviewer coverage + per-angle cache)', () => {
  it('a required angle that parse_failed forces errored:true, not a clean pass, even though something ran', async () => {
    const state = makeState();
    const iteration = makeIteration({
      filesChanged: [{ path: 'src/app.ts', additions: 1, deletions: 0, contentHash: 'h' }],
    });
    const shortfallReview: FreshEyesReviewer = async () => ({
      findings: [],
      reviewersUsed: ['gemini'],
      summary: 'one reviewer ran clean, one angle parse-failed',
      coverage: [
        { angle: 'correctness', reviewerProvider: 'gemini', status: 'used', findingCount: 0, required: true },
        {
          angle: 'security', reviewerProvider: 'codex', status: 'parse_failed', findingCount: 0,
          required: true, activationReason: 'unparseable output',
        },
      ],
    });

    const args = gateArgs(state, iteration, shortfallReview);
    const result = await runFreshEyesReviewGate(args);

    expect(result.blocked).toBe(false);
    expect(result.errored).toBe(true);
    expect(result.coverage).toHaveLength(2);
    expect(args.emit).toHaveBeenCalledWith(
      'loop:fresh-eyes-review-failed',
      expect.objectContaining({
        error: expect.stringContaining('security:parse_failed'),
        coverage: expect.arrayContaining([expect.objectContaining({ angle: 'security', status: 'parse_failed' })]),
      }),
    );
    // Never a clean-verdict cache write on a coverage shortfall.
    expect(state.freshEyesCleanForWorkState).not.toBe(true);
  });

  it('full required coverage (all used) stays a clean pass and carries coverage on the result/event', async () => {
    const state = makeState();
    const iteration = makeIteration({
      filesChanged: [{ path: 'src/app.ts', additions: 1, deletions: 0, contentHash: 'h' }],
    });
    const fullCoverageReview: FreshEyesReviewer = async () => ({
      findings: [],
      reviewersUsed: ['gemini'],
      summary: 'clean',
      coverage: [
        { angle: 'correctness', reviewerProvider: 'gemini', status: 'used', findingCount: 0, required: true },
        { angle: 'local-advisory', reviewerProvider: 'local-model', status: 'used', findingCount: 0, required: false },
      ],
    });

    const args = gateArgs(state, iteration, fullCoverageReview);
    const result = await runFreshEyesReviewGate(args);

    expect(result).toEqual(expect.objectContaining({ blocked: false, ran: true, errored: false }));
    expect(result.coverage).toHaveLength(2);
    expect(state.freshEyesCleanForWorkState).toBe(true);
    expect(args.emit).toHaveBeenCalledWith(
      'loop:fresh-eyes-review-passed',
      expect.objectContaining({ coverage: expect.any(Array) }),
    );
  });

  it('a reviewer implementation that reports no coverage at all is unaffected (backward compatible)', async () => {
    // `cleanReview` (existing fixture) never sets `coverage` — the shortfall
    // check must be a no-op, not a false shortfall.
    const state = makeState();
    const result = await runFreshEyesReviewGate(gateArgs(state, makeIteration(), cleanReview));

    expect(result).toEqual({ blocked: false, ran: true, errored: false });
    expect(result.coverage).toBeUndefined();
  });

  it('binds the per-angle cache to this run\'s LoopState: a second attempt with an identical key reuses it', async () => {
    const state = makeState();
    const cacheAwareReview: FreshEyesReviewer = async (input) => {
      const keyInput = {
        reviewerProvider: 'gemini', model: 'auto', angleId: 'correctness',
        promptVersion: 'pv1', rulesHash: 'none', workHash: 'wh-unchanged',
      };
      const hit = input.reviewAngleCache?.lookup(keyInput);
      if (hit) {
        return {
          findings: [], reviewersUsed: ['gemini'], summary: 'clean (reused)',
          coverage: [{
            angle: 'correctness', reviewerProvider: 'gemini', status: 'cached',
            findingCount: 0, required: true, activationReason: hit.activationReason,
          }],
        };
      }
      input.reviewAngleCache?.store({
        ...keyInput,
        review: {
          reviewerId: 'gemini', reviewType: 'structured',
          scores: {
            correctness: { reasoning: 'ok', score: 4, issues: [] },
            completeness: { reasoning: 'ok', score: 4, issues: [] },
            security: { reasoning: 'ok', score: 4, issues: [] },
            consistency: { reasoning: 'ok', score: 4, issues: [] },
          },
          overallVerdict: 'APPROVE', summary: 'clean', timestamp: 1, durationMs: 1, parseSuccess: true,
        },
      });
      return {
        findings: [], reviewersUsed: ['gemini'], summary: 'clean (live)',
        coverage: [{ angle: 'correctness', reviewerProvider: 'gemini', status: 'used', findingCount: 0, required: true }],
      };
    };

    const first = await runFreshEyesReviewGate(gateArgs(
      state,
      makeIteration({ filesChanged: [{ path: 'src/app.ts', additions: 1, deletions: 0, contentHash: 'h1' }] }),
      cacheAwareReview,
    ));
    expect(first.coverage?.[0]).toMatchObject({ status: 'used' });

    const second = await runFreshEyesReviewGate(gateArgs(
      state,
      makeIteration({ filesChanged: [{ path: 'src/app.ts', additions: 1, deletions: 0, contentHash: 'h2' }] }),
      cacheAwareReview,
    ));
    expect(second.coverage?.[0]).toMatchObject({ status: 'cached' });
  });
});

describe('trackRepeatedCompletionEvidence', () => {
  function track(state: LoopState, notes: Map<string, string>, decision: 'continue' | 'stop' = 'continue') {
    trackRepeatedCompletionEvidence({
      state,
      candidate: { id: 'declared-complete', sufficient: true, detail: 'intent' },
      verifyStatus: 'passed',
      beltAndBracesPassed: false,
      resolution: { decision, outcome: 'rename-gate' },
      convergenceNotes: notes,
    });
  }

  it('climbs repeatedEvidenceCount and surfaces a stuck note on identical evidence', () => {
    const state = makeState();
    const notes = new Map<string, string>();

    track(state, notes);
    expect(state.repeatedEvidenceCount).toBe(1);
    expect(notes.size).toBe(0);

    track(state, notes);
    expect(state.repeatedEvidenceCount).toBe(2);
    expect(notes.get(state.id)).toContain('presented 2 times without change');
  });

  it('resets the repeat count when the evidence changes', () => {
    const state = makeState();
    const notes = new Map<string, string>();

    track(state, notes);
    track(state, notes);
    expect(state.repeatedEvidenceCount).toBe(2);

    state.unresolvedReviewThreads = ['new-thread'];
    track(state, notes);
    expect(state.repeatedEvidenceCount).toBe(1);
  });
});
