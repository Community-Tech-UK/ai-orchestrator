import { getLogger } from '../logging/logger';
import { getJitterScheduler } from '../tasks/jitter-scheduler';
import { registerCleanup } from '../util/cleanup-registry';
import {
  getConversationLedgerService,
  type ConversationLedgerService,
} from './conversation-ledger-service';

const logger = getLogger('ProviderEventCaptureMaintenance');
const DAY_MS = 24 * 60 * 60 * 1000;
export const PROVIDER_EVENT_CAPTURE_RETENTION_DAYS = 30;
const DEFAULT_RETENTION_MS = PROVIDER_EVENT_CAPTURE_RETENTION_DAYS * DAY_MS;
const DEFAULT_INTERVAL_MS = DAY_MS;
const TASK_ID = 'provider-event-capture-maintenance';

export interface ProviderEventCaptureMaintenanceOptions {
  intervalMs?: number;
  retentionMs?: number;
  now?: () => number;
  ledger?: Pick<ConversationLedgerService, 'pruneProviderEventCapturesBefore'>;
}

let scheduled = false;

export function initializeProviderEventCaptureMaintenance(
  options: ProviderEventCaptureMaintenanceOptions = {},
): void {
  if (scheduled) return;
  const intervalMs = resolvePositiveNumber(
    options.intervalMs ?? process.env['AIO_PROVIDER_EVENT_CAPTURE_CLEANUP_INTERVAL_MS'],
    DEFAULT_INTERVAL_MS,
  );
  if (intervalMs <= 0) return;
  getJitterScheduler().schedule({
    id: TASK_ID,
    name: 'Provider event capture maintenance',
    intervalMs,
    jitterPercent: 20,
    maxCatchUp: 1,
    handler: () => {
      void runProviderEventCaptureMaintenance(options).catch((error: unknown) => {
        logger.warn('Provider event capture retention sweep failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
  });
  registerCleanup(stopProviderEventCaptureMaintenance);
  scheduled = true;
}

export function stopProviderEventCaptureMaintenance(): void {
  getJitterScheduler().unschedule(TASK_ID);
  scheduled = false;
}

export async function runProviderEventCaptureMaintenance(
  options: ProviderEventCaptureMaintenanceOptions = {},
): Promise<number> {
  const now = options.now?.() ?? Date.now();
  const retentionMs = resolvePositiveNumber(
    options.retentionMs,
    DEFAULT_RETENTION_MS,
  );
  const removed = await (options.ledger ?? getConversationLedgerService())
    .pruneProviderEventCapturesBefore(now - retentionMs);
  if (removed > 0) {
    logger.info('Pruned expired provider event captures', { removed, retentionMs });
  }
  return removed;
}

function resolvePositiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}
