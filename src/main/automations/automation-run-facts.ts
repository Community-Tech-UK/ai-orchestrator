import type { SqliteDriver } from '../db/sqlite-driver';
import { AutomationResultSchema, type AutomationResult } from '@contracts/schemas/automation';

export interface AutomationRunFacts {
  result: AutomationResult | null;
  deliveryStartedAt: number | null;
  restartRetryUsed: boolean;
  restartSourceRunId: string | null;
}
export function readRunFacts(db: SqliteDriver, runId: string): AutomationRunFacts {
  const row = db.prepare('SELECT * FROM automation_run_facts WHERE run_id = ?').get<{
    result_json: string | null; delivery_started_at: number | null; restart_retry_used: number; restart_source_run_id: string | null;
  }>(runId);
  return { result: row?.result_json ? AutomationResultSchema.parse(JSON.parse(row.result_json)) : null,
    deliveryStartedAt: row?.delivery_started_at ?? null, restartRetryUsed: row?.restart_retry_used === 1,
    restartSourceRunId: row?.restart_source_run_id ?? null };
}
export function writeRunResult(db: SqliteDriver, runId: string, result: AutomationResult): void {
  const parsed = AutomationResultSchema.parse(result);
  const run = db.prepare('SELECT status FROM automation_runs WHERE id = ?').get<{ status: string }>(runId);
  if (run?.status !== 'running') throw new Error('Only an active scheduled run can report a result');
  db.prepare(`INSERT INTO automation_run_facts(run_id, result_json) VALUES (?, ?)
    ON CONFLICT(run_id) DO UPDATE SET result_json = excluded.result_json`).run(runId, JSON.stringify(parsed));
}
export function markDeliveryStarted(db: SqliteDriver, runId: string, now: number): boolean {
  db.prepare('INSERT OR IGNORE INTO automation_run_facts(run_id) VALUES (?)').run(runId);
  return db.prepare(`UPDATE automation_run_facts SET delivery_started_at = ?
    WHERE run_id = ? AND delivery_started_at IS NULL`).run(now, runId).changes === 1;
}

export function recordStopFailure(db: SqliteDriver, runId: string): void {
  const detail = 'Could not stop every session. Open the job session and stop it before running this job again.';
  db.prepare(`UPDATE automation_runs SET error = error || '. ' || ? WHERE id = ? AND status = 'failed' AND instr(error, ?) = 0`).run(detail, runId, detail);
}

/** Persist both observations, counting their maximum once rather than charging the same turn twice. */
export function addProcessedUsage(db: SqliteDriver, runId: string, instanceId: string, source: 'provider' | 'attributed', tokens: number): number {
  if (!Number.isFinite(tokens) || tokens < 0) throw new Error('Processed usage must be a non-negative finite number');
  return db.transaction(() => {
    const column = source === 'provider' ? 'provider_tokens' : 'attributed_tokens';
    db.prepare(`INSERT INTO automation_run_usage(run_id, instance_id, ${column}) VALUES (?, ?, ?)
      ON CONFLICT(run_id, instance_id) DO UPDATE SET ${column} = ${column} + excluded.${column}`).run(runId, instanceId, tokens);
    const total = db.prepare(`SELECT COALESCE(SUM(MAX(provider_tokens, attributed_tokens)), 0) AS tokens FROM automation_run_usage WHERE run_id = ?`).get<{ tokens: number }>(runId)!.tokens;
    db.prepare(`INSERT INTO automation_run_facts(run_id, processed_tokens) VALUES (?, ?)
      ON CONFLICT(run_id) DO UPDATE SET processed_tokens = excluded.processed_tokens`).run(runId, total);
    return total;
  })();
}
