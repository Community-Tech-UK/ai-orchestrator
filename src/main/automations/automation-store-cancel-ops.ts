import type { SqliteDriver } from '../db/sqlite-driver';
import type { AutomationRun } from '../../shared/types/automation.types';
import { mapRunRow } from './automation-store-mappers';
import type { AutomationRunRow } from './automation-store-records';

/** Cancel queued runs and release any check capture owned by one of them atomically. */
export function cancelPendingRuns(db: SqliteDriver, automationId: string, now: number): AutomationRun[] {
  const cancel = db.transaction(() => {
    const pending = db.prepare(`
      SELECT * FROM automation_runs
      WHERE automation_id = ? AND status = 'pending'
      ORDER BY scheduled_at ASC
    `).all<AutomationRunRow>(automationId);

    db.prepare(`
      UPDATE automation_check_state
      SET pending_run_id = NULL, pending_hash = NULL, pending_output = NULL, updated_at = ?
      WHERE automation_id = ? AND pending_run_id IN (
        SELECT id FROM automation_runs WHERE automation_id = ? AND status = 'pending'
      )
    `).run(now, automationId, automationId);
    db.prepare(`
      UPDATE automation_runs
      SET status = 'cancelled', finished_at = ?,
          error = 'Pending automation run cancelled', updated_at = ?
      WHERE automation_id = ? AND status = 'pending'
    `).run(now, now, automationId);

    return pending.map((row) => ({
      ...mapRunRow(row),
      status: 'cancelled' as const,
      finishedAt: now,
      error: 'Pending automation run cancelled',
      updatedAt: now,
    }));
  });
  return cancel();
}
