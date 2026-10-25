import type { SqliteDriver } from '../db/sqlite-driver';
import type { AutomationRun } from '../../shared/types/automation.types';
import type { AutomationRunRow } from './automation-store-records';
import { mapRunRow } from './automation-store-mappers';

export function listActiveAutomationRuns(db: SqliteDriver): AutomationRun[] {
  return db.prepare(`
    SELECT * FROM automation_runs WHERE status IN ('pending', 'running')
    ORDER BY scheduled_at ASC, created_at ASC
  `).all<AutomationRunRow>().map(mapRunRow);
}
