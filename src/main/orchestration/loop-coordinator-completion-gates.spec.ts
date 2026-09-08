/**
 * Unit tests for the extracted completion-gate helpers:
 *
 * 1. `trackRepeatedCompletionEvidence` — bounded evidence-hash ring buffer
 *    (claude2_todo #1c), extracted verbatim from the coordinator.
 * 2. `runFreshEyesReviewGate` D6 (#7) part 3 — instant ALLOW for non-edit
 *    turns: a cached clean verdict (`state.freshEyesCleanForWorkState`) is
 *    reused when the completion attempt's iteration touched no production
 *    files; any production change or blocked review invalidates the cache,
 *    and a contradiction-forced review always runs for real. Per Decision
 *    15(b) this rule no longer sits behind `antiSelfGrading`, so the cases
 *    below pin both halves: the reuse fires with the flag off, and both
 *    bypasses still hold with the flag off.
 */

import { describe, expect, it, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  runFreshEyesReviewGate,
  trackRepeatedCompletionEvidence,
  workspaceAnchorDigest,
} from './loop-coordinator-completion-gates';
import { collectWorkspaceDiff } from './loop-diff';
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

/**
 * A real git checkout with one commit.
 *
 * The instant-ALLOW anchor is a digest of an actual `git diff`, so a bare temp
 * directory would make every reuse test pass for the wrong reason — a non-git
 * workspace yields a null digest and deliberately never reuses. These tests
 * have to be able to dirty the tree and watch the digest move.
 */
function makeGitWorkspace(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-spec-'));
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'spec@example.invalid');
  git('config', 'user.name', 'Gates Spec');
  git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  git('add', '-A');
  git('commit', '-qm', 'seed');
  return dir;
}

function makeState(over: Partial<LoopState> = {}): LoopState {
  const workspace = makeGitWorkspace();
  const cfg = defaultLoopConfig(workspace, 'do thing');
  cfg.completion.antiSelfGrading = true;
  cfg.completion.crossModelReview = {
    enabled: true,
    blockingSeverities: ['critical', 'high'],
    timeoutSeconds: 10,
    reviewDepth: 'structured',
  };
  return withCleanVerdictAnchor({
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
  });
}

/**
 * A test asking for `freshEyesCleanForWorkState: true` means "a clean verdict
 * was issued against this tree", so anchor it to the tree as the production
 * code does. Without this every reuse test would fail for the uninteresting
 * reason that no digest was ever recorded, and the interesting cases — the
 * tree moving underneath a cached verdict — could not be written at all.
 * A test that sets its own digest keeps it.
 */
function withCleanVerdictAnchor(state: LoopState): LoopState {
  if (state.freshEyesCleanForWorkState === true && state.freshEyesCleanWorkspaceDigest === undefined) {
    state.freshEyesCleanWorkspaceDigest =
      workspaceAnchorDigest(state.config.workspaceCwd) ?? undefined;
  }
  return state;
}

/** Dirty the workspace the way a concurrent writer would — unobserved by the loop. */
function writeUnobservedFile(state: LoopState, rel: string, body: string): void {
  fs.writeFileSync(path.join(state.config.workspaceCwd, rel), body);
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

describe('runFreshEyesReviewGate — D6 instant ALLOW for non-edit turns', () => {
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

  // Decision 15(b): this rule alone was un-gated from `antiSelfGrading`. It
  // used to be opt-in, which meant it never fired on the shipped default and
  // every repeat "done" claim on an unchanged tree paid for another review.
  // `makeState` turns the flag ON for the demotion tests further down, so this
  // is the one that proves the reuse does not depend on it.
  it('reuses the cached verdict at the shipped default, with antiSelfGrading off', async () => {
    const state = makeState({ freshEyesCleanForWorkState: true });
    state.config.completion.antiSelfGrading = false;
    const reviewer = vi.fn(cleanReview);
    const args = gateArgs(state, makeIteration({ filesChanged: [] }), reviewer);

    const result = await runFreshEyesReviewGate(args);

    expect(reviewer).not.toHaveBeenCalled();
    expect(result).toEqual({ blocked: false, ran: true, errored: false });
    expect(args.emit).toHaveBeenCalledWith(
      'loop:fresh-eyes-review-passed',
      expect.objectContaining({ instantAllow: true }),
    );
  });

  // The un-gating is only safe because the cache still invalidates. With the
  // flag off, a production edit must STILL force a real review — otherwise
  // Decision 15(b) would have turned the reuse into a blanket review skip.
  it('still runs the reviewer for a production edit with antiSelfGrading off', async () => {
    const state = makeState({ freshEyesCleanForWorkState: true });
    state.config.completion.antiSelfGrading = false;
    const reviewer = vi.fn(cleanReview);
    const iteration = makeIteration({
      filesChanged: [{ path: 'src/app.ts', additions: 1, deletions: 0, contentHash: 'h' }],
    });

    await runFreshEyesReviewGate(gateArgs(state, iteration, reviewer));

    expect(reviewer).toHaveBeenCalledOnce();
  });

  // Same for the other bypass: a contradiction between the agent's claim and
  // verify must not be answerable from cache, flag or no flag.
  it('still runs a contradiction-forced review with antiSelfGrading off', async () => {
    const state = makeState({
      freshEyesCleanForWorkState: true,
      freshEyesForcedByContradiction: true,
    });
    state.config.completion.antiSelfGrading = false;
    const reviewer = vi.fn(cleanReview);

    await runFreshEyesReviewGate(gateArgs(state, makeIteration({ filesChanged: [] }), reviewer));

    expect(reviewer).toHaveBeenCalledOnce();
  });

  // The first fresh-eyes gate finding (HIGH). `iteration.filesChanged` is the
  // delta the coordinator OBSERVED for this attempt, and the observer
  // re-baselines per attempt — so a write that lands between two attempts (a
  // concurrent agent, James's editor, a background job) is absorbed into the
  // next baseline and never appears in any iteration's `filesChanged`. Keyed
  // on observation alone, that turns an edit turn into a free pass.
  it('runs the reviewer when the tree moved unobserved between attempts', async () => {
    const state = makeState({ freshEyesCleanForWorkState: true });
    const reviewer = vi.fn(cleanReview);
    // Nothing in `filesChanged`: by construction the loop never saw this.
    writeUnobservedFile(state, 'src-app.ts', 'export const x = 1;\n');

    await runFreshEyesReviewGate(gateArgs(state, makeIteration({ filesChanged: [] }), reviewer));

    expect(reviewer).toHaveBeenCalledOnce();
  });

  // Same finding, second route: a failed git comparison returns `changes: []`
  // with degraded coverage, which is indistinguishable from "nothing changed"
  // if you only look at the array. Reverting the tree to the reviewed state
  // must be what earns the reuse — not an empty array.
  it('reuses only when the tree matches, not merely when nothing was observed', async () => {
    const state = makeState({ freshEyesCleanForWorkState: true });
    const iteration = makeIteration({ filesChanged: [] });

    writeUnobservedFile(state, 'drifted.ts', 'export const y = 2;\n');
    const afterDrift = vi.fn(cleanReview);
    await runFreshEyesReviewGate(gateArgs(state, iteration, afterDrift));
    expect(afterDrift, 'drift must force a real review').toHaveBeenCalledOnce();

    // That review re-anchored the verdict to the drifted tree, so an attempt
    // against the SAME tree now reuses.
    const unchanged = vi.fn(cleanReview);
    await runFreshEyesReviewGate(gateArgs(state, iteration, unchanged));
    expect(unchanged, 'an unchanged tree reuses').not.toHaveBeenCalled();
  });

  // A workspace that cannot produce a diff cannot anchor a verdict. An empty
  // diff from a non-git tree is the absence of evidence, not evidence of
  // absence, so the rule must fail closed rather than reuse.
  //
  // Scope, stated precisely because two attempts to word this were wrong.
  // This pins the BEHAVIOUR (a non-git workspace never reuses), not the
  // `workspaceDigest !== null` clause specifically — deleting that clause
  // leaves this green, because the stored digest is `undefined` and
  // `undefined === null` is already false, so the equality check blocks reuse
  // on its own. The clause is kept as belt-and-braces against a persisted
  // null, not because it is the only thing standing here.
  it('never reuses in a workspace that cannot produce a diff', async () => {
    const state = makeState({ freshEyesCleanForWorkState: true });
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'gates-nogit-'));
    state.config.workspaceCwd = nonGit;
    state.config.executionCwd = nonGit;
    state.freshEyesCleanWorkspaceDigest = workspaceAnchorDigest(nonGit) ?? undefined;
    expect(state.freshEyesCleanWorkspaceDigest, 'precondition: nothing anchorable').toBeUndefined();
    const reviewer = vi.fn(cleanReview);

    await runFreshEyesReviewGate(gateArgs(state, makeIteration({ filesChanged: [] }), reviewer));

    expect(reviewer).toHaveBeenCalledOnce();
  });

  // Pass 2 of the fresh-eyes gate. `collectWorkspaceDiff` diffs against HEAD,
  // so committing the work returns every one of its git calls to empty — a
  // digest over the diff ALONE is unchanged across a commit that added real
  // production code. With the commit ratchet on, or an agent that commits its
  // own work, that reinstated the exact hole the digest was added to close.
  it('runs the reviewer when the work was committed rather than left dirty', async () => {
    const state = makeState({ freshEyesCleanForWorkState: true });
    const cwd = state.config.workspaceCwd;
    const git = (...args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8' });

    // Precondition: the cached verdict was issued against this clean tree.
    expect(collectWorkspaceDiff(cwd).diff, 'precondition: tree is clean').toBe('');

    writeUnobservedFile(state, 'committed.ts', 'export const shipped = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'agent committed its own work');
    // The tree is clean again, so the diff half of the digest is unchanged.
    expect(collectWorkspaceDiff(cwd).diff, 'the diff really did return to empty').toBe('');

    const reviewer = vi.fn(cleanReview);
    await runFreshEyesReviewGate(gateArgs(state, makeIteration({ filesChanged: [] }), reviewer));

    expect(reviewer, 'HEAD moved, so the verdict must not be reused').toHaveBeenCalledOnce();
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
