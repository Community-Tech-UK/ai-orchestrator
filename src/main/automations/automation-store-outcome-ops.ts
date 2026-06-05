import type { SqliteDriver } from '../db/sqlite-driver';
import type {
  Automation,
  AutomationRunStatus,
} from '../../shared/types/automation.types';
import type { AutomationRow } from './automation-store-records';

export function recordRunOutcomeRecord(
  deps: {
    db: SqliteDriver;
    getAutomationRow: (automationId: string) => AutomationRow | undefined;
    mapAutomationSync: (row: AutomationRow) => Automation;
  },
  automationId: string,
  status: AutomationRunStatus,
  reason: string | undefined,
  maxConsecutiveFailures: number,
  now: number,
): { automation: Automation | null; autoDisabled: boolean } {
  if (status !== 'succeeded' && status !== 'failed') {
    return { automation: null, autoDisabled: false };
  }

  const tx = deps.db.transaction((): { automation: Automation | null; autoDisabled: boolean } => {
    const row = deps.getAutomationRow(automationId);
    if (!row) {
      return { automation: null, autoDisabled: false };
    }

    if (status === 'succeeded') {
      deps.db.prepare(`
        UPDATE automations
        SET consecutive_failures = 0,
            last_failure_at = NULL,
            last_failure_reason = NULL,
            updated_at = ?
        WHERE id = ?
      `).run(now, automationId);
    } else {
      const nextCount = (row.consecutive_failures ?? 0) + 1;
      const wasEnabled = row.enabled === 1;
      const shouldDisable =
        wasEnabled && maxConsecutiveFailures > 0 && nextCount >= maxConsecutiveFailures;
      deps.db.prepare(`
        UPDATE automations
        SET consecutive_failures = ?,
            last_failure_at = ?,
            last_failure_reason = ?,
            enabled = ?,
            updated_at = ?
        WHERE id = ?
      `).run(nextCount, now, reason ?? null, shouldDisable ? 0 : row.enabled, now, automationId);
      const updated = deps.getAutomationRow(automationId);
      return {
        automation: updated ? deps.mapAutomationSync(updated) : null,
        autoDisabled: shouldDisable,
      };
    }

    const updated = deps.getAutomationRow(automationId);
    return { automation: updated ? deps.mapAutomationSync(updated) : null, autoDisabled: false };
  });
  return tx();
}
