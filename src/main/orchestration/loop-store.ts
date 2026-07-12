/**
 * Loop Mode Persistence (DAO + service singleton)
 *
 * Stores `loop_runs` and `loop_iterations`. The store is the source of
 * truth for restart recovery: on app startup, it can list paused/running
 * loops and the coordinator can re-hydrate them.
 *
 * Mirrors `ConversationLedgerService` shape (own DB file, own migrations).
 */

import { createHash } from 'crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
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
  /** P3: per-session git worktree path (null for pre-isolation runs). */
  worktree_path: string | null;
  /** P3: git branch name for this session's worktree (null for pre-isolation runs). */
  branch_name: string | null;
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
  resume_at: number | null;
}

interface LoopOutstandingItemRow {
  id: string;
  loop_run_id: string;
  chat_id: string;
  workspace_cwd: string;
  kind: string;
  text: string;
  user_response: string | null;
  recommended_answer: string | null;
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
    recommendedAnswer: row.recommended_answer ?? null,
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
   *
   * `worktree_path` / `branch_name` (P3) follow the same "INSERT-only"
   * pattern as `restart_failure_count`: they are written on the initial
   * INSERT (when config already has executionCwd / worktreeBranch set)
   * but intentionally NOT included in the ON CONFLICT UPDATE SET clause.
   * Only `clearWorktreeInfo` may mutate them after insert (to NULL them
   * after cleanup). This prevents routine state-change upserts from
   * re-populating the columns after clearWorktreeInfo has cleared them.
   */
  upsertRun(state: LoopState): void {
    this.db.prepare(`
      INSERT INTO loop_runs (
        id, chat_id, plan_file, config_json, status, started_at, ended_at,
        total_iterations, total_tokens, total_cost_cents, current_stage,
        completed_file_rename_observed, highest_test_pass_count, end_reason,
        end_evidence_json, manual_review_only,
        worktree_path, branch_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      state.config.executionCwd ?? null,
      state.config.worktreeBranch ?? null,
    );
    for (const intent of state.terminalIntentHistory ?? []) {
      this.upsertTerminalIntent(intent);
    }
  }

  /**
   * P3: Persist the worktree path and branch name for a loop run. Called once
   * after the worktree is acquired so boot-reconcile can adopt or reap orphaned
   * worktrees after a crash. Best-effort: missing rows are silently ignored.
   */
  updateWorktreeInfo(loopRunId: string, worktreePath: string, branchName: string): void {
    try {
      this.db.prepare(
        `UPDATE loop_runs SET worktree_path = ?, branch_name = ? WHERE id = ?`
      ).run(worktreePath, branchName, loopRunId);
    } catch (err) {
      logger.warn('LoopStore.updateWorktreeInfo: failed', { loopRunId, error: String(err) });
    }
  }

  /**
   * P3 boot-reconcile: return all terminal loop runs that still have a
   * worktree_path recorded. These are candidates for orphaned worktree cleanup —
   * the terminate path ran but the worktree was not removed (crash), or the app
   * restarted before the async cleanup completed.
   */
  getTerminalRunsWithWorktreePaths(): {
    id: string;
    worktreePath: string;
    branchName: string | null;
    workspaceCwd: string | null;
    status: string;
  }[] {
    interface Row {
      id: string;
      worktree_path: string;
      branch_name: string | null;
      config_json: string;
      status: string;
    }
    try {
      const rows = this.db.prepare(`
        SELECT id, worktree_path, branch_name, config_json, status
        FROM loop_runs
        WHERE worktree_path IS NOT NULL
          AND (
            status NOT IN ('running', 'paused', 'provider-limit')
            OR (status = 'provider-limit' AND ended_at IS NOT NULL)
          )
      `).all<Row>();
      return rows.map((row) => {
        let workspaceCwd: string | null = null;
        try {
          const cfg = JSON.parse(row.config_json) as { workspaceCwd?: string };
          workspaceCwd = typeof cfg.workspaceCwd === 'string' ? cfg.workspaceCwd : null;
        } catch {
          // unparseable config — can't determine repo root
        }
        return {
          id: row.id,
          worktreePath: row.worktree_path,
          branchName: row.branch_name,
          workspaceCwd,
          status: row.status,
        };
      });
    } catch (err) {
      logger.warn('LoopStore.getTerminalRunsWithWorktreePaths: failed', { error: String(err) });
      return [];
    }
  }

  /** P3 boot-reconcile: clear the worktree columns after cleanup so the row
   *  is not re-processed on the next boot. */
  clearWorktreeInfo(loopRunId: string): void {
    try {
      this.db.prepare(
        `UPDATE loop_runs SET worktree_path = NULL, branch_name = NULL WHERE id = ?`
      ).run(loopRunId);
    } catch (err) {
      logger.warn('LoopStore.clearWorktreeInfo: failed', { loopRunId, error: String(err) });
    }
  }

  /** Persist a single iteration. */
  insertIteration(iter: LoopIteration): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO loop_iterations (
        id, loop_run_id, seq, stage, started_at, ended_at, child_instance_id,
        tokens, cost_cents, cache_read_tokens, cache_write_tokens, model, cost_known,
        files_changed_json, tool_calls_json, errors_json,
        test_pass_count, test_fail_count, work_hash, output_similarity_to_prev,
        output_excerpt, output_full, progress_verdict, progress_signals_json,
        completion_signals_fired_json, verify_status, verify_output_excerpt,
        verify_failure_kind, final_audit_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      iter.cacheReadTokens ?? null,
      iter.cacheWriteTokens ?? null,
      iter.model ?? null,
      iter.costKnown === undefined ? null : (iter.costKnown ? 1 : 0),
      JSON.stringify(iter.filesChanged),
      JSON.stringify(iter.toolCalls),
      JSON.stringify(iter.errors),
      iter.testPassCount,
      iter.testFailCount,
      iter.workHash,
      iter.outputSimilarityToPrev,
      iter.outputExcerpt,
      iter.outputFull,
      iter.progressVerdict,
      JSON.stringify(iter.progressSignals),
      JSON.stringify(iter.completionSignalsFired),
      iter.verifyStatus,
      iter.verifyOutputExcerpt,
      iter.verifyFailureKind ?? null,
      iter.finalAudit ? JSON.stringify(iter.finalAudit) : null,
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

  /** Re-hydrate paused/running loops, plus parked provider-limit loops, at app startup. */
  listResumableRuns(): { runRow: LoopRunRow; config: LoopConfig }[] {
    const rows = this.db
      .prepare(`
        SELECT * FROM loop_runs
        WHERE status IN ('running', 'paused')
           OR (status = 'provider-limit' AND ended_at IS NULL)
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

  /**
   * Persist the sealed iteration snapshot as one durable unit. This keeps the
   * run row, iteration row, checkpoint row, and restart counter coherent across
   * process crashes or serialization failures.
   */
  persistIterationSnapshot(input: {
    state: LoopState;
    iteration: LoopIteration;
    checkpoint: LoopCheckpoint;
  }): void {
    const persist = this.db.transaction(() => {
      this.upsertRun(input.state);
      this.insertIteration(input.iteration);
      this.upsertCheckpoint(input.checkpoint);
      this.resetRestartFailureCount(input.state.id);
    });
    persist();
  }

  /** Persist a state-only checkpoint in the same transaction as the run row. */
  persistStateCheckpoint(input: {
    state: LoopState;
    checkpoint: LoopCheckpoint;
  }): void {
    const persist = this.db.transaction(() => {
      this.upsertRun(input.state);
      this.upsertCheckpoint(input.checkpoint);
    });
    persist();
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
        source, created_at, received_at, status_reason, file_path, resume_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        status_reason = excluded.status_reason,
        evidence_json = excluded.evidence_json,
        summary = excluded.summary,
        file_path = excluded.file_path,
        resume_at = excluded.resume_at,
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
      intent.resumeAt ?? null,
      Date.now(),
    );
  }

  listTerminalIntents(loopRunId: string): LoopTerminalIntent[] {
    const rows = this.db.prepare(`
      SELECT id, loop_run_id, iteration_seq, kind, status, summary, evidence_json,
             source, created_at, received_at, status_reason, file_path, resume_at
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
      resumeAt: row.resume_at ?? undefined,
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
    const rows: { kind: LoopOutstandingItemKind; text: string; recommendation: string | null }[] = [
      ...outstanding.needsHuman.map((e) => ({ kind: 'needs-human' as const, text: e.text, recommendation: e.recommendation })),
      ...outstanding.openQuestions.map((e) => ({ kind: 'open-question' as const, text: e.text, recommendation: e.recommendation })),
    ];
    if (rows.length === 0) return;
    // The deterministic id is keyed on (run, kind, text) — NOT the recommendation
    // — so a re-capture upserts the same row. We refresh `recommended_answer` on
    // conflict (the agent may have revised its suggestion); the user's
    // `user_response`/`status` are intentionally left untouched so a saved answer
    // always wins over the suggestion.
    const stmt = this.db.prepare(`
      INSERT INTO loop_outstanding_items (
        id, loop_run_id, chat_id, workspace_cwd, kind, text, recommended_answer, status,
        loop_status, created_at, updated_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL)
      ON CONFLICT(id) DO UPDATE SET
        loop_status = excluded.loop_status,
        recommended_answer = excluded.recommended_answer,
        updated_at = excluded.updated_at
    `);
    const insertAll = this.db.transaction(() => {
      for (const { kind, text, recommendation } of rows) {
        stmt.run(
          outstandingItemId(state.id, kind, text),
          state.id,
          state.chatId,
          state.config.workspaceCwd,
          kind,
          text,
          recommendation,
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
        SELECT id, loop_run_id, chat_id, workspace_cwd, kind, text, user_response,
               recommended_answer, status, loop_status, created_at, updated_at, resolved_at
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

export {
  getLoopStore,
  getLoopStoreService,
  LoopStoreService,
} from './loop-store-service';
export type { LoopStoreServiceConfig } from './loop-store-service';
