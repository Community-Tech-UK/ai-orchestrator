/**
 * Loop Mode Persistence (DAO + service singleton)
 *
 * Stores `loop_runs` and `loop_iterations`. The store is the source of
 * truth for restart recovery: on app startup, it can list paused/running
 * loops and the coordinator can re-hydrate them.
 *
 * Mirrors `ConversationLedgerService` shape (own DB file, own migrations).
 */

import { mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { createHash } from 'crypto';
import { app } from 'electron';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver, SqliteDriverFactory } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';
import type {
  LoopConfig,
  LoopIteration,
  LoopOutstandingItem,
  LoopOutstandingItemKind,
  LoopOutstandingItemStatus,
  LoopRunSummary,
  LoopState,
  LoopStatus,
  LoopTerminalIntent,
} from '../../shared/types/loop.types';
import type { LoopCheckpoint } from './loop-checkpoint';
import { runLoopMigrations } from './loop-schema';
import {
  getLoopCheckpoint,
  listResumableLoopCheckpoints,
  upsertLoopCheckpoint,
} from './loop-store-checkpoints';
import { countLoopIterations, selectLoopIterations } from './loop-store-iterations';

/** Deterministic id for an aggregated outstanding item: same (run, kind, text)
 *  always collapses to the same row so re-captures upsert (and keep the user's
 *  resolved/dismissed status) instead of duplicating. */
export function outstandingItemId(
  loopRunId: string,
  kind: LoopOutstandingItemKind,
  text: string,
): string {
  return createHash('sha256').update(`${loopRunId}\0${kind}\0${text}`).digest('hex').slice(0, 32);
}

const logger = getLogger('LoopStore');

interface LoopRunRow {
  id: string;
  chat_id: string;
  plan_file: string | null;
  config_json: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  total_iterations: number;
  total_tokens: number;
  total_cost_cents: number;
  current_stage: string | null;
  completed_file_rename_observed: number;
  highest_test_pass_count: number;
  end_reason: string | null;
  end_evidence_json: string | null;
  /** FU-3: consecutive boot-time interruptions with no intervening progress. */
  restart_failure_count: number;
  /** FU-2: true (1) when the loop was started with no verifyCommand. */
  manual_review_only: number;
}

/** FU-3: when restart_failure_count reaches this many consecutive
 *  interruptions, treat the loop as a crash spiral and refuse to
 *  pause-restore it. The threshold is intentionally lenient (a user
 *  who restarts their machine twice while a long-running loop sleeps
 *  shouldn't trigger crash-loop). */
const CRASH_LOOP_THRESHOLD = 3;

/** Subset of `loop_runs` columns used to build a `LoopRunSummary`. */
interface RunSummaryRow {
  id: string;
  chat_id: string;
  status: string;
  total_iterations: number;
  total_tokens: number;
  total_cost_cents: number;
  started_at: number;
  ended_at: number | null;
  end_reason: string | null;
  config_json: string;
}

/**
 * Convert a `loop_runs` row to a `LoopRunSummary`, parsing the persisted
 * `config_json` to recover `initialPrompt` / `iterationPrompt`. The blob is
 * the source of truth for the prompts — there are no dedicated columns for
 * them, which means past runs created before this surface was added still
 * yield a usable prompt without a migration.
 *
 * `config_json` should always parse cleanly (it was written by us), but if
 * it ever fails (corrupt row, manual edit, partial write) we fall back to
 * empty strings so the list view still renders.
 */
function rowToRunSummary(row: RunSummaryRow): LoopRunSummary {
  let initialPrompt = '';
  let iterationPrompt: string | null = null;
  try {
    const parsed = JSON.parse(row.config_json) as Partial<LoopConfig>;
    if (typeof parsed.initialPrompt === 'string') initialPrompt = parsed.initialPrompt;
    if (typeof parsed.iterationPrompt === 'string' && parsed.iterationPrompt.length > 0) {
      iterationPrompt = parsed.iterationPrompt;
    }
  } catch (err) {
    logger.warn('rowToRunSummary: failed to parse config_json', {
      loopRunId: row.id,
      error: String(err),
    });
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    status: row.status as LoopStatus,
    totalIterations: row.total_iterations,
    totalTokens: row.total_tokens,
    totalCostCents: row.total_cost_cents,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endReason: row.end_reason,
    initialPrompt,
    iterationPrompt,
  };
}

interface LoopTerminalIntentRow {
  id: string;
  loop_run_id: string;
  iteration_seq: number;
  kind: string;
  status: string;
  summary: string;
  evidence_json: string;
  source: string;
  created_at: number;
  received_at: number;
  status_reason: string | null;
  file_path: string | null;
}

interface LoopOutstandingItemRow {
  id: string;
  loop_run_id: string;
  chat_id: string;
  workspace_cwd: string;
  kind: string;
  text: string;
  user_response: string | null;
  status: string;
  loop_status: string;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
}

function rowToOutstandingItem(row: LoopOutstandingItemRow): LoopOutstandingItem {
  return {
    id: row.id,
    loopRunId: row.loop_run_id,
    chatId: row.chat_id,
    workspaceCwd: row.workspace_cwd,
    kind: row.kind as LoopOutstandingItemKind,
    text: row.text,
    userResponse: row.user_response ?? null,
    status: row.status as LoopOutstandingItemStatus,
    loopStatus: row.loop_status as LoopStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
  };
}

export class LoopStore {
  constructor(private readonly db: SqliteDriver) {}

  /**
   * Insert / overwrite a loop run row from in-memory state.
   *
   * NB: `restart_failure_count` (FU-3) is intentionally NOT in the UPDATE
   * SET clause. The in-memory `LoopState` doesn't carry the counter, so
   * including it here would clobber the column to 0 on every state-change
   * upsert. SQLite's `ON CONFLICT DO UPDATE SET` leaves un-listed columns
   * alone, which is exactly what we want — only the dedicated counter
   * APIs (`markRunningAsInterruptedOnBoot`, `resetRestartFailureCount`)
   * may write that column. On INSERT the column gets `DEFAULT 0` from the
   * schema. See `loop-store.spec.ts` "preserves restart_failure_count
   * across routine upsertRun calls" for the regression guard.
   *
   * `manual_review_only` (FU-2 persistence) IS included so the flag
   * survives DB round-trips. The value is derived from the loop's
   * configuration at start time and doesn't change during the run, so
   * a clobbering UPDATE is safe (and on rehydration it must round-trip
   * accurately — see migration 004).
   */
  upsertRun(state: LoopState): void {
    this.db.prepare(`
      INSERT INTO loop_runs (
        id, chat_id, plan_file, config_json, status, started_at, ended_at,
        total_iterations, total_tokens, total_cost_cents, current_stage,
        completed_file_rename_observed, highest_test_pass_count, end_reason,
        end_evidence_json, manual_review_only
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        ended_at = excluded.ended_at,
        total_iterations = excluded.total_iterations,
        total_tokens = excluded.total_tokens,
        total_cost_cents = excluded.total_cost_cents,
        current_stage = excluded.current_stage,
        completed_file_rename_observed = excluded.completed_file_rename_observed,
        highest_test_pass_count = excluded.highest_test_pass_count,
        end_reason = excluded.end_reason,
        end_evidence_json = excluded.end_evidence_json,
        manual_review_only = excluded.manual_review_only
    `).run(
      state.id,
      state.chatId,
      state.config.planFile ?? null,
      JSON.stringify(state.config),
      state.status,
      state.startedAt,
      state.endedAt,
      state.totalIterations,
      state.totalTokens,
      state.totalCostCents,
      state.currentStage,
      state.completedFileRenameObserved ? 1 : 0,
      state.highestTestPassCount,
      state.endReason ?? null,
      state.endEvidence ? JSON.stringify(state.endEvidence) : null,
      state.manualReviewOnly ? 1 : 0,
    );
    for (const intent of state.terminalIntentHistory ?? []) {
      this.upsertTerminalIntent(intent);
    }
  }

  /** Persist a single iteration. */
  insertIteration(iter: LoopIteration): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO loop_iterations (
        id, loop_run_id, seq, stage, started_at, ended_at, child_instance_id,
        tokens, cost_cents, files_changed_json, tool_calls_json, errors_json,
        test_pass_count, test_fail_count, work_hash, output_similarity_to_prev,
        output_excerpt, progress_verdict, progress_signals_json,
        completion_signals_fired_json, verify_status, verify_output_excerpt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      iter.id,
      iter.loopRunId,
      iter.seq,
      iter.stage,
      iter.startedAt,
      iter.endedAt,
      iter.childInstanceId,
      iter.tokens,
      iter.costCents,
      JSON.stringify(iter.filesChanged),
      JSON.stringify(iter.toolCalls),
      JSON.stringify(iter.errors),
      iter.testPassCount,
      iter.testFailCount,
      iter.workHash,
      iter.outputSimilarityToPrev,
      iter.outputExcerpt,
      iter.progressVerdict,
      JSON.stringify(iter.progressSignals),
      JSON.stringify(iter.completionSignalsFired),
      iter.verifyStatus,
      iter.verifyOutputExcerpt,
    );
  }

  /**
   * Recover the full persisted {@link LoopConfig} for a run by parsing its
   * `config_json` blob. Used to start a follow-up run (resume-with-answers)
   * that reuses the original provider / caps / completion settings. Returns
   * null when the run is unknown or its config blob is unparseable.
   */
  getRunConfig(loopRunId: string): LoopConfig | null {
    const row = this.db
      .prepare('SELECT config_json FROM loop_runs WHERE id = ?')
      .get<{ config_json: string }>(loopRunId);
    if (!row) return null;
    try {
      return JSON.parse(row.config_json) as LoopConfig;
    } catch (err) {
      logger.warn('getRunConfig: failed to parse config_json', { loopRunId, error: String(err) });
      return null;
    }
  }

  getRunSummary(loopRunId: string): LoopRunSummary | null {
    const row = this.db
      .prepare('SELECT id, chat_id, status, total_iterations, total_tokens, total_cost_cents, started_at, ended_at, end_reason, config_json FROM loop_runs WHERE id = ?')
      .get<RunSummaryRow>(loopRunId);
    if (!row) return null;
    return rowToRunSummary(row);
  }

  listRunsForChat(chatId: string, limit = 25): LoopRunSummary[] {
    const rows = this.db
      .prepare(`
        SELECT id, chat_id, status, total_iterations, total_tokens, total_cost_cents,
               started_at, ended_at, end_reason, config_json
        FROM loop_runs
        WHERE chat_id = ?
        ORDER BY started_at DESC
        LIMIT ?
      `)
      .all<RunSummaryRow>(chatId, limit);
    return rows.map(rowToRunSummary);
  }

  /** Re-hydrate paused/running loops at app startup. */
  listResumableRuns(): { runRow: LoopRunRow; config: LoopConfig }[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM loop_runs
        WHERE status IN ('running', 'paused')
        ORDER BY started_at ASC
      `)
      .all<LoopRunRow>();
    return rows.map((r) => ({ runRow: r, config: JSON.parse(r.config_json) as LoopConfig }));
  }

  getIterations(
    loopRunId: string,
    fromSeq?: number,
    toSeq?: number,
    options: { limit?: number; offset?: number } = {},
  ): LoopIteration[] {
    return selectLoopIterations(this.db, loopRunId, fromSeq, toSeq, options);
  }

  countIterations(loopRunId: string): number {
    return countLoopIterations(this.db, loopRunId);
  }

  upsertCheckpoint(checkpoint: LoopCheckpoint): void {
    upsertLoopCheckpoint(this.db, checkpoint);
  }

  getCheckpoint(loopRunId: string): LoopCheckpoint | null {
    return getLoopCheckpoint(this.db, loopRunId);
  }

  listResumableCheckpoints(limit = 50): LoopCheckpoint[] {
    return listResumableLoopCheckpoints(this.db, limit);
  }

  upsertTerminalIntent(intent: LoopTerminalIntent): void {
    this.db.prepare(`
      INSERT INTO loop_terminal_intents (
        id, loop_run_id, iteration_seq, kind, status, summary, evidence_json,
        source, created_at, received_at, status_reason, file_path, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        status_reason = excluded.status_reason,
        evidence_json = excluded.evidence_json,
        summary = excluded.summary,
        file_path = excluded.file_path,
        updated_at = excluded.updated_at
    `).run(
      intent.id,
      intent.loopRunId,
      intent.iterationSeq,
      intent.kind,
      intent.status,
      intent.summary,
      JSON.stringify(intent.evidence),
      intent.source,
      intent.createdAt,
      intent.receivedAt,
      intent.statusReason ?? null,
      intent.filePath ?? null,
      Date.now(),
    );
  }

  listTerminalIntents(loopRunId: string): LoopTerminalIntent[] {
    const rows = this.db.prepare(`
      SELECT id, loop_run_id, iteration_seq, kind, status, summary, evidence_json,
             source, created_at, received_at, status_reason, file_path
      FROM loop_terminal_intents
      WHERE loop_run_id = ?
      ORDER BY received_at ASC
    `).all<LoopTerminalIntentRow>(loopRunId);
    return rows.map((row) => ({
      id: row.id,
      loopRunId: row.loop_run_id,
      iterationSeq: row.iteration_seq,
      kind: row.kind as LoopTerminalIntent['kind'],
      status: row.status as LoopTerminalIntent['status'],
      summary: row.summary,
      evidence: JSON.parse(row.evidence_json) as LoopTerminalIntent['evidence'],
      source: row.source as LoopTerminalIntent['source'],
      createdAt: row.created_at,
      receivedAt: row.received_at,
      statusReason: row.status_reason ?? undefined,
      filePath: row.file_path ?? undefined,
    }));
  }

  /**
   * Mark all "running" loops as "paused" (or "failed" if they're in a
   * crash spiral) on app boot. FU-3 logic:
   *  - Each call increments `restart_failure_count` for every still-
   *    running loop.
   *  - When the count crosses `CRASH_LOOP_THRESHOLD` we mark the loop
   *    `failed` with reason `crash-loop` rather than resurrecting it.
   *  - A successful iteration calls `resetRestartFailureCount` so this
   *    threshold only triggers when a loop genuinely crashes every
   *    restart without making progress.
   * Returns the total number of running-row updates applied.
   */
  markRunningAsInterruptedOnBoot(): number {
    const rows = this.db
      .prepare('SELECT id, restart_failure_count FROM loop_runs WHERE status = \'running\'')
      .all<{ id: string; restart_failure_count: number | null }>();
    let changes = 0;
    const pauseStmt = this.db.prepare(
      "UPDATE loop_runs SET status = 'paused', end_reason = 'app-restart', restart_failure_count = ? WHERE id = ?",
    );
    const failStmt = this.db.prepare(
      "UPDATE loop_runs SET status = 'failed', end_reason = 'crash-loop', restart_failure_count = ?, ended_at = ? WHERE id = ?",
    );
    for (const row of rows) {
      const nextCount = (row.restart_failure_count ?? 0) + 1;
      if (nextCount >= CRASH_LOOP_THRESHOLD) {
        const r = failStmt.run(nextCount, Date.now(), row.id);
        changes += Number(r.changes ?? 0);
      } else {
        const r = pauseStmt.run(nextCount, row.id);
        changes += Number(r.changes ?? 0);
      }
    }
    return changes;
  }

  /**
   * FU-3: reset the restart-failure counter for a loop. Called by the
   * coordinator's iteration hook after a successful iteration so a
   * loop that crashed once and then ran successfully isn't penalised
   * on the next interruption.
   */
  resetRestartFailureCount(loopRunId: string): void {
    this.db
      .prepare('UPDATE loop_runs SET restart_failure_count = 0 WHERE id = ?')
      .run(loopRunId);
  }

  /** FU-3: read the current restart-failure counter (mostly for tests). */
  getRestartFailureCount(loopRunId: string): number {
    const row = this.db
      .prepare('SELECT restart_failure_count FROM loop_runs WHERE id = ?')
      .get<{ restart_failure_count: number | null }>(loopRunId);
    return row?.restart_failure_count ?? 0;
  }

  /**
   * Return the set of intent ids already present in `loop_terminal_intents`
   * for a given loop. Used by the startup orphan reconciler to detect
   * intent files that were archived to `<controlDir>/imported/` before a
   * crash but never reached the database. Cheaper than `listTerminalIntents`
   * when the caller only needs membership testing.
   */
  getKnownTerminalIntentIds(loopRunId: string): Set<string> {
    const rows = this.db
      .prepare('SELECT id FROM loop_terminal_intents WHERE loop_run_id = ?')
      .all<{ id: string }>(loopRunId);
    return new Set(rows.map((row) => row.id));
  }

  // ────── outstanding items (Needs human / Open questions) ──────

  /**
   * Persist a terminated loop's structured OUTSTANDING.md snapshot as individual
   * rows. Idempotent: the deterministic {@link outstandingItemId} means a
   * re-capture upserts the same rows and PRESERVES any user-set status
   * (resolved/dismissed) — only `loop_status`/`updated_at` refresh. No-op when
   * the state carries no outstanding snapshot.
   */
  saveOutstandingItems(state: LoopState): void {
    const outstanding = state.outstanding;
    if (!outstanding) return;
    const now = Date.now();
    const rows: { kind: LoopOutstandingItemKind; text: string }[] = [
      ...outstanding.needsHuman.map((text) => ({ kind: 'needs-human' as const, text })),
      ...outstanding.openQuestions.map((text) => ({ kind: 'open-question' as const, text })),
    ];
    if (rows.length === 0) return;
    const stmt = this.db.prepare(`
      INSERT INTO loop_outstanding_items (
        id, loop_run_id, chat_id, workspace_cwd, kind, text, status,
        loop_status, created_at, updated_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        loop_status = excluded.loop_status,
        updated_at = excluded.updated_at
    `);
    const insertAll = this.db.transaction(() => {
      for (const { kind, text } of rows) {
        stmt.run(
          outstandingItemId(state.id, kind, text),
          state.id,
          state.chatId,
          state.config.workspaceCwd,
          kind,
          text,
          state.status,
          outstanding.capturedAt || now,
          now,
        );
      }
    });
    insertAll();
  }

  /**
   * List aggregated outstanding items. Defaults to status `'open'` so the panel
   * shows only un-resolved work; pass `status: 'all'` to include resolved/
   * dismissed. Optionally scoped to a chat/session and/or workspace.
   */
  listOutstandingItems(opts: {
    chatId?: string;
    workspaceCwd?: string;
    status?: LoopOutstandingItemStatus | 'all';
    limit?: number;
  } = {}): LoopOutstandingItem[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.chatId) {
      where.push('chat_id = ?');
      args.push(opts.chatId);
    }
    if (opts.workspaceCwd) {
      where.push('workspace_cwd = ?');
      args.push(opts.workspaceCwd);
    }
    const status = opts.status ?? 'open';
    if (status !== 'all') {
      where.push('status = ?');
      args.push(status);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    args.push(opts.limit ?? 200);
    const rows = this.db
      .prepare(`
        SELECT id, loop_run_id, chat_id, workspace_cwd, kind, text, user_response, status,
               loop_status, created_at, updated_at, resolved_at
        FROM loop_outstanding_items
        ${whereSql}
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all<LoopOutstandingItemRow>(...args);
    return rows.map(rowToOutstandingItem);
  }

  /**
   * Set one item's resolution status, optionally persisting the human's
   * answer/decision in the same write. Returns false when the id is unknown.
   *
   * `response` semantics: `undefined` leaves any existing answer untouched (so a
   * plain resolve/dismiss/reopen preserves the rationale); a string (including
   * `''` to clear) overwrites it.
   */
  setOutstandingItemStatus(
    id: string,
    status: LoopOutstandingItemStatus,
    response?: string,
  ): boolean {
    const resolvedAt = status === 'open' ? null : Date.now();
    const now = Date.now();
    const res = response === undefined
      ? this.db
        .prepare('UPDATE loop_outstanding_items SET status = ?, resolved_at = ?, updated_at = ? WHERE id = ?')
        .run(status, resolvedAt, now, id)
      : this.db
        .prepare('UPDATE loop_outstanding_items SET status = ?, resolved_at = ?, updated_at = ?, user_response = ? WHERE id = ?')
        .run(status, resolvedAt, now, response, id);
    return Number(res.changes ?? 0) > 0;
  }

  /** Count still-open items, optionally scoped to a chat, workspace, or single run. */
  countOpenOutstanding(opts: { chatId?: string; workspaceCwd?: string; loopRunId?: string } = {}): number {
    const where = ["status = 'open'"];
    const args: unknown[] = [];
    if (opts.chatId) {
      where.push('chat_id = ?');
      args.push(opts.chatId);
    }
    if (opts.workspaceCwd) {
      where.push('workspace_cwd = ?');
      args.push(opts.workspaceCwd);
    }
    if (opts.loopRunId) {
      where.push('loop_run_id = ?');
      args.push(opts.loopRunId);
    }
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM loop_outstanding_items WHERE ${where.join(' AND ')}`)
      .get<{ n: number }>(...args);
    return row?.n ?? 0;
  }
}

export interface LoopStoreServiceConfig {
  dbPath?: string;
  enableWAL?: boolean;
  cacheSize?: number;
  driverFactory?: SqliteDriverFactory;
  store?: LoopStore;
}

export class LoopStoreService {
  private static instance: LoopStoreService | null = null;
  private readonly db: SqliteDriver | null;
  private readonly _store: LoopStore;

  static getInstance(config?: LoopStoreServiceConfig): LoopStoreService {
    if (!this.instance) this.instance = new LoopStoreService(config);
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance?.db) {
      try { this.instance.db.close(); } catch { /* noop */ }
    }
    this.instance = null;
  }

  constructor(config: LoopStoreServiceConfig = {}) {
    if (config.store) {
      this._store = config.store;
      this.db = null;
    } else {
      const dbPath = config.dbPath ?? defaultLoopDbPath();
      mkdirSync(dirname(dbPath), { recursive: true });
      const factory = config.driverFactory ?? defaultDriverFactory;
      this.db = factory(dbPath);
      if (config.enableWAL ?? true) this.db.pragma('journal_mode = WAL');
      this.db.pragma(`cache_size = -${(config.cacheSize ?? 32) * 1024}`);
      this.db.pragma('foreign_keys = ON');
      runLoopMigrations(this.db);
      this._store = new LoopStore(this.db);
    }
    logger.info('LoopStoreService initialized');
  }

  get store(): LoopStore {
    return this._store;
  }

  /** Exposes the raw db driver for use by co-located stores (e.g. CampaignStore). */
  getDb(): SqliteDriver | null {
    return this.db;
  }

  close(): void {
    if (this.db) {
      try { this.db.close(); } catch { /* noop */ }
    }
  }
}

export function getLoopStoreService(config?: LoopStoreServiceConfig): LoopStoreService {
  return LoopStoreService.getInstance(config);
}

export function getLoopStore(): LoopStore {
  return LoopStoreService.getInstance().store;
}

function defaultLoopDbPath(): string {
  const userDataPath = app?.getPath?.('userData') || join(process.cwd(), '.loop-mode');
  return join(userDataPath, 'loop-mode', 'loop-mode.db');
}
