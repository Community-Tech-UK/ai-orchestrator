import { isDeepStrictEqual } from 'node:util';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { Automation, AutomationRun } from '../../shared/types/automation.types';
import type { AutomationRow, AutomationRunRow } from './automation-store-records';
import { stripAttachmentData } from './automation-store-mappers';
import { readRunFacts } from './automation-run-facts';

export const RESTART_INTERRUPTION = 'Interrupted by an app restart';
export const RESTART_CONTINUATION = 'The previous run was cut off by a restart; check what it already did before continuing.';

export function unchangedRestartJob(automation: Automation, run: AutomationRun): boolean {
  const snapshot = run.configSnapshot;
  return Boolean(automation.enabled && automation.active && snapshot
    && !snapshot.action.systemAction && !snapshot.action.loop && snapshot.destination.kind === 'newInstance'
    && automation.destination.kind === 'newInstance'
    && isDeepStrictEqual(stripAttachmentData(automation.action), stripAttachmentData(snapshot.action))
    && isDeepStrictEqual(automation.schedule, snapshot.schedule)
    && isDeepStrictEqual(automation.trigger, snapshot.trigger));
}

/** Interruption evidence and the one-use retry marker commit together. No failure-streak update. */
export function interruptRunningJobs(deps: {
  db: SqliteDriver;
  mapRun: (row: AutomationRunRow) => AutomationRun;
  mapAutomation: (row: AutomationRow) => Automation;
}, reason: string, now: number, exclude: readonly string[], retry: boolean): AutomationRun[] {
  const { db } = deps;
  return db.transaction(() => {
    const rows = db.prepare(`SELECT r.*, f.result_json, f.processed_tokens FROM automation_runs r LEFT JOIN automation_run_facts f ON f.run_id = r.id WHERE status = 'running' AND loop_run_id IS NULL
      ${exclude.length ? `AND id NOT IN (${exclude.map(() => '?').join(',')})` : ''}`).all<AutomationRunRow>(...exclude);
    return rows.map(row => {
      const run = deps.mapRun(row);
      const current = db.prepare('SELECT * FROM automations WHERE id = ?').get<AutomationRow>(row.automation_id);
      const facts = readRunFacts(db, run.id);
      const eligible = retry && current && unchangedRestartJob(deps.mapAutomation(current), run)
        && !facts.restartRetryUsed && facts.deliveryStartedAt === null && facts.result === null;
      const retryAt = now + 15_000;
      db.prepare(`UPDATE automation_runs SET status = 'failed', finished_at = ?, error = ?,
        next_retry_at = ?, next_retry_attempt = ?, next_retry_max_attempts = ?, updated_at = ? WHERE id = ?`)
        .run(now, reason, eligible ? retryAt : null, eligible ? run.attempt + 1 : null,
          eligible ? run.attempt + 1 : null, now, run.id);
      if (eligible) db.prepare(`INSERT INTO automation_run_facts(run_id, restart_retry_used) VALUES (?, 1)
        ON CONFLICT(run_id) DO UPDATE SET restart_retry_used = 1`).run(run.id);
      if (current?.schedule_type === 'oneTime') db.prepare('UPDATE automations SET next_fire_at = ?, updated_at = ? WHERE id = ?')
        .run(eligible ? retryAt : null, now, run.automationId);
      return { ...run, status: 'failed' as const, finishedAt: now, error: reason, updatedAt: now, nextRetryAt: eligible ? retryAt : null };
    });
  })();
}
