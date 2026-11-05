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

import { getLogger } from '../logging/logger';
import type { SqliteDriver } from '../db/sqlite-driver';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type {
  PlanQueueItemState,
  PlanQueueKind,
  PlanQueueParkReason,
  PlanQueueQuestion,
  PlanQueueRunConfig,
  PlanQueueRunDto,
  PlanQueueRunStatus,
  PlanQueueVerdict,
} from '@contracts/schemas/plan-queue';
import { upgradePlanQueueRouting, type StoredPlanQueueRouting } from '../../shared/utils/plan-queue-routing-upgrade';
import type { PlanQueueItem, PlanQueueRelaxationSnapshot, PlanQueueRun, PlanQueueSpendEntry } from './plan-queue.types';
import { PlanQueueHistoryStore, PLAN_QUEUE_CHECK_SUMMARIES_SQL } from './plan-queue-history-store';
import { readQueueHealth } from './plan-queue-health';
import { PlanQueueSlotWaits } from './plan-queue-timings';
import { itemHoldsWorktree } from './plan-queue-state';

interface RunRow {
  unpriced_tokens: number;
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
  unpriced_tokens: number;
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
  worker_provider: string | null;
  worker_model: string | null;
  stepped_up_at: number | null;
  worker_session_json: string | null;
  livetest_port: number | null;
  base_conflicts: number;
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
  readonly history: PlanQueueHistoryStore;
  /** Slot waits the scheduler measures (in memory); they are written to the history when the item starts. */
  readonly waits: PlanQueueSlotWaits;
  constructor(
    private readonly db: SqliteDriver,
    private readonly now: () => number = Date.now,
  ) { this.history = new PlanQueueHistoryStore(db, now); this.waits = new PlanQueueSlotWaits(this.history, now); }

  /** The "Queue health" measures for the recent window, computed from the stored events and verdicts. */
  queueHealth() { return readQueueHealth(this.db, this.now()); }

  recordSpend(entry: PlanQueueSpendEntry): void {
    if (![entry.processed, entry.output].every(value => Number.isSafeInteger(value) && value >= 0)
      || entry.costUsd !== null && (!Number.isFinite(entry.costUsd) || entry.costUsd < 0)) throw new Error('Invalid queue spend');
    this.db.transaction(() => {
      if (!this.getRun(entry.runId) || entry.itemId !== null && this.getItem(entry.itemId)?.runId !== entry.runId) throw new Error('Queue spend has no matching job');
      this.db.prepare(`INSERT INTO plan_queue_spend
        (id, item_id, run_id, role, round, provider, model, processed, output, cost_usd, cost_basis, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(entry.id, entry.itemId, entry.runId, entry.role, entry.round,
        entry.provider, entry.model, entry.processed, entry.output, entry.costUsd, entry.costBasis, entry.createdAt);
      const tokens = entry.processed + entry.output;
      const table = entry.itemId ? 'plan_queue_items' : 'plan_queue_runs';
      this.db.prepare(`UPDATE ${table} SET tokens = tokens + ?, cost_usd = cost_usd + ?, exact_cost_usd = exact_cost_usd + ?,
        unpriced_tokens = unpriced_tokens + ? WHERE id = ?`).run(tokens, entry.costUsd ?? 0,
        entry.costBasis === 'exact' ? entry.costUsd ?? 0 : 0, entry.costUsd === null ? tokens : 0, entry.itemId ?? entry.runId);
    })();
  }

  listSpend(runId: string, limit = 100): PlanQueueSpendEntry[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Queue spend limit must be between 1 and 1000');
    return this.db.prepare(`SELECT id, item_id AS itemId, run_id AS runId, role, round, provider, model, processed, output,
      cost_usd AS costUsd, cost_basis AS costBasis, created_at AS createdAt FROM plan_queue_spend
      WHERE run_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`).all<PlanQueueSpendEntry>(runId, limit);
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
  listRunSnapshots(limit = 50): { run: PlanQueueRun; items: PlanQueueItem[]; checks?: PlanQueueRunDto['checks'] }[] {
    const selectedIds = `SELECT id FROM plan_queue_runs
      WHERE status IN ${ACTIVE_RUN_STATUSES}
        OR id IN (SELECT run_id FROM plan_queue_items WHERE state = 'parked')
        OR id IN (SELECT id FROM plan_queue_runs ORDER BY started_at DESC, id DESC LIMIT ?)`;
    return this.db.transaction(() => {
      const runs = this.db.prepare(`SELECT runs.*, checks.runs AS check_runs, checks.jobs AS check_jobs
        FROM plan_queue_runs runs LEFT JOIN (${PLAN_QUEUE_CHECK_SUMMARIES_SQL}) checks ON checks.run_id = runs.id
        WHERE runs.id IN (${selectedIds}) ORDER BY runs.started_at DESC, runs.id DESC`)
        .all<RunRow & { check_runs: number | null; check_jobs: number | null }>(limit);
      const items = this.db.prepare(`SELECT * FROM plan_queue_items WHERE run_id IN (${selectedIds})
        ORDER BY created_at, id`).all<ItemRow>(limit);
      const itemsByRun = new Map<string, PlanQueueItem[]>();
      for (const row of items) {
        const group = itemsByRun.get(row.run_id) ?? [];
        group.push(rowToItem(row));
        itemsByRun.set(row.run_id, group);
      }
      return runs.map(row => ({ run: rowToRun(row), items: itemsByRun.get(row.id) ?? [],
        ...(row.check_runs ? { checks: { runs: row.check_runs, jobs: row.check_jobs! } } : {}),
      }));
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
    // Reasons change at every transition; recovery locations must outlive them.
    // Read the durable row, not a caller's possibly stale item snapshot, in the
    // same transaction as the write so another save cannot lose a receipt.
    this.db.transaction(() => {
      const previous = this.db.prepare('SELECT detail, state FROM plan_queue_items WHERE id = ?')
        .get<{ detail: string | null; state: PlanQueueItemState }>(item.id);
      this.writeItem({ ...item, detail: preserveRecoveryReceipts(previous?.detail ?? null, item.detail) });
      if (!previous || previous.state !== item.state) {
        this.history.recordEvent({
          itemId: item.id, runId: item.runId, fromState: previous?.state ?? null, toState: item.state,
          reason: item.parkReason, detailHead: item.detail, round: item.round, tokens: item.spend?.tokens ?? 0,
        });
        // A worker slot is held from preparing to landing; a check slot while verifying.
        if (previous && itemHoldsWorktree(previous.state) && !itemHoldsWorktree(item.state)) this.waits.freed('worker');
        if (previous?.state === 'verifying') this.waits.freed('check');
      }
    })();
  }

  private writeItem(item: PlanQueueItem): void {
    this.db.prepare(`
      INSERT INTO plan_queue_items (
        id, run_id, document_path, state, round, errored_rounds, landing_refusals, branch_name, worktree_path,
        base_commit, checkpoint_commit, verified_main_commit, landed_commit,
        worker_instance_id, verifier_instance_id, question_json, answer, park_reason, detail,
        verdict_json, created_at, updated_at, held_at, pending_instruction, worker_provider, worker_model, stepped_up_at, worker_session_json, livetest_port, base_conflicts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        worker_provider      = excluded.worker_provider,
        worker_model         = excluded.worker_model,
        stepped_up_at        = excluded.stepped_up_at,
        worker_session_json  = excluded.worker_session_json,
        livetest_port        = excluded.livetest_port,
        base_conflicts       = excluded.base_conflicts,
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
      item.workerProvider ?? null,
      item.workerModel ?? null,
      item.steppedUpAt ?? null,
      item.workerSession ? JSON.stringify(item.workerSession) : null,
      item.livetestPort ?? null,
      item.baseConflicts,
    );
  }

  getItem(itemId: string): PlanQueueItem | null {
    const row = this.db.prepare('SELECT * FROM plan_queue_items WHERE id = ?').get<ItemRow>(itemId);
    return row ? rowToItem(row) : null;
  }

  findLatestParkedItem(documentPath: string, parentInstanceId: string): PlanQueueItem | null {
    const row = this.db.prepare(`SELECT item.* FROM plan_queue_items item
      JOIN plan_queue_runs run ON run.id = item.run_id
      WHERE item.document_path = ? AND item.state = 'parked' AND item.branch_name IS NOT NULL
        AND run.parent_instance_id = ? ORDER BY item.updated_at DESC, item.created_at DESC, item.id DESC LIMIT 1`)
      .get<ItemRow>(documentPath, parentInstanceId);
    return row ? rowToItem(row) : null;
  }

  listItems(runId: string): PlanQueueItem[] {
    return this.db
      .prepare('SELECT * FROM plan_queue_items WHERE run_id = ? ORDER BY created_at, id')
      .all<ItemRow>(runId)
      .map(rowToItem);
  }

  /** Parked items in one project folder, newest first, each saying whether its document landed afterwards. */
  listParkedInFolder(workspaceCwd: string): { item: PlanQueueItem; landedLater: boolean }[] {
    return this.db
      .prepare(`
        SELECT item.*, EXISTS (
          SELECT 1 FROM plan_queue_items landed
          WHERE landed.document_path = item.document_path AND landed.state = 'landed' AND landed.updated_at >= item.updated_at
        ) AS landed_later
        FROM plan_queue_items item JOIN plan_queue_runs run ON run.id = item.run_id
        WHERE run.workspace_cwd = ? AND item.state = 'parked'
        ORDER BY item.updated_at DESC, item.id DESC
      `)
      .all<ItemRow & { landed_later: number }>(workspaceCwd)
      .map((row) => ({ item: rowToItem(row), landedLater: row.landed_later === 1 }));
  }

  /** True when another item is working on this document. */
  documentInPlay(documentPath: string, exceptItemId: string): boolean {
    return this.db
      .prepare(`
        SELECT 1 FROM plan_queue_items
        WHERE document_path = ? AND id != ? AND state NOT IN ('landed', 'skipped', 'parked') LIMIT 1
      `)
      .get(documentPath, exceptItemId) !== undefined;
  }

  /** Dev-app ports recorded on items that are still in play (not landed, skipped or parked), except one item's own. */
  listLivetestPortsInUse(exceptItemId: string): number[] {
    return this.db
      .prepare(`
        SELECT livetest_port FROM plan_queue_items
        WHERE livetest_port IS NOT NULL AND id != ? AND state NOT IN ('landed', 'skipped', 'parked')
      `)
      .all<{ livetest_port: number }>(exceptItemId)
      .map((row) => row.livetest_port);
  }

  /** Parked or landed items that still record a worktree folder, across all runs. */
  listItemsWithKeptFolders(): PlanQueueItem[] {
    return this.db
      .prepare(`
        SELECT * FROM plan_queue_items
        WHERE state IN ('parked', 'landed') AND worktree_path IS NOT NULL
        ORDER BY created_at, id
      `)
      .all<ItemRow>()
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

/** Keep bounded, monotonic recovery evidence using the existing persisted field. */
function preserveRecoveryReceipts(previous: string | null, next: string | null): string | null {
  const receiptPattern = /^Orphan checkout (retained at|recovery location:) ([^\r\n]+)$/;
  const locations = new Map<string, boolean>();
  for (const detail of [previous, next]) {
    for (const line of (detail ?? '').split('\n')) {
      const receipt = receiptPattern.exec(line);
      if (receipt) locations.set(receipt[2]!, locations.get(receipt[2]!) === true || receipt[1] === 'retained at');
    }
  }
  if (!locations.size) return next;
  const receipts = [...locations].map(([location, retained]) =>
    `Orphan checkout ${retained ? 'retained at' : 'recovery location:'} ${location}\n`).join('');
  // Refuse before any quarantine move if evidence itself no longer fits the
  // DTO's limit; never silently trim a location to make another save succeed.
  if (receipts.length > 8000) throw new Error('Recovery receipts exceed the queue detail limit; retained locations were not changed');
  const notes = (next ?? '').split('\n').filter((line) => !receiptPattern.test(line)).join('\n');
  return receipts + notes.slice(0, 8000 - receipts.length);
}

function rowToRun(row: RunRow): PlanQueueRun {
  const { routing, ...stored } = JSON.parse(row.config_json) as Partial<Omit<PlanQueueRunConfig, 'routing'>> & { routing?: StoredPlanQueueRouting };
  return {
    ...(row.tokens || row.cost_usd || row.exact_cost_usd ? { spend: { tokens: row.tokens, costUsd: row.cost_usd, exactUsd: row.exact_cost_usd, ...(row.unpriced_tokens ? { unpricedTokens: row.unpriced_tokens } : {}) } } : {}),
    id: row.id,
    parentInstanceId: row.parent_instance_id,
    parentHistoryThreadId: row.parent_history_thread_id ?? null,
    kind: row.kind as PlanQueueKind,
    workspaceCwd: row.workspace_cwd,
    status: row.status as PlanQueueRunStatus,
    // Defaults first, so a config stored before a field existed still reads whole.
    config: {
      ...DEFAULT_PLAN_QUEUE_CONFIG[row.kind as PlanQueueKind],
      ...stored,
      checkBatchSize: stored.checkBatchSize ?? 1,
      ...(routing ? { routing: upgradePlanQueueRouting(routing) } : {}),
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

const invalidWorkerSessions = new Set<string>();
function readWorkerSession(row: ItemRow): PlanQueueItem['workerSession'] {
  if (!row.worker_session_json) return undefined;
  try {
    const value = JSON.parse(row.worker_session_json) as Record<string, unknown> | null;
    if (!value || typeof value['provider'] !== 'string' || typeof value['providerSessionId'] !== 'string'
      || typeof value['workingDirectory'] !== 'string' || typeof value['recordedAt'] !== 'number'
      || !(value['model'] === null || typeof value['model'] === 'string')
      || !(value['accountProfileId'] === null || typeof value['accountProfileId'] === 'string')) throw new Error('Invalid worker session shape');
    return value as unknown as PlanQueueItem['workerSession'];
  }
  catch {
    if (!invalidWorkerSessions.has(row.id)) {
      invalidWorkerSessions.add(row.id);
      getLogger('PlanQueueStore').warn('Invalid worker session record', { itemId: row.id });
    }
    return undefined;
  }
}

function rowToItem(row: ItemRow): PlanQueueItem {
  return {
    ...(row.tokens || row.cost_usd || row.exact_cost_usd ? { spend: { tokens: row.tokens, costUsd: row.cost_usd, exactUsd: row.exact_cost_usd, ...(row.unpriced_tokens ? { unpricedTokens: row.unpriced_tokens } : {}) } } : {}),
    workerSession: readWorkerSession(row),
    ...(row.livetest_port === null || row.livetest_port === undefined ? {} : { livetestPort: row.livetest_port }),
    id: row.id,
    runId: row.run_id,
    documentPath: row.document_path,
    heldAt: row.held_at ?? null,
    pendingInstruction: row.pending_instruction ?? null,
    state: row.state as PlanQueueItemState,
    round: row.round,
    erroredRounds: row.errored_rounds,
    landingRefusals: row.landing_refusals,
    baseConflicts: row.base_conflicts ?? 0,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    baseCommit: row.base_commit,
    checkpointCommit: row.checkpoint_commit,
    verifiedMainCommit: row.verified_main_commit,
    landedCommit: row.landed_commit,
    workerInstanceId: row.worker_instance_id,
    verifierInstanceId: row.verifier_instance_id,
    ...(row.worker_provider ? { workerProvider: row.worker_provider } : {}),
    ...(row.worker_model ? { workerModel: row.worker_model } : {}),
    ...(row.stepped_up_at !== null && row.stepped_up_at !== undefined ? { steppedUpAt: row.stepped_up_at } : {}),
    question: row.question_json ? (JSON.parse(row.question_json) as PlanQueueQuestion) : null,
    answer: row.answer,
    parkReason: row.park_reason as PlanQueueParkReason | null,
    detail: row.detail,
    verdict: row.verdict_json ? (JSON.parse(row.verdict_json) as PlanQueueVerdict) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
