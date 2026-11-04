import { createHash } from 'node:crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { AutomationRun, AutomationSchedule } from '../../shared/types/automation.types';
import { readRunFacts } from './automation-run-facts';
import type { BoundedAutomationAction } from './automation-run-policy';
import { computeNextFireAt } from './automation-schedule';

export interface AutomationMonitorState {
  unchangedChecks: number;
  intervalMultiplier: number;
  quietRuns: number;
  modelHintDismissed: boolean;
}
interface MonitorRow {
  fingerprint: string | null;
  unchanged_checks: number;
  interval_multiplier: number;
  quiet_runs: number;
  model_hint_dismissed: number;
}
export function readMonitorState(db: SqliteDriver, id: string): AutomationMonitorState {
  const row = db.prepare('SELECT * FROM automation_monitor_state WHERE automation_id = ?').get<MonitorRow>(id);
  return { unchangedChecks: row?.unchanged_checks ?? 0, intervalMultiplier: row?.interval_multiplier ?? 1,
    quietRuns: row?.quiet_runs ?? 0, modelHintDismissed: row?.model_hint_dismissed === 1 };
}
export function dismissMonitorHint(db: SqliteDriver, id: string): void {
  db.prepare(`INSERT INTO automation_monitor_state(automation_id, model_hint_dismissed) VALUES (?, 1)
    ON CONFLICT(automation_id) DO UPDATE SET model_hint_dismissed = 1`).run(id);
}
/** Strip only volatile fields; changes to meaningful counts and status codes stay significant. */
export function normalizedMonitorOutput(text: string): string {
  return text
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g, '<time>')
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{4}\b/g, '<date>')
    .replace(/\b(?:\d{1,2}\s+)?(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+(?:\d{1,2},?\s+)?\d{4}\b/gi, '<date>')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[ap]m)?\b/gi, '<time>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:milliseconds?|seconds?|minutes?|hours?|ms|secs?|mins?|s|m|h)\b/gi, '<duration>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '<id>')
    .replace(/\b((?:request[_ -]?)?id)\s*[:=]\s*[a-z0-9_-]+\b/gi, '$1 <id>')
    .replace(/\b((?:request[_ -]?)?id)\s+[a-z0-9_-]+\b/gi, '$1 <id>')
    .replace(/\s+/g, ' ').trim();
}
export function recordMonitorOutcome(db: SqliteDriver, run: AutomationRun, now: number, fullOutput: string | undefined): void {
  const row = db.prepare('SELECT action_json, schedule_json FROM automations WHERE id = ?').get<{ action_json: string; schedule_json: string }>(run.automationId);
  if (!row) return;
  const previous = db.prepare('SELECT * FROM automation_monitor_state WHERE automation_id = ?').get<MonitorRow>(run.automationId);
  const result = readRunFacts(db, run.id).result;
  const quiet = run.status === 'succeeded' && result?.outcome === 'no_change' && !result.notify;
  const normalized = normalizedMonitorOutput(fullOutput || run.outputSummary || (quiet ? 'no_change' : ''));
  const fingerprint = run.status === 'succeeded' && normalized ? createHash('sha256').update(normalized).digest('hex') : null;
  const unchanged = fingerprint && fingerprint === previous?.fingerprint ? previous.unchanged_checks + 1 : fingerprint ? 1 : 0;
  const action = JSON.parse(row.action_json) as BoundedAutomationAction;
  const multiplier = action.slowWhenUnchanged && run.status === 'succeeded' ? Math.min(4, 2 ** Math.min(2, Math.max(0, unchanged - 1))) : 1;
  db.prepare(`INSERT INTO automation_monitor_state(automation_id, fingerprint, unchanged_checks, interval_multiplier, quiet_runs)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(automation_id) DO UPDATE SET fingerprint = excluded.fingerprint,
      unchanged_checks = excluded.unchanged_checks, interval_multiplier = excluded.interval_multiplier, quiet_runs = excluded.quiet_runs`)
    .run(run.automationId, fingerprint, unchanged, multiplier, quiet ? (previous?.quiet_runs ?? 0) + 1 : 0);
  const schedule = JSON.parse(row.schedule_json) as AutomationSchedule;
  if (action.slowWhenUnchanged && schedule.type === 'cron' && run.status === 'succeeded') {
    let next = computeNextFireAt(schedule, now);
    for (let occurrence = 1; occurrence < multiplier && next !== null; occurrence++) next = computeNextFireAt(schedule, next);
    db.prepare(`UPDATE automations SET next_fire_at = ? WHERE id = ? AND enabled = 1 AND active = 1`)
      .run(next, run.automationId);
  }
}
