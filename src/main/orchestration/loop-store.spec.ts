/**
 * Unit tests for the main-process `LoopStore` — focused on the
 * read-side parsing that surfaces `initialPrompt` / `iterationPrompt`
 * from the persisted `config_json` blob.
 *
 * Uses an in-memory better-sqlite3 database (`:memory:`) so the tests
 * are self-contained and don't touch the user's app data dir. Schema is
 * applied via `runLoopMigrations` exactly as in production.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../db/sqlite-driver';
import type {
  LoopConfig,
  LoopIteration,
  LoopState,
} from '../../shared/types/loop.types';
import { defaultLoopConfig } from '../../shared/types/loop.types';
import { runLoopMigrations } from './loop-schema';
import { LoopStore } from './loop-store';

let driver: SqliteDriver;
let store: LoopStore;

function makeState(overrides: Partial<LoopState> = {}): LoopState {
  const config: LoopConfig = {
    ...defaultLoopConfig('/tmp/project', 'goal-of-the-loop'),
    iterationPrompt: 'continue toward the goal',
  };
  return {
    id: 'loop-1',
    chatId: 'chat-1',
    config,
    status: 'completed',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_120_000,
    totalIterations: 4,
    totalTokens: 5_000,
    totalCostCents: 42,
    currentStage: 'IMPLEMENT',
    completedFileRenameObserved: false,
    highestTestPassCount: 0,
    endReason: 'all done',
    pendingInterventions: [],
    tokensSinceLastTestImprovement: 0,
    iterationsOnCurrentStage: 0,
    recentWarnIterationSeqs: [],
    ...overrides,
  };
}

function makeLoopIteration(overrides: Partial<LoopIteration> = {}): LoopIteration {
  return {
    id: `iter-${overrides.seq ?? 0}`,
    loopRunId: 'loop-1',
    seq: 0,
    stage: 'IMPLEMENT',
    startedAt: 1_700_000_000_000,
    endedAt: 1_700_000_001_000,
    childInstanceId: null,
    tokens: 10,
    costCents: 0,
    filesChanged: [],
    toolCalls: [],
    errors: [],
    testPassCount: null,
    testFailCount: null,
    workHash: 'hash',
    outputSimilarityToPrev: null,
    outputExcerpt: '',
    outputFull: '',
    progressVerdict: 'OK',
    progressSignals: [],
    completionSignalsFired: [],
    verifyStatus: 'not-run',
    verifyOutputExcerpt: '',
    ...overrides,
  };
}

beforeEach(() => {
  driver = new Database(':memory:') as unknown as SqliteDriver;
  runLoopMigrations(driver);
  store = new LoopStore(driver);
});

afterEach(() => {
  driver.close();
});

describe('LoopStore.getRunSummary', () => {
  it('parses initialPrompt + iterationPrompt out of config_json', () => {
    store.upsertRun(makeState());

    const summary = store.getRunSummary('loop-1');

    expect(summary).not.toBeNull();
    expect(summary?.initialPrompt).toBe('goal-of-the-loop');
    expect(summary?.iterationPrompt).toBe('continue toward the goal');
    expect(summary?.totalIterations).toBe(4);
    expect(summary?.endReason).toBe('all done');
  });

  it('returns iterationPrompt=null when the loop reused initialPrompt', () => {
    const state = makeState();
    state.config.iterationPrompt = undefined;
    store.upsertRun(state);

    const summary = store.getRunSummary('loop-1');

    expect(summary?.iterationPrompt).toBeNull();
  });

  it('returns iterationPrompt=null when the persisted value is empty', () => {
    const state = makeState();
    state.config.iterationPrompt = '';
    store.upsertRun(state);

    expect(store.getRunSummary('loop-1')?.iterationPrompt).toBeNull();
  });

  it('returns null when the run id is unknown', () => {
    expect(store.getRunSummary('nope')).toBeNull();
  });

  it('getRunConfig recovers the full config blob for reuse', () => {
    store.upsertRun(makeState());
    const config = store.getRunConfig('loop-1');
    expect(config).not.toBeNull();
    expect(config?.initialPrompt).toBe('goal-of-the-loop');
    expect(config?.workspaceCwd).toBe('/tmp/project');
    expect(config?.provider).toBe('claude');
  });

  it('getRunConfig returns null for an unknown run', () => {
    expect(store.getRunConfig('nope')).toBeNull();
  });

  it('falls back to empty prompts when config_json is corrupt rather than throwing', () => {
    // Insert a row with deliberately broken config_json so we can verify
    // the JSON.parse failure path. The schema's NOT NULL constraint
    // prevents writing null, so we use a non-JSON string.
    driver.prepare(`
      INSERT INTO loop_runs (
        id, chat_id, plan_file, config_json, status, started_at, ended_at,
        total_iterations, total_tokens, total_cost_cents, current_stage,
        completed_file_rename_observed, highest_test_pass_count, end_reason, end_evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'loop-broken',
      'chat-1',
      null,
      '{ this-is-not-valid-json',
      'error',
      1,
      2,
      0,
      0,
      0,
      'IMPLEMENT',
      0,
      0,
      null,
      null,
    );

    const summary = store.getRunSummary('loop-broken');

    expect(summary).not.toBeNull();
    expect(summary?.initialPrompt).toBe('');
    expect(summary?.iterationPrompt).toBeNull();
  });
});

describe('LoopStore.getIterations pagination', () => {
  it('caps getIterations by default and supports explicit pagination', () => {
    const state = makeState({ id: 'loop-paged' });
    store.upsertRun(state);
    for (let seq = 0; seq < 3; seq++) {
      store.insertIteration(makeLoopIteration({
        id: `loop-paged-${seq}`,
        loopRunId: 'loop-paged',
        seq,
      }));
    }

    expect(store.getIterations('loop-paged', undefined, undefined, { limit: 2 }).map((i) => i.seq)).toEqual([0, 1]);
    expect(store.getIterations('loop-paged', undefined, undefined, { limit: 2, offset: 1 }).map((i) => i.seq)).toEqual([1, 2]);
    expect(store.countIterations('loop-paged')).toBe(3);
  });

  it('round-trips outputFull through persistence (migration 010) distinctly from the excerpt', () => {
    const state = makeState({ id: 'loop-full' });
    store.upsertRun(state);
    store.insertIteration(makeLoopIteration({
      id: 'loop-full-0',
      loopRunId: 'loop-full',
      seq: 0,
      outputExcerpt: 'head…tail',
      outputFull: 'The complete final response, every word of it.',
    }));

    const [iter] = store.getIterations('loop-full');
    expect(iter.outputExcerpt).toBe('head…tail');
    expect(iter.outputFull).toBe('The complete final response, every word of it.');
  });

  it('round-trips finalAudit through iteration persistence', () => {
    const state = makeState({ id: 'loop-final-audit' });
    store.upsertRun(state);
    const finalAudit: NonNullable<LoopIteration['finalAudit']> = {
      status: 'failed',
      ranAt: 1_700_000_002_000,
      coverage: {
        criteriaTotal: 2,
        criteriaVerified: 1,
        criteriaUnverified: 1,
        verifyCommandRan: true,
        repoComparisonRan: true,
        cleanlinessScanRan: true,
      },
      findings: [{
        severity: 'blocking',
        code: 'plan-criteria-unproven',
        message: 'Acceptance criterion lacks evidence.',
        file: 'ROADMAP.md',
      }],
      changedFiles: ['src/main/orchestration/loop-store.ts'],
      reportPath: '/tmp/project/.aio-loop-state/loop-final-audit/AUDIT.md',
    };
    store.insertIteration(makeLoopIteration({
      id: 'loop-final-audit-0',
      loopRunId: 'loop-final-audit',
      seq: 0,
      finalAudit,
    }));

    const [iter] = store.getIterations('loop-final-audit');
    expect(iter.finalAudit).toEqual(finalAudit);
  });

  it('round-trips verifyFailureKind through iteration persistence', () => {
    const state = makeState({ id: 'loop-verify-kind' });
    store.upsertRun(state);
    store.insertIteration(makeLoopIteration({
      id: 'loop-verify-kind-0',
      loopRunId: 'loop-verify-kind',
      seq: 0,
      verifyStatus: 'failed',
      verifyOutputExcerpt: 'verify timed out',
      verifyFailureKind: 'timeout',
    }));

    const [iter] = store.getIterations('loop-verify-kind');
    expect(iter.verifyStatus).toBe('failed');
    expect(iter.verifyFailureKind).toBe('timeout');
  });
});

describe('LoopStore checkpoints', () => {
  it('persists run, iteration, checkpoint, and restart counter in one iteration snapshot', () => {
    const state = makeState({ id: 'loop-atomic', status: 'running', endedAt: null });
    store.upsertRun(state);
    driver.prepare('UPDATE loop_runs SET restart_failure_count = 2 WHERE id = ?').run(state.id);
    const iteration = makeLoopIteration({
      id: 'loop-atomic-0',
      loopRunId: state.id,
      seq: 0,
      outputFull: 'sealed output',
    });

    store.persistIterationSnapshot({
      state,
      iteration,
      checkpoint: {
        version: 1,
        loopRunId: state.id,
        chatId: state.chatId,
        status: 'running',
        state,
        historyTail: [iteration],
        convergenceNote: 'keep going',
        planRegenerationCount: 0,
        pendingContextReset: false,
        updatedAt: 4321,
      },
    });

    expect(store.getRunSummary(state.id)?.status).toBe('running');
    expect(store.getIterations(state.id).map((i) => i.id)).toEqual([iteration.id]);
    expect(store.getCheckpoint(state.id)).toEqual(expect.objectContaining({
      loopRunId: state.id,
      convergenceNote: 'keep going',
      updatedAt: 4321,
    }));
    expect(store.getRestartFailureCount(state.id)).toBe(0);
  });

  it('rolls back the whole iteration snapshot when checkpoint serialization fails', () => {
    const state = makeState({ id: 'loop-atomic-fail', status: 'running', endedAt: null });
    const iteration = makeLoopIteration({
      id: 'loop-atomic-fail-0',
      loopRunId: state.id,
      seq: 0,
    });
    const checkpoint = {
      version: 1,
      loopRunId: state.id,
      chatId: state.chatId,
      status: 'running',
      state: { ...state },
      historyTail: [iteration],
      convergenceNote: null,
      planRegenerationCount: 0,
      pendingContextReset: false,
      updatedAt: 1234,
    };
    (checkpoint.state as LoopState & { self?: unknown }).self = checkpoint;

    expect(() => store.persistIterationSnapshot({
      state,
      iteration,
      checkpoint,
    })).toThrow(/circular structure/i);

    expect(store.getRunSummary(state.id)).toBeNull();
    expect(store.getIterations(state.id)).toEqual([]);
    expect(store.getCheckpoint(state.id)).toBeNull();
  });

  it('persists run and checkpoint atomically for state-only snapshots', () => {
    const state = makeState({ id: 'loop-state-checkpoint', status: 'paused', endedAt: null });

    store.persistStateCheckpoint({
      state,
      checkpoint: {
        version: 1,
        loopRunId: state.id,
        chatId: state.chatId,
        status: 'paused',
        state,
        historyTail: [],
        convergenceNote: 'paused by operator',
        planRegenerationCount: 0,
        pendingContextReset: false,
        updatedAt: 2222,
      },
    });

    expect(store.getRunSummary(state.id)?.status).toBe('paused');
    expect(store.getCheckpoint(state.id)).toEqual(expect.objectContaining({
      loopRunId: state.id,
      convergenceNote: 'paused by operator',
    }));
  });

  it('rolls back state-only snapshots when checkpoint serialization fails', () => {
    const state = makeState({ id: 'loop-state-checkpoint-fail', status: 'paused', endedAt: null });
    const checkpoint = {
      version: 1,
      loopRunId: state.id,
      chatId: state.chatId,
      status: 'paused',
      state: { ...state },
      historyTail: [],
      convergenceNote: 'paused by operator',
      planRegenerationCount: 0,
      pendingContextReset: false,
      updatedAt: 2222,
    };
    (checkpoint.state as LoopState & { self?: unknown }).self = checkpoint;

    expect(() => store.persistStateCheckpoint({
      state,
      checkpoint,
    })).toThrow(/circular structure/i);

    expect(store.getRunSummary(state.id)).toBeNull();
    expect(store.getCheckpoint(state.id)).toBeNull();
  });

  it('round-trips the latest loop checkpoint', () => {
    const state = makeState({ id: 'loop-checkpoint', status: 'running', endedAt: null });
    store.upsertRun(state);
    store.upsertCheckpoint({
      version: 1,
      loopRunId: state.id,
      chatId: state.chatId,
      status: 'running',
      state,
      historyTail: [],
      convergenceNote: 'verify failed',
      planRegenerationCount: 2,
      pendingContextReset: true,
      updatedAt: 1234,
    });

    expect(store.getCheckpoint(state.id)).toEqual(expect.objectContaining({
      loopRunId: state.id,
      convergenceNote: 'verify failed',
      planRegenerationCount: 2,
      pendingContextReset: true,
    }));
  });

  it('lists resumable checkpoints for paused and provider-limit loops', () => {
    const state = makeState({ id: 'loop-resumable', status: 'paused', endedAt: null });
    store.upsertRun(state);
    store.upsertCheckpoint({
      version: 1,
      loopRunId: state.id,
      chatId: state.chatId,
      status: 'paused',
      state,
      historyTail: [],
      convergenceNote: null,
      planRegenerationCount: 0,
      pendingContextReset: false,
      updatedAt: 1234,
    });

    expect(store.listResumableCheckpoints().map((checkpoint) => checkpoint.loopRunId)).toContain(state.id);
  });

  it('lists resumable run rows for paused and live provider-limit loops', () => {
    const paused = makeState({ id: 'loop-paused', status: 'paused', endedAt: null });
    const providerLimit = makeState({ id: 'loop-provider-limit-live', status: 'provider-limit', endedAt: null });
    const endedProviderLimit = makeState({
      id: 'loop-provider-limit-ended',
      status: 'provider-limit',
      endedAt: 1_700_000_120_000,
    });
    for (const state of [paused, providerLimit, endedProviderLimit]) {
      store.upsertRun(state);
    }

    const ids = store.listResumableRuns().map(({ runRow }) => runRow.id);
    expect(ids).toContain(paused.id);
    expect(ids).toContain(providerLimit.id);
    expect(ids).not.toContain(endedProviderLimit.id);
  });

  it('does not list ended provider-limit checkpoints as resumable', () => {
    const resumable = makeState({ id: 'loop-provider-limit-live', status: 'provider-limit', endedAt: null });
    const ended = makeState({
      id: 'loop-provider-limit-terminal',
      status: 'provider-limit',
      endedAt: 1_700_000_120_000,
    });
    for (const state of [resumable, ended]) {
      store.persistStateCheckpoint({
        state,
        checkpoint: {
          version: 1,
          loopRunId: state.id,
          chatId: state.chatId,
          status: 'provider-limit',
          state,
          historyTail: [],
          convergenceNote: null,
          planRegenerationCount: 0,
          pendingContextReset: false,
          updatedAt: 1234,
        },
      });
    }

    const ids = store.listResumableCheckpoints().map((checkpoint) => checkpoint.loopRunId);
    expect(ids).toContain(resumable.id);
    expect(ids).not.toContain(ended.id);
  });
});

describe('LoopStore.listRunsForChat', () => {
  it('returns runs newest-first with prompts populated', () => {
    store.upsertRun(makeState({ id: 'loop-1', startedAt: 1, totalIterations: 1 }));
    store.upsertRun(makeState({ id: 'loop-2', startedAt: 2, totalIterations: 2 }));
    store.upsertRun(makeState({ id: 'loop-3', startedAt: 3, totalIterations: 3 }));

    const runs = store.listRunsForChat('chat-1');

    expect(runs.map((r) => r.id)).toEqual(['loop-3', 'loop-2', 'loop-1']);
    for (const run of runs) {
      expect(run.initialPrompt).toBe('goal-of-the-loop');
      expect(run.iterationPrompt).toBe('continue toward the goal');
    }
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      store.upsertRun(makeState({ id: `loop-${i}`, startedAt: i }));
    }
    expect(store.listRunsForChat('chat-1', 2)).toHaveLength(2);
  });

  it('returns an empty array when no runs exist for the chat', () => {
    store.upsertRun(makeState({ id: 'loop-x', chatId: 'chat-other' }));
    expect(store.listRunsForChat('chat-1')).toEqual([]);
  });
});

describe('FU-3: LoopStore restart-failure counter', () => {
  function insertRunningRun(id: string, restartFailureCount = 0): void {
    driver.prepare(`
      INSERT INTO loop_runs (
        id, chat_id, plan_file, config_json, status, started_at, ended_at,
        total_iterations, total_tokens, total_cost_cents, current_stage,
        completed_file_rename_observed, highest_test_pass_count, end_reason,
        end_evidence_json, restart_failure_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      'chat-1',
      null,
      JSON.stringify(defaultLoopConfig('/tmp/project', 'goal')),
      'running',
      1,
      null,
      0,
      0,
      0,
      'IMPLEMENT',
      0,
      0,
      null,
      null,
      restartFailureCount,
    );
  }

  it('increments restart_failure_count and pauses the loop on a single interruption', () => {
    insertRunningRun('loop-a', 0);
    expect(store.markRunningAsInterruptedOnBoot()).toBe(1);
    expect(store.getRestartFailureCount('loop-a')).toBe(1);

    const row = driver.prepare('SELECT status, end_reason FROM loop_runs WHERE id = ?')
      .get<{ status: string; end_reason: string }>('loop-a');
    expect(row?.status).toBe('paused');
    expect(row?.end_reason).toBe('app-restart');
  });

  it('marks the loop failed (crash-loop) once the counter crosses the threshold', () => {
    insertRunningRun('loop-crash', 2);
    expect(store.markRunningAsInterruptedOnBoot()).toBe(1);
    expect(store.getRestartFailureCount('loop-crash')).toBe(3);

    const row = driver.prepare('SELECT status, end_reason, ended_at FROM loop_runs WHERE id = ?')
      .get<{ status: string; end_reason: string; ended_at: number | null }>('loop-crash');
    expect(row?.status).toBe('failed');
    expect(row?.end_reason).toBe('crash-loop');
    expect(row?.ended_at).not.toBeNull();
  });

  it('resetRestartFailureCount zeroes the counter so an interruption after progress only counts once again', () => {
    insertRunningRun('loop-recovered', 2);
    store.resetRestartFailureCount('loop-recovered');
    expect(store.getRestartFailureCount('loop-recovered')).toBe(0);
    store.markRunningAsInterruptedOnBoot();
    expect(store.getRestartFailureCount('loop-recovered')).toBe(1);
  });

  it('getRestartFailureCount returns 0 for an unknown loop', () => {
    expect(store.getRestartFailureCount('does-not-exist')).toBe(0);
  });

  it('FU-2 persistence: round-trips manualReviewOnly through upsertRun (migration 004)', () => {
    const state = makeState({ id: 'loop-mro', manualReviewOnly: true });
    store.upsertRun(state);
    const row = driver
      .prepare('SELECT manual_review_only FROM loop_runs WHERE id = ?')
      .get<{ manual_review_only: number }>('loop-mro');
    expect(row?.manual_review_only).toBe(1);

    // Update path: flipping the in-memory value must update the column.
    store.upsertRun({ ...state, manualReviewOnly: false });
    const after = driver
      .prepare('SELECT manual_review_only FROM loop_runs WHERE id = ?')
      .get<{ manual_review_only: number }>('loop-mro');
    expect(after?.manual_review_only).toBe(0);
  });

  it('preserves restart_failure_count across routine upsertRun calls (counter not in UPDATE clause)', () => {
    // Simulate: app boots, increments counter to 1, then the user resumes
    // the loop and the coordinator upserts state on every state-change.
    // Each upsert must NOT clobber the counter — only the dedicated
    // markRunningAsInterruptedOnBoot / resetRestartFailureCount paths
    // are allowed to write the column.
    insertRunningRun('loop-preserve', 2);
    store.markRunningAsInterruptedOnBoot();
    expect(store.getRestartFailureCount('loop-preserve')).toBe(3);

    // Simulate the loop being "started" / state-changed repeatedly.
    const state = makeState({ id: 'loop-preserve', status: 'running' });
    store.upsertRun(state);
    store.upsertRun({ ...state, totalIterations: 1 });
    store.upsertRun({ ...state, totalIterations: 2 });

    // Counter must still be 3 — upsertRun is allowed to change status and
    // counters but must leave restart_failure_count alone.
    expect(store.getRestartFailureCount('loop-preserve')).toBe(3);
  });
});

describe('P3: LoopStore worktree column persistence', () => {
  it('upsertRun persists worktree_path and branch_name from config on INSERT', () => {
    const state = makeState({
      id: 'loop-wt-1',
      config: {
        ...defaultLoopConfig('/tmp/project', 'goal'),
        executionCwd: '/tmp/project/.worktrees/task-abc',
        worktreeBranch: 'task-abc-1a2b3c',
      },
    });
    store.upsertRun(state);

    const row = (driver.prepare(
      `SELECT worktree_path, branch_name FROM loop_runs WHERE id = 'loop-wt-1'`,
    ).get() as { worktree_path: string | null; branch_name: string | null } | undefined);
    expect(row?.worktree_path).toBe('/tmp/project/.worktrees/task-abc');
    expect(row?.branch_name).toBe('task-abc-1a2b3c');
  });

  it('subsequent upsertRun calls do NOT overwrite worktree columns (INSERT-only pattern)', () => {
    // First upsert writes the worktree columns.
    const state = makeState({
      id: 'loop-wt-2',
      config: {
        ...defaultLoopConfig('/tmp/project', 'goal'),
        executionCwd: '/tmp/project/.worktrees/task-def',
        worktreeBranch: 'task-def-4d5e6f',
      },
    });
    store.upsertRun(state);

    // Subsequent upserts (state changes) must NOT clobber the columns —
    // only clearWorktreeInfo is allowed to NULL them.
    store.upsertRun({ ...state, totalIterations: 1, status: 'running' });
    store.upsertRun({ ...state, totalIterations: 2, status: 'running' });

    const row = (driver.prepare(
      `SELECT worktree_path, branch_name FROM loop_runs WHERE id = 'loop-wt-2'`,
    ).get() as { worktree_path: string | null; branch_name: string | null } | undefined);
    expect(row?.worktree_path).toBe('/tmp/project/.worktrees/task-def');
    expect(row?.branch_name).toBe('task-def-4d5e6f');
  });

  it('clearWorktreeInfo nulls both columns; further upsertRun does not re-populate', () => {
    const state = makeState({
      id: 'loop-wt-3',
      config: {
        ...defaultLoopConfig('/tmp/project', 'goal'),
        executionCwd: '/tmp/project/.worktrees/task-ghi',
        worktreeBranch: 'task-ghi-7g8h9i',
      },
    });
    store.upsertRun(state);
    store.clearWorktreeInfo('loop-wt-3');

    // Columns must be NULL after clear.
    let row = (driver.prepare(
      `SELECT worktree_path, branch_name FROM loop_runs WHERE id = 'loop-wt-3'`,
    ).get() as { worktree_path: string | null; branch_name: string | null } | undefined);
    expect(row?.worktree_path).toBeNull();
    expect(row?.branch_name).toBeNull();

    // A subsequent upsertRun (e.g. a late state-change event) must NOT re-populate
    // the columns — the worktree is gone and re-writing its path would cause the
    // boot reconcile to try to reap an already-removed worktree.
    store.upsertRun({ ...state, totalIterations: 3, status: 'completed' });
    row = (driver.prepare(
      `SELECT worktree_path, branch_name FROM loop_runs WHERE id = 'loop-wt-3'`,
    ).get() as { worktree_path: string | null; branch_name: string | null } | undefined);
    expect(row?.worktree_path).toBeNull();
    expect(row?.branch_name).toBeNull();
  });

  it('non-isolated loops leave worktree columns NULL', () => {
    const state = makeState({ id: 'loop-no-wt' }); // no executionCwd / worktreeBranch
    store.upsertRun(state);

    const row = (driver.prepare(
      `SELECT worktree_path, branch_name FROM loop_runs WHERE id = 'loop-no-wt'`,
    ).get() as { worktree_path: string | null; branch_name: string | null } | undefined);
    expect(row?.worktree_path).toBeNull();
    expect(row?.branch_name).toBeNull();
  });

  it('lists ended provider-limit worktrees for cleanup but leaves resumable provider-limit checkpoints alone', () => {
    const ended = makeState({
      id: 'loop-provider-limit-ended',
      status: 'provider-limit',
      endedAt: 1_700_000_120_000,
      config: {
        ...defaultLoopConfig('/tmp/project', 'goal'),
        executionCwd: '/tmp/project/.worktrees/provider-limit-ended',
        worktreeBranch: 'provider-limit-ended-123',
      },
    });
    const resumable = makeState({
      id: 'loop-provider-limit-resumable',
      status: 'provider-limit',
      endedAt: null,
      config: {
        ...defaultLoopConfig('/tmp/project', 'goal'),
        executionCwd: '/tmp/project/.worktrees/provider-limit-resumable',
        worktreeBranch: 'provider-limit-resumable-123',
      },
    });
    store.upsertRun(ended);
    store.upsertRun(resumable);

    expect(store.getTerminalRunsWithWorktreePaths()).toEqual([
      expect.objectContaining({
        id: 'loop-provider-limit-ended',
        status: 'provider-limit',
        worktreePath: '/tmp/project/.worktrees/provider-limit-ended',
      }),
    ]);
  });
});

describe('LoopStore terminal intents', () => {
  it('persists terminal intent history when a run is upserted', () => {
    store.upsertRun(makeState({
      terminalIntentHistory: [
        {
          id: 'intent-1',
          loopRunId: 'loop-1',
          iterationSeq: 2,
          kind: 'complete',
          summary: 'done',
          evidence: [{ kind: 'test', label: 'npm test', value: 'passed' }],
          source: 'loop-control-cli',
          createdAt: 10,
          receivedAt: 20,
          status: 'accepted',
          statusReason: 'verified',
        },
      ],
    }));

    expect(store.listTerminalIntents('loop-1')).toEqual([
      {
        id: 'intent-1',
        loopRunId: 'loop-1',
        iterationSeq: 2,
        kind: 'complete',
        summary: 'done',
        evidence: [{ kind: 'test', label: 'npm test', value: 'passed' }],
        source: 'loop-control-cli',
        createdAt: 10,
        receivedAt: 20,
        status: 'accepted',
        statusReason: 'verified',
        filePath: undefined,
      },
    ]);
  });

  it('persists wakeup intent resume timestamps', () => {
    store.upsertRun(makeState({
      terminalIntentHistory: [
        {
          id: 'intent-wakeup',
          loopRunId: 'loop-1',
          iterationSeq: 4,
          kind: 'wakeup',
          summary: 'wait for CI',
          evidence: [],
          source: 'loop-control-cli',
          createdAt: 10,
          receivedAt: 20,
          status: 'accepted',
          statusReason: 'scheduled wakeup',
          resumeAt: 1_700_000_060_000,
        },
      ],
    }));

    expect(store.listTerminalIntents('loop-1')).toEqual([
      expect.objectContaining({
        id: 'intent-wakeup',
        kind: 'wakeup',
        resumeAt: 1_700_000_060_000,
      }),
    ]);
  });
});

describe('LoopStore outstanding items', () => {
  function seedRunWithOutstanding(overrides: Partial<LoopState> = {}) {
    const state = makeState({
      status: 'completed-needs-review',
      outstanding: {
        needsHuman: [
          { text: 'Deploy to device and confirm camera works', recommendation: 'Test on a Pixel 8 in the office' },
          { text: 'Run on a GPU box', recommendation: null },
        ],
        openQuestions: [{ text: 'Should we cache the model?', recommendation: 'Yes — cache between runs' }],
        raw: '## Needs human\n- ...',
        capturedAt: 1_700_000_200_000,
      },
      ...overrides,
    });
    store.upsertRun(state); // satisfy FK before inserting items
    store.saveOutstandingItems(state);
    return state;
  }

  it('persists needs-human + open-question rows from the state snapshot', () => {
    seedRunWithOutstanding();
    const items = store.listOutstandingItems({ workspaceCwd: '/tmp/project' });
    expect(items).toHaveLength(3);
    expect(items.filter((i) => i.kind === 'needs-human')).toHaveLength(2);
    expect(items.filter((i) => i.kind === 'open-question')).toHaveLength(1);
    expect(items.every((i) => i.status === 'open')).toBe(true);
    expect(items.every((i) => i.loopStatus === 'completed-needs-review')).toBe(true);
    // The agent's recommendation round-trips; items without one stay null.
    const camera = items.find((i) => i.text === 'Deploy to device and confirm camera works');
    const gpu = items.find((i) => i.text === 'Run on a GPU box');
    expect(camera?.recommendedAnswer).toBe('Test on a Pixel 8 in the office');
    expect(gpu?.recommendedAnswer).toBeNull();
  });

  it('is a no-op when the state carries no outstanding snapshot', () => {
    const state = makeState();
    store.upsertRun(state);
    store.saveOutstandingItems(state);
    expect(store.listOutstandingItems({})).toHaveLength(0);
  });

  it('re-capture is idempotent and preserves a user-set status', () => {
    const state = seedRunWithOutstanding();
    const target = store.listOutstandingItems({ workspaceCwd: '/tmp/project' })[0];
    expect(store.setOutstandingItemStatus(target.id, 'resolved')).toBe(true);

    // Re-capture the same run (e.g. a second terminal state-change).
    store.saveOutstandingItems(state);

    const after = store.listOutstandingItems({ workspaceCwd: '/tmp/project', status: 'all' });
    expect(after).toHaveLength(3); // no duplicates
    expect(after.find((i) => i.id === target.id)?.status).toBe('resolved');
  });

  it('filters by status and counts only open items', () => {
    seedRunWithOutstanding();
    const open = store.listOutstandingItems({ workspaceCwd: '/tmp/project', status: 'open' });
    store.setOutstandingItemStatus(open[0].id, 'dismissed');

    expect(store.countOpenOutstanding({ workspaceCwd: '/tmp/project' })).toBe(2);
    expect(store.listOutstandingItems({ workspaceCwd: '/tmp/project', status: 'open' })).toHaveLength(2);
    expect(store.listOutstandingItems({ workspaceCwd: '/tmp/project', status: 'dismissed' })).toHaveLength(1);
    expect(store.listOutstandingItems({ workspaceCwd: '/tmp/project', status: 'all' })).toHaveLength(3);
  });

  it('scopes listing + counting to a workspace', () => {
    seedRunWithOutstanding();
    seedRunWithOutstanding({
      id: 'loop-2',
      config: { ...defaultLoopConfig('/tmp/other', 'goal'), iterationPrompt: 'x' },
    });
    expect(store.countOpenOutstanding({ workspaceCwd: '/tmp/project' })).toBe(3);
    expect(store.countOpenOutstanding({ workspaceCwd: '/tmp/other' })).toBe(3);
    expect(store.countOpenOutstanding({})).toBe(6);
  });

  it('scopes listing + counting to one chat session within a workspace', () => {
    seedRunWithOutstanding();
    seedRunWithOutstanding({
      id: 'loop-2',
      chatId: 'chat-2',
    });

    const chatScope = {
      workspaceCwd: '/tmp/project',
      chatId: 'chat-1',
    };
    const countScope = {
      workspaceCwd: '/tmp/project',
      chatId: 'chat-1',
    };

    expect(store.listOutstandingItems(chatScope)).toHaveLength(3);
    expect(store.countOpenOutstanding(countScope)).toBe(3);
  });

  it('setOutstandingItemStatus returns false for an unknown id', () => {
    expect(store.setOutstandingItemStatus('does-not-exist', 'resolved')).toBe(false);
  });

  it('persists a human answer and defaults userResponse to null', () => {
    seedRunWithOutstanding();
    const target = store.listOutstandingItems({ workspaceCwd: '/tmp/project' })[0];
    expect(target.userResponse).toBeNull();

    expect(store.setOutstandingItemStatus(target.id, 'open', 'Adopt control_request')).toBe(true);
    const saved = store
      .listOutstandingItems({ workspaceCwd: '/tmp/project' })
      .find((i) => i.id === target.id);
    expect(saved?.userResponse).toBe('Adopt control_request');
    expect(saved?.status).toBe('open'); // saving an answer keeps it open
  });

  it('preserves a saved answer across a later status change with no response arg', () => {
    seedRunWithOutstanding();
    const target = store.listOutstandingItems({ workspaceCwd: '/tmp/project' })[0];
    store.setOutstandingItemStatus(target.id, 'open', 'My decision');

    // Resolve later without passing a response — the answer must survive.
    store.setOutstandingItemStatus(target.id, 'resolved');
    const after = store
      .listOutstandingItems({ workspaceCwd: '/tmp/project', status: 'all' })
      .find((i) => i.id === target.id);
    expect(after?.status).toBe('resolved');
    expect(after?.userResponse).toBe('My decision');
  });

  it('re-capture preserves a saved answer (idempotent upsert)', () => {
    const state = seedRunWithOutstanding();
    const target = store.listOutstandingItems({ workspaceCwd: '/tmp/project' })[0];
    store.setOutstandingItemStatus(target.id, 'open', 'Keep me');

    store.saveOutstandingItems(state); // second terminal capture of the same run

    const after = store
      .listOutstandingItems({ workspaceCwd: '/tmp/project' })
      .find((i) => i.id === target.id);
    expect(after?.userResponse).toBe('Keep me');
  });
});
