import type { AutomationConfigSnapshot, AutomationRun } from '../../shared/types/automation.types';
import type { SqliteDriver } from '../db/sqlite-driver';

/** Storage-only run timing, beside the saved configuration in its JSON envelope.
 * No change to the job action or original startedAt is needed. New attempts
 * construct a fresh configuration snapshot, so they get a fresh clock. */
type TimedSnapshot = AutomationConfigSnapshot & { runClock?: { pausedAt: number | null; pausedMs: number } };

export function automationRunDeadline(run: AutomationRun, minutes: number, now: number): number {
  const clock = (run.configSnapshot as TimedSnapshot | null)?.runClock;
  return (run.startedAt ?? now) + minutes * 60_000 + (clock?.pausedMs ?? 0)
    + (clock?.pausedAt == null ? 0 : Math.max(0, now - clock.pausedAt));
}

export function setAutomationRunPaused(db: SqliteDriver, runId: string, paused: boolean, now: number): void {
  // Conditional SQL makes repeated pause/resume notifications idempotent and
  // keeps the clock durable through a process restart. JSON paths leave the
  // saved action, result, and concurrent billing updates untouched.
  if (paused) {
    db.prepare(`UPDATE automation_runs SET config_snapshot_json = json_set(config_snapshot_json,
      '$.runClock.pausedAt', ?, '$.runClock.pausedMs', COALESCE(json_extract(config_snapshot_json, '$.runClock.pausedMs'), 0))
      WHERE id = ? AND status = 'running' AND config_snapshot_json IS NOT NULL
      AND json_extract(config_snapshot_json, '$.runClock.pausedAt') IS NULL`).run(now, runId);
  } else {
    db.prepare(`UPDATE automation_runs SET config_snapshot_json = json_set(config_snapshot_json,
      '$.runClock.pausedMs', COALESCE(json_extract(config_snapshot_json, '$.runClock.pausedMs'), 0)
        + MAX(0, ? - json_extract(config_snapshot_json, '$.runClock.pausedAt')), '$.runClock.pausedAt', NULL)
      WHERE id = ? AND status = 'running' AND json_extract(config_snapshot_json, '$.runClock.pausedAt') IS NOT NULL`).run(now, runId);
  }
}
