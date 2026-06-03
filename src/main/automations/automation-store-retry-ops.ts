import type { SqliteDriver } from '../db/sqlite-driver';
import type {
  Automation,
  AutomationRun,
  AutomationRunStatus,
  AutomationTrigger,
} from '../../shared/types/automation.types';
import type {
  AutomationRow,
  AutomationRunRow,
  RunInsertExtras,
} from './automation-store-records';

/** Shape returned by listPendingRetries — just enough for the scheduler to re-arm timers. */
export interface PendingRetryRecord {
  runId: string;
  automationId: string;
  nextRetryAt: number;
  nextRetryAttempt: number;
  nextRetryMaxAttempts: number;
}

interface RetryRunInsertDeps {
  db: SqliteDriver;
  getAutomationRow: (automationId: string) => AutomationRow | undefined;
  mapAutomationSync: (row: AutomationRow) => Automation;
  insertRun: (
    automation: Automation,
    status: AutomationRunStatus,
    trigger: AutomationTrigger,
    scheduledAt: number,
    now: number,
    extras?: RunInsertExtras,
  ) => AutomationRun;
}

interface SkippedRunDeps {
  db: SqliteDriver;
  isScheduleTrigger: (trigger: AutomationTrigger) => boolean;
  findDedupeRun: (automationId: string, scheduledAt: number) => AutomationRunRow | undefined;
  advanceScheduleBaselineIfNeeded: (
    automationId: string,
    runId: string | null | undefined,
    trigger: AutomationTrigger,
    fireTime: number,
  ) => void;
  insertRun: (
    automation: Automation,
    status: AutomationRunStatus,
    trigger: AutomationTrigger,
    scheduledAt: number,
    now: number,
    extras?: RunInsertExtras,
  ) => AutomationRun;
  mapRun: (row: AutomationRunRow) => AutomationRun;
}

export function insertRetryRun(
  deps: RetryRunInsertDeps,
  originalRun: AutomationRun,
  nextAttempt: number,
  maxAttempts: number,
  retryAt: number,
  now = Date.now(),
): AutomationRun | null {
  const tx = deps.db.transaction((): AutomationRun | null => {
    const automationRow = deps.getAutomationRow(originalRun.automationId);
    if (!automationRow) {
      return null;
    }
    const automation = deps.mapAutomationSync(automationRow);
    // Preserve the original action/snapshot: use attachments from the original
    // snapshot if available, otherwise fall through to the live automation.
    if (originalRun.configSnapshot) {
      automation.name = originalRun.configSnapshot.name;
      automation.schedule = originalRun.configSnapshot.schedule;
      automation.missedRunPolicy = originalRun.configSnapshot.missedRunPolicy;
      automation.concurrencyPolicy = originalRun.configSnapshot.concurrencyPolicy;
      automation.destination = originalRun.configSnapshot.destination;
      automation.action = originalRun.configSnapshot.action;
    }

    return deps.insertRun(
      automation,
      'running',
      originalRun.trigger,
      retryAt,
      now,
      {
        startedAt: now,
        triggerSource: originalRun.triggerSource ?? undefined,
        deliveryMode: originalRun.deliveryMode,
        attempt: nextAttempt,
        maxAttempts,
      },
    );
  });
  return tx();
}

export function markPendingRetry(
  db: SqliteDriver,
  runId: string,
  nextRetryAt: number,
  nextAttempt: number,
  maxAttempts: number,
): void {
  db.prepare(`
    UPDATE automation_runs
    SET next_retry_at = ?,
        next_retry_attempt = ?,
        next_retry_max_attempts = ?,
        updated_at = ?
    WHERE id = ?
  `).run(nextRetryAt, nextAttempt, maxAttempts, Date.now(), runId);
}

export function clearPendingRetry(db: SqliteDriver, runId: string): void {
  db.prepare(`
    UPDATE automation_runs
    SET next_retry_at = NULL,
        next_retry_attempt = NULL,
        next_retry_max_attempts = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(Date.now(), runId);
}

export function listPendingRetries(db: SqliteDriver): PendingRetryRecord[] {
  const rows = db.prepare(`
    SELECT
      r.id            AS run_id,
      r.automation_id,
      r.next_retry_at,
      r.next_retry_attempt,
      r.next_retry_max_attempts
    FROM automation_runs r
    WHERE r.next_retry_at IS NOT NULL
      AND r.next_retry_attempt IS NOT NULL
      AND r.next_retry_max_attempts IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM automation_runs successor
        WHERE successor.automation_id = r.automation_id
          AND successor.attempt = r.next_retry_attempt
          AND successor.scheduled_at >= r.next_retry_at - 1
      )
  `).all<{
    run_id: string;
    automation_id: string;
    next_retry_at: number;
    next_retry_attempt: number;
    next_retry_max_attempts: number;
  }>();

  return rows.map((row) => ({
    runId: row.run_id,
    automationId: row.automation_id,
    nextRetryAt: row.next_retry_at,
    nextRetryAttempt: row.next_retry_attempt,
    nextRetryMaxAttempts: row.next_retry_max_attempts,
  }));
}

export function insertPendingRetryRun(
  deps: RetryRunInsertDeps,
  originalRun: AutomationRun,
  nextAttempt: number,
  maxAttempts: number,
  retryAt: number,
  now = Date.now(),
): AutomationRun | null {
  const tx = deps.db.transaction((): AutomationRun | null => {
    const automationRow = deps.getAutomationRow(originalRun.automationId);
    if (!automationRow) {
      return null;
    }
    const automation = deps.mapAutomationSync(automationRow);
    if (originalRun.configSnapshot) {
      automation.name = originalRun.configSnapshot.name;
      automation.schedule = originalRun.configSnapshot.schedule;
      automation.missedRunPolicy = originalRun.configSnapshot.missedRunPolicy;
      automation.concurrencyPolicy = originalRun.configSnapshot.concurrencyPolicy;
      automation.destination = originalRun.configSnapshot.destination;
      automation.action = originalRun.configSnapshot.action;
    }

    return deps.insertRun(
      automation,
      'pending',
      originalRun.trigger,
      retryAt,
      now,
      {
        triggerSource: originalRun.triggerSource ?? undefined,
        deliveryMode: originalRun.deliveryMode,
        attempt: nextAttempt,
        maxAttempts,
      },
    );
  });
  return tx();
}

export function recordSkippedRun(
  deps: SkippedRunDeps,
  automation: Automation,
  trigger: AutomationTrigger,
  fireTime: number,
  reason: string,
  now = Date.now(),
): AutomationRun {
  const tx = deps.db.transaction(() => {
    if (deps.isScheduleTrigger(trigger) && deps.findDedupeRun(automation.id, fireTime)) {
      deps.advanceScheduleBaselineIfNeeded(automation.id, automation.lastRunId, trigger, fireTime);
      const existing = deps.findDedupeRun(automation.id, fireTime);
      if (existing) {
        return deps.mapRun(existing);
      }
    }
    const run = deps.insertRun(automation, 'skipped', trigger, fireTime, now, {
      finishedAt: now,
      error: reason,
    });
    deps.advanceScheduleBaselineIfNeeded(automation.id, run.id, trigger, fireTime);
    return run;
  });
  return tx();
}
