import { getLogger } from '../logging/logger';
import { getJitterScheduler } from '../tasks/jitter-scheduler';
import { registerCleanup } from '../util/cleanup-registry';
import { getDocReviewService } from './doc-review-service';

const logger = getLogger('DocReviewCompletedSweep');

const TASK_ID = 'doc-review-completed-sweep';
const INTERVAL_MS = 10 * 60 * 1000;

let scheduled = false;

async function sweep(): Promise<void> {
  try {
    await getDocReviewService().closeReviewsForCompletedSources();
  } catch (error) {
    logger.warn('Could not close reviews for completed documents', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Plans are completed by queue workers, loops and ordinary sessions alike, so
 * rather than hook each of them this checks pending reviews at startup and
 * then every ten minutes.
 */
export function initializeCompletedReviewSweep(): void {
  if (scheduled) return;
  scheduled = true;
  void sweep();
  getJitterScheduler().schedule({
    id: TASK_ID,
    name: 'Close reviews for completed documents',
    intervalMs: INTERVAL_MS,
    jitterPercent: 20,
    maxCatchUp: 1,
    handler: sweep,
  });
  registerCleanup(stopCompletedReviewSweep);
}

export function stopCompletedReviewSweep(): void {
  getJitterScheduler().unschedule(TASK_ID);
  scheduled = false;
}
