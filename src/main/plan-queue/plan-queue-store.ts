/**
 * Plan Queue persistence (DAO).
 *
 * Tables come from migrations 017_plan_queue and 018 in loop-schema.ts and live in the
 * same SQLite DB as loop_runs and campaigns.
 *
 * Unlike CampaignStore, writes here THROW on failure. The queue's no-lost-work
 * invariant is "the row that owns a worktree is written before the worktree
 * exists"; a swallowed write error would let an unowned worktree be created.
 */

import type { SqliteDriver } from '../db/sqlite-driver';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type {
  PlanQueueItemState,
  PlanQueueKind,
  PlanQueueParkReason,
  PlanQueueQuestion,
  PlanQueueRunConfig,
  PlanQueueRunStatus,
  PlanQueueVerdict,
} from '@contracts/schemas/plan-queue';
import type { PlanQueueItem, PlanQueueRelaxationSnapshot, PlanQueueRun } from './plan-queue.types';

interface RunRow {
  tokens: number; cost_usd: number; exact_cost_usd: number;
  id: string;
  parent_instance_id: string;
  parent_history_thread_id: string | null;
  kind: string;
  workspace_cwd: string;
  status: string;
  config_json: string;
  relaxation_json: string | null;
  worker_provider: string | null;
  worker_model: string | null;
  started_at: number;
  ended_at: number | null;
}

interface ItemRow {
  held_at: number | null;
  pending_instruction: string | null;
  tokens: number; cost_usd: number; exact_cost_usd: number;
  id: string;
  run_id: string;
  document_path: string;
  state: string;
  round: number;
  errored_rounds: number;
  landing_refusals: number;
  branch_name: string | null;
  worktree_path: string | null;
  base_commit: string | null;
  checkpoint_commit: string | null;
  verified_main_commit: string | null;
  landed_commit: string | null;
  worker_instance_id: string | null;
  verifier_instance_id: string | null;
  question_json: string | null;
  answer: string | null;
  park_reason: string | null;
  detail: string | null;
  verdict_json: string | null;
  created_at: number;
  updated_at: number;
}

const ACTIVE_RUN_STATUSES = "('running', 'paused')";

export class PlanQueueStore {
  constructor(
    private readonly db: SqliteDriver,
    private readonly now: () => number = Date.now,
  ) {}

  addSpend(target: { itemId: string; runId?: string } | { runId: string }, delta: { tokens: number; costUsd: number; exactUsd: number }): void {
    const clean = (value: number) => Number.isFinite(value) && value >= 0 ? value : 0;
    const item = 'itemId' in target;
    const table = item ? 'plan_queue_items' : 'plan_queue_runs';
    const fence = item && target.runId ? ' AND run_id = ?' : '';
    const args: unknown[] = [Math.floor(clean(delta.tokens)), clean(delta.costUsd), Math.min(clean(delta.exactUsd), clean(delta.costUsd)), item ? target.itemId : target.runId];
    if (item && target.runId) args.push(target.runId);
    this.db.prepare(`UPDATE ${table} SET tokens = tokens + ?, cost_usd = cost_usd + ?, exact_cost_usd = exact_cost_usd + ? WHERE id = ?${fence}`).run(...args);
  }

  upsertRun(run: PlanQueueRun): void {
    this.db.prepare(`
      INSERT INTO plan_queue_runs (
        id, parent_instance_id, parent_history_thread_id, kind, workspace_cwd, status, config_json, relaxation_json,
        worker_provider, worker_model, started_at, ended_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status          = excluded.status,
        config_json     = excluded.config_json,
        relaxation_json = excluded.relaxation_json,
        worker_provider = excluded.worker_provider,
        worker_model    = excluded.worker_model,
        ended_at        = excluded.ended_at,
        updated_at      = excluded.updated_at
    `).run(
      run.id,
      run.parentInstanceId,
      run.parentHistoryThreadId ?? null,
      run.kind,
      run.workspaceCwd,
      run.status,
      JSON.stringify(run.config),
      run.relaxation ? JSON.stringify(run.relaxation) : null,
      run.workerProvider,
      run.workerModel,
      run.startedAt,
      run.endedAt,
      this.now(),
    );
  }

  /**
   * Repoint a run at its restored parent session and record that session's
   * thread (kept when null). The only writer of the parent columns after
   * insert: upsertRun leaves them alone, so a caller re-saving an older
   * snapshot of the run cannot put the old parent back.
   */
  setRunParent(runId: string, parentInstanceId: string, parentHistoryThreadId: string | null): void {
    this.db.prepare(`
      UPDATE plan_queue_runs
      SET parent_instance_id = ?, parent_history_thread_id = COALESCE(?, parent_history_thread_id), updated_at = ?
      WHERE id = ?
    `).run(parentInstanceId, parentHistoryThreadId, this.now(), runId);
  }

  getRun(runId: string): PlanQueueRun | null {
    const row = this.db.prepare('SELECT * FROM plan_queue_runs WHERE id = ?').get<RunRow>(runId);
    return row ? rowToRun(row) : null;
  }

  listActiveRuns(): PlanQueueRun[] {
    return this.db
      .prepare(`SELECT * FROM plan_queue_runs WHERE status IN ${ACTIVE_RUN_STATUSES} ORDER BY started_at`)
      .all<RunRow>()
      .map(rowToRun);
  }

  /** Verification and landing remain work even when no session is replying. */
  hasActiveWork(): boolean {
    return this.db.prepare(`
      SELECT 1 FROM plan_queue_runs r JOIN plan_queue_items i ON i.run_id = r.id
      WHERE r.status = 'running'
        AND i.state IN ('preparing', 'working', 'fixing', 'verifying', 'landing')
      LIMIT 1
    `).get() !== undefined;
  }

  listRuns(limit = 50): PlanQueueRun[] {
    return this.db
      .prepare('SELECT * FROM plan_queue_runs ORDER BY started_at DESC LIMIT ?')
      .all<RunRow>(limit)
      .map(rowToRun);
  }

  /**
   * Panel/status snapshot: all active runs and runs with parked work, plus the
   * latest `limit` runs. Only inert terminal history is bounded.
   * Both bulk reads share a SQLite snapshot, with no per-run item queries or
   * per-active-run bound parameters. The ordinary listRuns limit is unchanged.
   */
  listRunSnapshots(limit = 50): { run: PlanQueueRun; items: PlanQueueItem[] }[] {
    const selectedIds = `SELECT id FROM plan_queue_runs
      WHERE status IN ${ACTIVE_RUN_STATUSES}
        OR id IN (SELECT run_id FROM plan_queue_items WHERE state = 'parked')
        OR id IN (SELECT id FROM plan_queue_runs ORDER BY started_at DESC, id DESC LIMIT ?)`;
    return this.db.transaction(() => {
      const runs = this.db.prepare(`SELECT * FROM plan_queue_runs WHERE id IN (${selectedIds})
        ORDER BY started_at DESC, id DESC`).all<RunRow>(limit);
      const items = this.db.prepare(`SELECT * FROM plan_queue_items WHERE run_id IN (${selectedIds})
        ORDER BY created_at, id`).all<ItemRow>(limit);
      const itemsByRun = new Map<string, PlanQueueItem[]>();
      for (const row of items) {
        const group = itemsByRun.get(row.run_id) ?? [];
        group.push(rowToItem(row));
        itemsByRun.set(row.run_id, group);
      }
      return runs.map(row => ({ run: rowToRun(row), items: itemsByRun.get(row.id) ?? [] }));
    })();
  }

  /** Every workspace a run has ever used; the reconciler's search scope. */
  listWorkspaceRoots(): string[] {
    return this.db
      .prepare('SELECT DISTINCT workspace_cwd FROM plan_queue_runs ORDER BY workspace_cwd')
      .all<{ workspace_cwd: string }>()
      .map((r) => r.workspace_cwd);
  }

  /** Runs whose relaxed settings were never put back (app died mid-run). */
  listRunsWithRelaxation(): PlanQueueRun[] {
    return this.db
      .prepare('SELECT * FROM plan_queue_runs WHERE relaxation_json IS NOT NULL ORDER BY started_at')
      .all<RunRow>()
      .map(rowToRun);
  }

  upsertItem(item: PlanQueueItem): void {
    this.db.prepare(`
      INSERT INTO plan_queue_items (
        id, run_id, document_path, state, round, errored_rounds, landing_refusals, branch_name, worktree_path,
        base_commit, checkpoint_commit, verified_main_commit, landed_commit,
        worker_instance_id, verifier_instance_id, question_json, answer, park_reason, detail,
        verdict_json, created_at, updated_at, held_at, pending_instruction
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        state                = excluded.state,
        round                = excluded.round,
        errored_rounds       = excluded.errored_rounds,
        landing_refusals     = excluded.landing_refusals,
        branch_name          = excluded.branch_name,
        worktree_path        = excluded.worktree_path,
        base_commit          = excluded.base_commit,
        checkpoint_commit    = excluded.checkpoint_commit,
        verified_main_commit = excluded.verified_main_commit,
        landed_commit        = excluded.landed_commit,
        worker_instance_id   = excluded.worker_instance_id,
        verifier_instance_id = excluded.verifier_instance_id,
        question_json        = excluded.question_json,
        answer               = excluded.answer,
        park_reason          = excluded.park_reason,
        detail               = excluded.detail,
        verdict_json         = excluded.verdict_json,
        held_at              = excluded.held_at,
        pending_instruction  = excluded.pending_instruction,
        updated_at           = excluded.updated_at
    `).run(
      item.id,
      item.runId,
      item.documentPath,
      item.state,
      item.round,
      item.erroredRounds,
      item.landingRefusals,
      item.branchName,
      item.worktreePath,
      item.baseCommit,
      item.checkpointCommit,
      item.verifiedMainCommit,
      item.landedCommit,
      item.workerInstanceId,
      item.verifierInstanceId,
      item.question ? JSON.stringify(item.question) : null,
      item.answer,
      item.parkReason,
      item.detail,
      item.verdict ? JSON.stringify(item.verdict) : null,
      item.createdAt,
      this.now(),
      item.heldAt ?? null,
      item.pendingInstruction ?? null,
    );
  }

  getItem(itemId: string): PlanQueueItem | null {
    const row = this.db.prepare('SELECT * FROM plan_queue_items WHERE id = ?').get<ItemRow>(itemId);
    return row ? rowToItem(row) : null;
  }

  listItems(runId: string): PlanQueueItem[] {
    return this.db
      .prepare('SELECT * FROM plan_queue_items WHERE run_id = ? ORDER BY created_at, id')
      .all<ItemRow>(runId)
      .map(rowToItem);
  }

  /** Every item that has ever been given a branch or worktree, across all runs. */
  listItemsWithGitOwnership(): PlanQueueItem[] {
    return this.db
      .prepare(`
        SELECT * FROM plan_queue_items
        WHERE branch_name IS NOT NULL OR worktree_path IS NOT NULL
        ORDER BY created_at, id
      `)
      .all<ItemRow>()
      .map(rowToItem);
  }

  findItemByInstance(instanceId: string): PlanQueueItem | null {
    const row = this.db
      .prepare(`
        SELECT * FROM plan_queue_items
        WHERE worker_instance_id = ? OR verifier_instance_id = ?
        ORDER BY updated_at DESC LIMIT 1
      `)
      .get<ItemRow>(instanceId, instanceId);
    return row ? rowToItem(row) : null;
  }
}

function rowToRun(row: RunRow): PlanQueueRun {
  return {
    ...(row.tokens || row.cost_usd || row.exact_cost_usd ? { spend: { tokens: row.tokens, costUsd: row.cost_usd, exactUsd: row.exact_cost_usd } } : {}),
    id: row.id,
    parentInstanceId: row.parent_instance_id,
    parentHistoryThreadId: row.parent_history_thread_id ?? null,
    kind: row.kind as PlanQueueKind,
    workspaceCwd: row.workspace_cwd,
    status: row.status as PlanQueueRunStatus,
    // Defaults first, so a config stored before a field existed still reads whole.
    config: {
      ...DEFAULT_PLAN_QUEUE_CONFIG[row.kind as PlanQueueKind],
      ...(JSON.parse(row.config_json) as Partial<PlanQueueRunConfig>),
    },
    relaxation: row.relaxation_json
      ? (JSON.parse(row.relaxation_json) as PlanQueueRelaxationSnapshot)
      : null,
    workerProvider: row.worker_provider,
    workerModel: row.worker_model,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function rowToItem(row: ItemRow): PlanQueueItem {
  return {
    ...(row.tokens || row.cost_usd || row.exact_cost_usd ? { spend: { tokens: row.tokens, costUsd: row.cost_usd, exactUsd: row.exact_cost_usd } } : {}),
    id: row.id,
    runId: row.run_id,
    documentPath: row.document_path,
    heldAt: row.held_at ?? null,
    pendingInstruction: row.pending_instruction ?? null,
    state: row.state as PlanQueueItemState,
    round: row.round,
    erroredRounds: row.errored_rounds,
    landingRefusals: row.landing_refusals,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    baseCommit: row.base_commit,
    checkpointCommit: row.checkpoint_commit,
    verifiedMainCommit: row.verified_main_commit,
    landedCommit: row.landed_commit,
    workerInstanceId: row.worker_instance_id,
    verifierInstanceId: row.verifier_instance_id,
    question: row.question_json ? (JSON.parse(row.question_json) as PlanQueueQuestion) : null,
    answer: row.answer,
    parkReason: row.park_reason as PlanQueueParkReason | null,
    detail: row.detail,
    verdict: row.verdict_json ? (JSON.parse(row.verdict_json) as PlanQueueVerdict) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
