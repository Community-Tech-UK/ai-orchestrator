/**
 * A15 / 8b — persistence for the automation pre-check: the comparison
 * baseline, the capture pending on the run in flight, and the check-failure
 * streak behind the single "Automation check failing" notification.
 *
 * Kept out of `automation-store.ts` (which is at its LOC ceiling). The tables
 * come from RLM migration 078: `automation_check_state` (one row per checked
 * automation) and `automation_runs.outcome`.
 */

import type { SqliteDriver } from '../db/sqlite-driver';
import { getRLMDatabase } from '../persistence/rlm-database';
import type { AutomationRunOutcome } from '../../shared/types/automation.types';

/** The check output kept for comparison / prompt notes, at most 16 KB. */
export const CHECK_OUTPUT_MAX_CHARS = 16 * 1024;

export interface AutomationCheckState {
  automationId: string;
  baselineHash: string | null;
  baselineOutput: string | null;
  baselineAt: number | null;
  pendingRunId: string | null;
  pendingHash: string | null;
  pendingOutput: string | null;
  failureStreak: number;
  updatedAt: number;
}

interface AutomationCheckStateRow {
  automation_id: string;
  baseline_hash: string | null;
  baseline_output: string | null;
  baseline_at: number | null;
  pending_run_id: string | null;
  pending_hash: string | null;
  pending_output: string | null;
  failure_streak: number;
  updated_at: number;
}

function mapState(row: AutomationCheckStateRow): AutomationCheckState {
  return {
    automationId: row.automation_id,
    baselineHash: row.baseline_hash,
    baselineOutput: row.baseline_output,
    baselineAt: row.baseline_at,
    pendingRunId: row.pending_run_id,
    pendingHash: row.pending_hash,
    pendingOutput: row.pending_output,
    failureStreak: row.failure_streak,
    updatedAt: row.updated_at,
  };
}

function truncateOutput(output: string): string {
  return output.length > CHECK_OUTPUT_MAX_CHARS ? output.slice(0, CHECK_OUTPUT_MAX_CHARS) : output;
}

export class AutomationCheckStore {
  constructor(private readonly db: SqliteDriver) {}

  getState(automationId: string): AutomationCheckState | null {
    const row = this.db.prepare(`
      SELECT * FROM automation_check_state WHERE automation_id = ?
    `).get<AutomationCheckStateRow>(automationId);
    return row ? mapState(row) : null;
  }

  /**
   * Record the capture from the run currently in flight. The baseline is NOT
   * moved here — only `promotePending` after a successful run moves it.
   */
  setPending(automationId: string, runId: string, hash: string | null, output: string): void {
    const now = Date.now();
    const pendingOutput = truncateOutput(output);
    this.db.prepare(`
      INSERT INTO automation_check_state
        (automation_id, baseline_hash, baseline_output, baseline_at,
         pending_run_id, pending_hash, pending_output, failure_streak, updated_at)
      VALUES (?, NULL, NULL, NULL, ?, ?, ?, 0, ?)
      ON CONFLICT(automation_id) DO UPDATE SET
        pending_run_id = excluded.pending_run_id,
        pending_hash = excluded.pending_hash,
        pending_output = excluded.pending_output,
        updated_at = excluded.updated_at
    `).run(automationId, runId, hash, pendingOutput, now);
  }

  /**
   * Move the pending capture to the baseline — but only for the run it was
   * captured for (a stale run must not advance the comparison).
   */
  promotePending(runId: string, now = Date.now()): boolean {
    const result = this.db.prepare(`
      UPDATE automation_check_state
      SET baseline_hash = pending_hash,
          baseline_output = pending_output,
          baseline_at = ?,
          pending_run_id = NULL,
          pending_hash = NULL,
          pending_output = NULL,
          updated_at = ?
      WHERE pending_run_id = ?
    `).run(now, now, runId);
    return result.changes > 0;
  }

  /** Drop the pending capture (run ended without succeeding and no retry). */
  clearPending(runId: string): void {
    this.db.prepare(`
      UPDATE automation_check_state
      SET pending_run_id = NULL,
          pending_hash = NULL,
          pending_output = NULL,
          updated_at = ?
      WHERE pending_run_id = ?
    `).run(Date.now(), runId);
  }

  /** Record a failed check; returns the new streak (1 on the first failure). */
  recordCheckFailure(automationId: string): number {
    const now = Date.now();
    const tx = this.db.transaction((): number => {
      this.db.prepare(`
        INSERT INTO automation_check_state
          (automation_id, baseline_hash, baseline_output, baseline_at,
           pending_run_id, pending_hash, pending_output, failure_streak, updated_at)
        VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, 1, ?)
        ON CONFLICT(automation_id) DO UPDATE SET
          failure_streak = failure_streak + 1,
          updated_at = excluded.updated_at
      `).run(automationId, now);
      const row = this.db.prepare(`
        SELECT failure_streak FROM automation_check_state WHERE automation_id = ?
      `).get<{ failure_streak: number }>(automationId);
      return row?.failure_streak ?? 1;
    });
    return tx();
  }

  /** A successful check ends the failure streak; returns the new streak (0). */
  clearCheckFailure(automationId: string): number {
    this.db.prepare(`
      UPDATE automation_check_state
      SET failure_streak = 0, updated_at = ?
      WHERE automation_id = ?
    `).run(Date.now(), automationId);
    return 0;
  }

  /** Record how the run ended (A15 outcome column on `automation_runs`). */
  setRunOutcome(runId: string, outcome: AutomationRunOutcome): void {
    this.db.prepare(`
      UPDATE automation_runs SET outcome = ?, updated_at = ? WHERE id = ?
    `).run(outcome, Date.now(), runId);
  }

  /**
   * Persist the (possibly check-amended) prompt onto the run's config snapshot
   * so a retry, which copies the snapshot, carries the same change note.
   */
  setRunPrompt(runId: string, prompt: string): void {
    this.db.prepare(`
      UPDATE automation_runs
      SET config_snapshot_json = json_set(config_snapshot_json, '$.action.prompt', ?),
          updated_at = ?
      WHERE id = ? AND config_snapshot_json IS NOT NULL
    `).run(prompt, Date.now(), runId);
  }
}

let checkStore: AutomationCheckStore | null = null;

export function getAutomationCheckStore(): AutomationCheckStore {
  if (!checkStore) {
    checkStore = new AutomationCheckStore(getRLMDatabase().getRawDb());
  }
  return checkStore;
}

export function _resetAutomationCheckStoreForTesting(): void {
  checkStore = null;
}
