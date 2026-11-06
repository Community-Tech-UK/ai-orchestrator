import type { SqliteDriver } from '../db/sqlite-driver';

/** Preserve delivery evidence only for the exact run and attached thread target. */
export function markThreadPromptAttemptRecord(
  db: SqliteDriver, runId: string, instanceId: string, notDelivered: boolean, now: number,
): boolean {
  const result = db.prepare(`
    UPDATE automation_runs
    SET thread_prompt_delivered = ?, updated_at = ?
    WHERE id = ? AND instance_id = ?
      AND (thread_prompt_delivered IS NULL OR thread_prompt_delivered = 0)
      AND json_extract(config_snapshot_json, '$.destination.kind') = 'thread'
  `).run(notDelivered ? 0 : null, now, runId, instanceId);
  return result.changes > 0;
}

/** A confirmed delivery remains confirmed across later attempts. */
export function markThreadPromptDeliveredRecord(
  db: SqliteDriver, runId: string, instanceId: string, now: number,
): boolean {
  const result = db.prepare(`
    UPDATE automation_runs
    SET thread_prompt_delivered = 1, updated_at = ?
    WHERE id = ? AND instance_id = ?
      AND json_extract(config_snapshot_json, '$.destination.kind') = 'thread'
  `).run(now, runId, instanceId);
  return result.changes > 0;
}
