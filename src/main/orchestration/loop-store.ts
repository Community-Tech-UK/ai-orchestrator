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
import { app } from 'electron';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver, SqliteDriverFactory } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';
import type {
  LoopConfig,
  LoopIteration,
  LoopRunSummary,
  LoopState,
  LoopStatus,
  LoopTerminalIntent,
} from '../../shared/types/loop.types';
import { runLoopMigrations } from './loop-schema';

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
}

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

interface LoopIterationRow {
  id: string;
  loop_run_id: string;
  seq: number;
  stage: string;
  started_at: number;
  ended_at: number | null;
  child_instance_id: string | null;
  tokens: number;
  cost_cents: number;
  files_changed_json: string;
  tool_calls_json: string;
  errors_json: string;
  test_pass_count: number | null;
  test_fail_count: number | null;
  work_hash: string;
  output_similarity_to_prev: number | null;
  output_excerpt: string;
  progress_verdict: string;
  progress_signals_json: string;
  completion_signals_fired_json: string;
  verify_status: string;
  verify_output_excerpt: string;
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

export class LoopStore {
  constructor(private readonly db: SqliteDriver) {}

  /** Insert / overwrite a loop run row from in-memory state. */
  upsertRun(state: LoopState): void {
    this.db.prepare(`
      INSERT INTO loop_runs (
        id, chat_id, plan_file, config_json, status, started_at, ended_at,
        total_iterations, total_tokens, total_cost_cents, current_stage,
        completed_file_rename_observed, highest_test_pass_count, end_reason, end_evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        end_evidence_json = excluded.end_evidence_json
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

  getIterations(loopRunId: string, fromSeq?: number, toSeq?: number): LoopIteration[] {
    let sql = 'SELECT * FROM loop_iterations WHERE loop_run_id = ?';
    const args: unknown[] = [loopRunId];
    if (fromSeq != null) {
      sql += ' AND seq >= ?';
      args.push(fromSeq);
    }
    if (toSeq != null) {
      sql += ' AND seq <= ?';
      args.push(toSeq);
    }
    sql += ' ORDER BY seq ASC';
    const rows = this.db.prepare(sql).all<LoopIterationRow>(...args);
    return rows.map((r) => ({
      id: r.id,
      loopRunId: r.loop_run_id,
      seq: r.seq,
      stage: r.stage as LoopIteration['stage'],
      startedAt: r.started_at,
      endedAt: r.ended_at,
      childInstanceId: r.child_instance_id,
      tokens: r.tokens,
      costCents: r.cost_cents,
      filesChanged: JSON.parse(r.files_changed_json),
      toolCalls: JSON.parse(r.tool_calls_json),
      errors: JSON.parse(r.errors_json),
      testPassCount: r.test_pass_count,
      testFailCount: r.test_fail_count,
      workHash: r.work_hash,
      outputSimilarityToPrev: r.output_similarity_to_prev,
      outputExcerpt: r.output_excerpt,
      progressVerdict: r.progress_verdict as LoopIteration['progressVerdict'],
      progressSignals: JSON.parse(r.progress_signals_json),
      completionSignalsFired: JSON.parse(r.completion_signals_fired_json),
      verifyStatus: r.verify_status as LoopIteration['verifyStatus'],
      verifyOutputExcerpt: r.verify_output_excerpt,
    }));
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
   * Mark all "running" loops as "paused" with reason `app-restart` — called
   * at app boot. The user can then resume them after reviewing the trail.
   */
  markRunningAsInterruptedOnBoot(): number {
    const result = this.db
      .prepare("UPDATE loop_runs SET status = 'paused', end_reason = 'app-restart' WHERE status = 'running'")
      .run();
    return Number(result.changes ?? 0);
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
