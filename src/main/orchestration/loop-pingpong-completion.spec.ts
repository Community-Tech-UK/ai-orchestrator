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
import type { LocalFreshEyesAdvisoryResult } from './loop-fresh-eyes-reviewer';

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
    localAdvisoryReviewer: vi.fn().mockResolvedValue({
      status: 'skipped',
      findings: [],
      summary: 'No local reviewer selected.',
      reason: 'No local reviewer selected.',
    } satisfies LocalFreshEyesAdvisoryResult),
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

  it('WS3 e2e: a seeded secret in the worktree diff never reaches the reviewer input', async () => {
    // Real git repo with a committed file, then an unstaged secret-bearing edit.
    const { execFileSync } = await import('node:child_process');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
    git('init');
    git('config', 'user.email', 't@t.local');
    git('config', 'user.name', 't');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(workspace, '.env'), 'GITHUB_TOKEN=placeholder\n');
    git('add', '.env');
    git('commit', '-m', 'seed', '--no-gpg-sign');
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    writeFileSync(join(workspace, '.env'), `GITHUB_TOKEN=${token}\n`);

    const state = makeState(workspace);
    const reviewer = vi.fn<PingPongReviewer>().mockResolvedValue(reviewResult({ verdict: 'APPROVED' }));
    await evaluatePingPongCompletion(baseDeps(state, reviewer));

    expect(reviewer).toHaveBeenCalledOnce();
    const input = reviewer.mock.calls[0][0];
    expect(input.diff).toBeTruthy();
    expect(input.diff).not.toContain(token);
    expect(input.diff).toContain('[REDACTED — potential secret]');
  });

  it('starts the authoritative remote review and local advisory pass concurrently', async () => {
    const state = makeState(workspace);
    let resolveRemote!: (value: PingPongReviewResult) => void;
    let resolveLocal!: (value: LocalFreshEyesAdvisoryResult) => void;
    const remote = new Promise<PingPongReviewResult>((resolve) => { resolveRemote = resolve; });
    const local = new Promise<LocalFreshEyesAdvisoryResult>((resolve) => { resolveLocal = resolve; });
    const reviewer = vi.fn<PingPongReviewer>(() => remote);
    const localAdvisoryReviewer = vi.fn(() => local);

    const pending = evaluatePingPongCompletion({
      ...baseDeps(state, reviewer),
      localAdvisoryReviewer,
    });

    await vi.waitFor(() => {
      expect(reviewer).toHaveBeenCalledOnce();
      expect(localAdvisoryReviewer).toHaveBeenCalledOnce();
    });
    resolveLocal({ status: 'used', findings: [], summary: 'Local review clean.' });
    resolveRemote(reviewResult({ verdict: 'APPROVED' }));
    await expect(pending).resolves.toMatchObject({ status: 'completed' });
  });

  it('uses the isolated execution checkout for both remote and local review inputs', async () => {
    const executionCwd = mkdtempSync(join(tmpdir(), 'pingpong-isolated-'));
    const state = makeState(workspace);
    state.config.executionCwd = executionCwd;
    const reviewer = vi.fn<PingPongReviewer>().mockResolvedValue(reviewResult({ verdict: 'APPROVED' }));
    const localAdvisoryReviewer = vi.fn().mockResolvedValue({
      status: 'used', findings: [], summary: 'Local clean.',
    } satisfies LocalFreshEyesAdvisoryResult);

    try {
      await evaluatePingPongCompletion({
        ...baseDeps(state, reviewer),
        localAdvisoryReviewer,
      });
      expect(reviewer).toHaveBeenCalledWith(expect.objectContaining({ workspaceCwd: executionCwd }));
      expect(localAdvisoryReviewer).toHaveBeenCalledWith(expect.objectContaining({
        workspaceCwd: executionCwd,
      }));
    } finally {
      rmSync(executionCwd, { recursive: true, force: true });
    }
  });

  it('does not let a non-settling local reviewer delay remote cancellation or retain in-flight state', async () => {
    const state = makeState(workspace);
    const abort = new AbortController();
    let rejectLocal!: (reason?: unknown) => void;
    const localNeverSettles = new Promise<LocalFreshEyesAdvisoryResult>((_resolve, reject) => {
      rejectLocal = reject;
    });
    const reviewer = vi.fn<PingPongReviewer>(async (input) => {
      input.onSpawned?.('remote-reviewer');
      abort.abort();
      return reviewResult({ verdict: 'UNRELIABLE', spawnOutcome: 'cancelled' });
    });
    const localAdvisoryReviewer = vi.fn(() => localNeverSettles);

    const result = await Promise.race([
      evaluatePingPongCompletion({
        ...baseDeps(state, reviewer),
        signal: abort.signal,
        localAdvisoryReviewer,
      }),
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 250)),
    ]);

    expect(result).toBeNull();
    expect(state.pingPong?.inFlightReviewerInstanceId).toBeUndefined();
    expect(state.pingPong?.inFlightRound).toBeUndefined();
    expect(localAdvisoryReviewer).toHaveBeenCalledWith(expect.objectContaining({
      abortSignal: abort.signal,
    }));
    rejectLocal(new Error('late local failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('wakes a local wait when pause arrives after an APPROVED remote review settles', async () => {
    const state = makeState(workspace);
    const abort = new AbortController();
    const removeAbortListener = vi.spyOn(abort.signal, 'removeEventListener');
    let rejectLocal!: (reason?: unknown) => void;
    const localNeverSettles = new Promise<LocalFreshEyesAdvisoryResult>((_resolve, reject) => {
      rejectLocal = reject;
    });
    const reviewer = vi.fn<PingPongReviewer>(async (input) => {
      input.onSpawned?.('remote-reviewer');
      return reviewResult({ verdict: 'APPROVED' });
    });
    const localAdvisoryReviewer = vi.fn(() => localNeverSettles);
    let settled = false;
    const evaluation = evaluatePingPongCompletion({
      ...baseDeps(state, reviewer),
      signal: abort.signal,
      localAdvisoryReviewer,
    }).finally(() => { settled = true; });

    await vi.waitFor(() => {
      expect(reviewer).toHaveBeenCalledOnce();
      expect(localAdvisoryReviewer).toHaveBeenCalledOnce();
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    abort.abort();
    const result = await Promise.race([
      evaluation,
      new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), 250)),
    ]);

    expect(result).toBeNull();
    expect(state.pingPong?.inFlightReviewerInstanceId).toBeUndefined();
    expect(state.pingPong?.inFlightRound).toBeUndefined();
    expect(state.pingPong?.roundCount).toBe(0);
    expect(removeAbortListener).toHaveBeenCalledWith('abort', expect.any(Function));
    rejectLocal(new Error('late local failure'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('surfaces a clean local pass without changing remote APPROVED authority', async () => {
    const state = makeState(workspace);
    const reviewer = vi.fn<PingPongReviewer>().mockResolvedValue(reviewResult({ verdict: 'APPROVED' }));
    const deps = {
      ...baseDeps(state, reviewer),
      localAdvisoryReviewer: vi.fn().mockResolvedValue({
        status: 'used', findings: [], summary: 'Local review clean.',
      } satisfies LocalFreshEyesAdvisoryResult),
    };

    const result = await evaluatePingPongCompletion(deps);

    expect(result?.status).toBe('completed');
    expect(deps.emit).toHaveBeenCalledWith('loop:activity', expect.objectContaining({
      message: expect.stringContaining('Local advisory review completed cleanly'),
    }));
  });

  it('isolates a failed local pass from an authoritative remote APPROVED verdict', async () => {
    const state = makeState(workspace);
    const reviewer = vi.fn<PingPongReviewer>().mockResolvedValue(reviewResult({ verdict: 'APPROVED' }));
    const deps = {
      ...baseDeps(state, reviewer),
      localAdvisoryReviewer: vi.fn().mockRejectedValue(new Error('local timeout')),
    };

    const result = await evaluatePingPongCompletion(deps);

    expect(result?.status).toBe('completed');
    expect(deps.emit).toHaveBeenCalledWith('loop:activity', expect.objectContaining({
      message: expect.stringContaining('Local advisory review failed: local timeout'),
    }));
  });

  it('keeps a local-only high finding visible but outside the blocking ledger and counters', async () => {
    const state = makeState(workspace);
    const reviewer = vi.fn<PingPongReviewer>().mockResolvedValue(reviewResult({ verdict: 'APPROVED' }));
    const localFinding = {
      title: 'Possible auth bypass', body: 'Inspect the fallback path.', severity: 'high' as const,
      file: 'src/auth.ts', confidence: 0.9, advisory: true as const,
    };
    const deps = {
      ...baseDeps(state, reviewer),
      localAdvisoryReviewer: vi.fn().mockResolvedValue({
        status: 'used', findings: [localFinding], summary: 'One local concern.',
      } satisfies LocalFreshEyesAdvisoryResult),
    };

    const result = await evaluatePingPongCompletion(deps);

    expect(result?.status).toBe('completed');
    expect(state.pingPong?.ledger).toEqual([]);
    expect(state.pingPong?.builderUnaddressedRounds).toBe(0);
    expect(state.pingPong?.consecutiveContradictoryRounds).toBe(0);
    expect(deps.emit).toHaveBeenCalledWith('loop:fresh-eyes-review-passed', expect.objectContaining({
      advisoryFindings: [expect.objectContaining({ title: 'Possible auth bypass', advisory: true })],
    }));
  });

  it('keeps a matching remote blocking finding authoritative without promoting the local copy', async () => {
    const state = makeState(workspace);
    const reviewer = vi.fn<PingPongReviewer>().mockResolvedValue(reviewResult({
      verdict: 'CHANGES_REQUESTED',
      findings: [{
        title: 'Auth bypass in handler', severity: 'high', evidence: 'src/auth.ts:42',
        body: 'Remote reviewer reproduced the bypass.', novelty: 'new', file: 'src/auth.ts',
      }],
    }));
    const deps = {
      ...baseDeps(state, reviewer),
      localAdvisoryReviewer: vi.fn().mockResolvedValue({
        status: 'used',
        findings: [{
          title: 'Auth bypass in handler', body: 'Local suspicion.', severity: 'high',
          file: 'src/auth.ts', confidence: 0.8, advisory: true,
        }],
        summary: 'One local concern.',
      } satisfies LocalFreshEyesAdvisoryResult),
    };

    const result = await evaluatePingPongCompletion(deps);

    expect(result).toBeNull();
    expect(state.pingPong?.ledger).toHaveLength(1);
    expect(state.pingPong?.ledger[0]).toMatchObject({
      title: 'Auth bypass in handler', evidence: 'src/auth.ts:42', status: 'open',
    });
  });

  it.each([
    { name: 'clean', local: { status: 'used', findings: [], summary: 'Local clean.' } },
    { name: 'concern', local: {
      status: 'used',
      findings: [{
        title: 'Local concern', body: 'Advisory only.', severity: 'critical', confidence: 0.9, advisory: true,
      }],
      summary: 'Local concern.',
    } },
  ] satisfies { name: string; local: LocalFreshEyesAdvisoryResult }[])(
    'stays fail-closed when the remote review is unreliable and local is $name',
    async ({ local }) => {
      const state = makeState(workspace);
      const reviewer = vi.fn<PingPongReviewer>().mockResolvedValue(reviewResult({
        verdict: 'UNRELIABLE', fault: 'malformed_output', reason: 'remote output malformed',
      }));

      const result = await evaluatePingPongCompletion({
        ...baseDeps(state, reviewer),
        localAdvisoryReviewer: vi.fn().mockResolvedValue(local),
      });

      expect(result).toBeNull();
      expect(state.pingPong?.roundCount).toBe(0);
      expect(state.pingPong?.consecutiveUnreliableRounds).toBe(1);
      expect(state.pingPong?.ledger).toEqual([]);
    },
  );

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
      localAdvisoryReviewer: vi.fn().mockResolvedValue({
        status: 'used',
        findings: [{
          title: 'Local advisory', body: 'Inspect this separately.', severity: 'high',
          confidence: 0.8, advisory: true,
        }],
        summary: 'One local advisory.',
      } satisfies LocalFreshEyesAdvisoryResult),
      runVerify: vi.fn().mockResolvedValue({ ok: false, output: 'tests failed' }),
    };
    const result = await evaluatePingPongCompletion(deps);
    expect(result).toBeNull();
    expect(state.pendingInterventions[0]?.message).toContain('verify command FAILED');
    expect(state.pendingInterventions[0]?.message).toContain('Local advisory');
    expect(state.pendingInterventions[0]?.message).toContain('not blocking');
    expect(deps.emit).toHaveBeenCalledWith('loop:fresh-eyes-review-blocked', expect.objectContaining({
      advisoryFindings: [expect.objectContaining({ title: 'Local advisory', advisory: true })],
      localAdvisoryStatus: 'used',
    }));
  });

  it('does NOT converge when the impl-mode verify hook throws', async () => {
    const state = makeState(workspace);
    const reviewer = vi.fn<PingPongReviewer>().mockResolvedValue(reviewResult({ verdict: 'APPROVED' }));
    const deps = {
      ...baseDeps(state, reviewer),
      runVerify: vi.fn().mockRejectedValue(new Error('verify process crashed')),
    };

    const result = await evaluatePingPongCompletion(deps);

    expect(result).toBeNull();
    expect(state.pendingInterventions[0]?.message).toContain('verify command FAILED');
    expect(state.pendingInterventions[0]?.message).toContain('verify process crashed');
    expect(deps.emit).toHaveBeenCalledWith(
      'loop:fresh-eyes-review-blocked',
      expect.objectContaining({ summary: 'reviewer approved but verify failed' }),
    );
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
