/**
 * Work whose route has no usage left waits; it is never parked and never
 * counted as a round. The scheduler skips it until it may be tried again.
 */
import { getLogger } from '../logging/logger';
import { USAGE_RECHECK_MS, type PlanQueueSpawnOutOfUsage } from './plan-queue-spawn';

const logger = getLogger('PlanQueueUsageWait');

export class PlanQueueUsageWaits {
  /** When each waiting item may be tried again. */
  private readonly until = new Map<string, number>();

  start(itemId: string, error: PlanQueueSpawnOutOfUsage): void {
    this.until.set(itemId, Date.now() + USAGE_RECHECK_MS);
    logger.info('Plan queue: waiting for usage before starting a session', { itemId, reason: error.message });
  }

  isWaiting(itemId: string): boolean {
    const until = this.until.get(itemId);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.until.delete(itemId);
    return false;
  }

  /** James's own action (Pause, Resume) gets a fresh try at once. */
  clear(itemId: string): void {
    this.until.delete(itemId);
  }
}
