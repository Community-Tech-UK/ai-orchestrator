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
    expect(state.pendingInterventions[0]).toContain('null deref');
    expect(state.pingPong?.ledger.length).toBe(1);
    expect(state.pingPong?.roundCount).toBe(1);
  });

  it('is fail-closed: repeated UNRELIABLE rounds terminate as reviewer-unreliable, never a pass', async () => {
    const state = makeState(workspace);
    const reviewer = vi.fn<PingPongReviewer>().mockResolvedValue(
      reviewResult({ verdict: 'UNRELIABLE', reviewerProvider: 'codex', reason: 'timeout' }),
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
    expect(state.pendingInterventions[0]).toContain('verify command FAILED');
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
});
