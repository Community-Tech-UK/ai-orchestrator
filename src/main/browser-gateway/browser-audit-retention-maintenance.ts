import { getLogger } from '../logging/logger';
import { getJitterScheduler } from '../tasks/jitter-scheduler';
import { registerCleanup } from '../util/cleanup-registry';
import { getBrowserAuditStore, type BrowserAuditStore } from './browser-audit-store';

const logger = getLogger('BrowserAuditRetentionMaintenance');
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * LT-217: browser_audit_entries grew to 3.4M rows / 1.36GB, 99.7% internal
 * bookkeeping. Part 1 (recordAudit: false on the two bookkeeping write paths)
 * stops the bleeding going forward; this is part 2 — bound the retained
 * history of the low-value `actionClass: 'read'` rows that remain (list/get
 * calls), independent of the writer-side fix, mirroring
 * provider-event-capture-maintenance.ts's pattern for a different table.
 */
export const BROWSER_AUDIT_READ_RETENTION_DAYS = 90;
const DEFAULT_RETENTION_MS = BROWSER_AUDIT_READ_RETENTION_DAYS * DAY_MS;
const DEFAULT_INTERVAL_MS = DAY_MS;
const TASK_ID = 'browser-audit-retention-maintenance';

export interface BrowserAuditRetentionMaintenanceOptions {
  intervalMs?: number;
  retentionMs?: number;
  now?: () => number;
  auditStore?: Pick<BrowserAuditStore, 'pruneReadEntriesBefore'>;
}

let scheduled = false;

export function initializeBrowserAuditRetentionMaintenance(
  options: BrowserAuditRetentionMaintenanceOptions = {},
): void {
  if (scheduled) return;
  const intervalMs = resolvePositiveNumber(
    options.intervalMs ?? process.env['AIO_BROWSER_AUDIT_RETENTION_INTERVAL_MS'],
    DEFAULT_INTERVAL_MS,
  );
  if (intervalMs <= 0) return;
  getJitterScheduler().schedule({
    id: TASK_ID,
    name: 'Browser audit retention maintenance',
    intervalMs,
    jitterPercent: 20,
    maxCatchUp: 1,
    handler: () => {
      try {
        runBrowserAuditRetentionMaintenance(options);
      } catch (error) {
        logger.warn('Browser audit read-entry retention sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  });
  registerCleanup(stopBrowserAuditRetentionMaintenance);
  scheduled = true;
}

export function stopBrowserAuditRetentionMaintenance(): void {
  getJitterScheduler().unschedule(TASK_ID);
  scheduled = false;
}

export function runBrowserAuditRetentionMaintenance(
  options: BrowserAuditRetentionMaintenanceOptions = {},
): number {
  const now = options.now?.() ?? Date.now();
  const retentionMs = resolvePositiveNumber(options.retentionMs, DEFAULT_RETENTION_MS);
  const removed = (options.auditStore ?? getBrowserAuditStore())
    .pruneReadEntriesBefore(now - retentionMs);
  if (removed > 0) {
    logger.info('Pruned expired browser_audit_entries read rows', { removed, retentionMs });
  }
  return removed;
}

function resolvePositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
