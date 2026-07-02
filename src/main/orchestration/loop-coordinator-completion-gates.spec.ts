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
import type { FreshEyesReviewer } from './loop-fresh-eyes-reviewer';
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

const blockedReview: FreshEyesReviewer = async () => ({
  findings: [
    { title: 'Bug', body: 'Broken', severity: 'critical', confidence: 0.9 },
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

  it('runs the reviewer when antiSelfGrading is off even with a cached verdict', async () => {
    const state = makeState({ freshEyesCleanForWorkState: true });
    state.config.completion.antiSelfGrading = false;
    const reviewer = vi.fn(cleanReview);

    await runFreshEyesReviewGate(gateArgs(state, makeIteration(), reviewer));

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
