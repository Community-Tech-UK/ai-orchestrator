import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoopIteration, LoopState } from '../../shared/types/loop.types';
import {
  defaultLoopConfig,
  defaultPingPongState,
} from '../../shared/types/loop.types';
import { evaluatePingPongCompletion } from './loop-pingpong-completion';
import type {
  PingPongReviewer,
  PingPongReviewResult,
} from './agentic-pingpong-reviewer';

function makeState(workspace: string, overrides: Partial<LoopState> = {}): LoopState {
  const config = defaultLoopConfig(workspace, 'implement the widget feature');
  config.completion.mode = 'review-driven';
  config.completion.crossModelReview = {
    enabled: true,
    blockingSeverities: ['critical', 'high'],
    timeoutSeconds: 90,
    reviewDepth: 'structured',
    pingPong: { enabled: true, reviewerProvider: 'auto', subject: 'impl', maxRounds: 15 },
  };
  config.provider = 'claude';
  const state = {
    id: 'loop-test',
    chatId: 'chat-1',
    config,
    status: 'running',
    startedAt: 0,
    endedAt: null,
    totalIterations: 1,
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
    iterationsOnCurrentStage: 1,
    recentWarnIterationSeqs: [],
    completionAttempts: 0,
    loopTasksLedgerResolvedAtStart: false,
    pingPong: defaultPingPongState(),
    ...overrides,
  } as unknown as LoopState;
  return state;
}

function makeIteration(filesChanged: { path: string }[] = []): LoopIteration {
  return {
    filesChanged: filesChanged.map((f) => ({ path: f.path, additions: 1, deletions: 0, contentHash: 'h' })),
  } as unknown as LoopIteration;
}

function reviewResult(partial: Partial<PingPongReviewResult>): PingPongReviewResult {
  return {
    verdict: 'APPROVED',
    reviewerProvider: 'codex',
    findings: [],
    ledgerClassifications: [],
    summary: 'looks good',
    tokensUsed: 100,
    costCents: 5,
    spawnOutcome: 'settled',
    ...partial,
  };
}

const cleanReview = (clean: boolean) => vi.fn().mockResolvedValue({ clean, confidence: 1, reason: 't' });

function baseDeps(state: LoopState, reviewer: PingPongReviewer, clean = true) {
  return {
    state,
    iteration: makeIteration(),
    fullOutput: 'done',
    seq: 0,
    stage: 'IMPLEMENT' as const,
    classifyCleanReview: cleanReview(clean),
    emit: vi.fn(),
    isCancelled: () => false,
    signal: new AbortController().signal,
    foldReviewerSpend: vi.fn(),
    reviewer,
  };
}

describe('evaluatePingPongCompletion', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'pingpong-'));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('returns null without calling the reviewer when the builder has not declared done', async () => {
    const state = makeState(workspace);
    const reviewer = vi.fn<PingPongReviewer>();
    const result = await evaluatePingPongCompletion(baseDeps(state, reviewer, false));
    expect(result).toBeNull();
    expect(reviewer).not.toHaveBeenCalled();
  });

  it('converges (completed) on mutual APPROVED + builder done', async () => {
    const state = makeState(workspace);
    const reviewer = vi.fn<PingPongReviewer>().mockResolvedValue(reviewResult({ verdict: 'APPROVED' }));
    const deps = baseDeps(state, reviewer);
    const result = await evaluatePingPongCompletion(deps);
    expect(result?.status).toBe('completed');
    expect(state.pingPong?.roundCount).toBe(1);
    expect(deps.foldReviewerSpend).toHaveBeenCalledWith(100, 5);
  });

  it('injects an intervention and continues on CHANGES_REQUESTED with blocking findings', async () => {
    const state = makeState(workspace);
    const reviewer = vi.fn<PingPongReviewer>().mockResolvedValue(
      reviewResult({
        verdict: 'CHANGES_REQUESTED',
        findings: [
          { title: 'null deref', severity: 'high', evidence: 'widget.ts:42', body: 'crashes', novelty: 'new' },
        ],
      }),
    );
    const result = await evaluatePingPongCompletion(baseDeps(state, reviewer));
    expect(result).toBeNull();
    expect(state.pendingInterventions.length).toBe(1);
    expect(state.pendingInterventions[0]?.message).toContain('null deref');
    expect(state.pingPong?.ledger.length).toBe(1);
    expect(state.pingPong?.roundCount).toBe(1);
  });

  it('is fail-closed: repeated reviewer-QUALITY faults terminate as reviewer-unreliable, never a pass', async () => {
    const state = makeState(workspace);
    // The reviewer RAN but emitted unusable output (malformed_output) — a genuine
    // reviewer-quality fault, escalated at the strict 3-round ceiling.
    const reviewer = vi.fn<PingPongReviewer>().mockResolvedValue(
      reviewResult({
        verdict: 'UNRELIABLE',
        reviewerProvider: 'codex',
        fault: 'malformed_output',
        reason: 'empty or unparseable output',
      }),
    );
    // Each call declares done again; UNRELIABLE should never converge.
    let result = await evaluatePingPongCompletion(baseDeps(state, reviewer));
    expect(result).toBeNull();
    result = await evaluatePingPongCompletion(baseDeps(state, reviewer));
    expect(result).toBeNull();
    result = await evaluatePingPongCompletion(baseDeps(state, reviewer));
    expect(result?.status).toBe('reviewer-unreliable');
    expect(state.pingPong?.roundCount).toBe(0); // unreliable rounds never count
  });

  it('distinguishes availability faults: a rate-limited reviewer terminates as reviewer-unavailable, NOT reviewer-unreliable', async () => {
    const state = makeState(workspace);
    // The reviewer provider was throttled — an availability fault that says
    // nothing about the code. Uses the more lenient 6-round ceiling and a DISTINCT
    // terminal status so a throttled Codex is never reported as "the reviewer
    // judged the code unreliable".
    const reviewer = vi.fn<PingPongReviewer>().mockResolvedValue(
      reviewResult({
        verdict: 'UNRELIABLE',
        reviewerProvider: 'codex',
        fault: 'rate_limited',
        reason: 'usage/rate-limit notice',
      }),
    );
    let result: Awaited<ReturnType<typeof evaluatePingPongCompletion>> = null;
    // Below the quality ceiling (3) it must NOT mis-terminate as reviewer-unreliable.
    for (let i = 0; i < 5; i++) {
      result = await evaluatePingPongCompletion(baseDeps(state, reviewer));
      expect(result).toBeNull();
    }
    // The 6th consecutive availability fault crosses the lenient ceiling.
    result = await evaluatePingPongCompletion(baseDeps(state, reviewer));
    expect(result?.status).toBe('reviewer-unavailable');
    expect(state.pingPong?.roundCount).toBe(0);
  });

  it('a reliable round clears the unreliable counter so transient faults do not accumulate forever', async () => {
    const state = makeState(workspace);
    const flaky = vi.fn<PingPongReviewer>()
      // round 1+2: transient availability faults
      .mockResolvedValueOnce(reviewResult({ verdict: 'UNRELIABLE', reviewerProvider: 'codex', fault: 'rate_limited' }))
      .mockResolvedValueOnce(reviewResult({ verdict: 'UNRELIABLE', reviewerProvider: 'codex', fault: 'timeout' }))
      // round 3: the reviewer recovers and APPROVES
      .mockResolvedValue(reviewResult({ verdict: 'APPROVED' }));
    let result = await evaluatePingPongCompletion(baseDeps(state, flaky));
    expect(result).toBeNull();
    expect(state.pingPong?.consecutiveUnreliableRounds).toBe(1);
    result = await evaluatePingPongCompletion(baseDeps(state, flaky));
    expect(result).toBeNull();
    expect(state.pingPong?.consecutiveUnreliableRounds).toBe(2);
    result = await evaluatePingPongCompletion(baseDeps(state, flaky));
    expect(result?.status).toBe('completed');
    expect(state.pingPong?.consecutiveUnreliableRounds).toBe(0);
  });

  it('stops with cost-exceeded when the cost cap is already hit', async () => {
    const state = makeState(workspace);
    state.config.caps.maxCostCents = 100;
    state.totalCostCents = 100;
    const reviewer = vi.fn<PingPongReviewer>().mockResolvedValue(reviewResult({ verdict: 'APPROVED' }));
    const result = await evaluatePingPongCompletion(baseDeps(state, reviewer));
    expect(result?.status).toBe('cost-exceeded');
    expect(reviewer).not.toHaveBeenCalled();
  });

  it('does NOT converge when reviewer APPROVES but impl-mode verify fails', async () => {
    const state = makeState(workspace);
    const reviewer = vi.fn<PingPongReviewer>().mockResolvedValue(reviewResult({ verdict: 'APPROVED' }));
    const deps = {
      ...baseDeps(state, reviewer),
      runVerify: vi.fn().mockResolvedValue({ ok: false, output: 'tests failed' }),
    };
    const result = await evaluatePingPongCompletion(deps);
    expect(result).toBeNull();
    expect(state.pendingInterventions[0]?.message).toContain('verify command FAILED');
  });

  it('honours a skip-next-round operator control (no reviewer spawned, flag consumed)', async () => {
    const state = makeState(workspace);
    state.pingPong!.skipNextRound = true;
    const reviewer = vi.fn<PingPongReviewer>();
    const result = await evaluatePingPongCompletion(baseDeps(state, reviewer));
    expect(result).toBeNull();
    expect(reviewer).not.toHaveBeenCalled();
    expect(state.pingPong?.skipNextRound).toBe(false); // consumed
  });

  it('honours a force-arbitration operator control', async () => {
    const state = makeState(workspace);
    state.pingPong!.forceArbitration = true;
    const reviewer = vi.fn<PingPongReviewer>();
    const result = await evaluatePingPongCompletion(baseDeps(state, reviewer));
    expect(result?.status).toBe('needs-human-arbitration');
    expect(reviewer).not.toHaveBeenCalled();
  });

  it('terminates builder-unreliable: builder ignores persisted blocking findings (no edits) for 3 rounds', async () => {
    const state = makeState(workspace);
    const reviewer = vi.fn<PingPongReviewer>().mockResolvedValue(
      reviewResult({
        verdict: 'CHANGES_REQUESTED',
        findings: [
          { title: 'unfixed null deref', severity: 'high', evidence: 'x.ts:1', body: 'still broken', novelty: 'persisted' },
        ],
      }),
    );
    let result: Awaited<ReturnType<typeof evaluatePingPongCompletion>> = null;
    for (let i = 0; i < 3; i++) {
      // baseDeps() builds a fresh iteration with NO files changed each round.
      result = await evaluatePingPongCompletion(baseDeps(state, reviewer));
    }
    expect(result?.status).toBe('builder-unreliable');
    expect(state.pingPong?.builderUnaddressedRounds).toBe(3);
  });

  it('terminates needs-human-arbitration: same issue re-raised despite edits for 3 rounds', async () => {
    const state = makeState(workspace);
    const reviewer = vi.fn<PingPongReviewer>().mockResolvedValue(
      reviewResult({
        verdict: 'CHANGES_REQUESTED',
        findings: [
          { title: 'contested design', severity: 'high', evidence: 'y.ts:9', body: 'disputed', novelty: 'persisted' },
        ],
      }),
    );
    let result: Awaited<ReturnType<typeof evaluatePingPongCompletion>> = null;
    for (let i = 0; i < 3; i++) {
      // Builder DID edit (production change) but the same blocking issue persists → deadlock.
      result = await evaluatePingPongCompletion({
        ...baseDeps(state, reviewer),
        iteration: makeIteration([{ path: 'src/y.ts' }]),
      });
    }
    expect(result?.status).toBe('needs-human-arbitration');
  });

  it('converges-or-arbitrates (completed-needs-review) after 2 low-only-churn rounds', async () => {
    const state = makeState(workspace);
    const reviewer = vi.fn<PingPongReviewer>().mockResolvedValue(
      reviewResult({
        verdict: 'CHANGES_REQUESTED',
        findings: [
          { title: 'style nit', severity: 'low', evidence: 'z.ts:3', body: 'rename pls', novelty: 'new' },
        ],
      }),
    );
    let result: Awaited<ReturnType<typeof evaluatePingPongCompletion>> = null;
    for (let i = 0; i < 2; i++) {
      result = await evaluatePingPongCompletion(baseDeps(state, reviewer));
    }
    expect(result?.status).toBe('completed-needs-review');
    expect(state.pingPong?.lowOnlyChurnRounds).toBe(2);
  });
});
