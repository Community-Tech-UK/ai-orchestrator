/**
 * Work whose route has no usage left waits; it is never parked and never
 * counted as a round. The scheduler skips it until it may be tried again.
 */
import { getLogger } from '../logging/logger';
import { USAGE_RECHECK_MS, type PlanQueueSpawnOutOfUsage } from './plan-queue-spawn';

const logger = getLogger('PlanQueueUsageWait');

/** Which session was waiting to start: a worker or a checker. */
export type UsageWaitKind = 'worker' | 'check';

export class PlanQueueUsageWaits {
  /** When each waiting item may be tried again, and since when this stretch of waiting began. */
  private readonly until = new Map<string, { retryAt: number; since: number; kind: UsageWaitKind }>();

  /** `onEnded` receives each finished stretch of waiting, so the queue can record how long usage held the item up. */
  constructor(private readonly onEnded: (itemId: string, kind: UsageWaitKind, waitedMs: number) => void = () => undefined) {}

  start(itemId: string, error: PlanQueueSpawnOutOfUsage, kind: UsageWaitKind): void {
    this.finish(itemId, Date.now());
    const now = Date.now();
    this.until.set(itemId, { retryAt: now + USAGE_RECHECK_MS, since: now, kind });
    logger.info('Plan queue: waiting for usage before starting a session', { itemId, reason: error.message });
  }

  isWaiting(itemId: string): boolean {
    const wait = this.until.get(itemId);
    if (wait === undefined) return false;
    if (wait.retryAt > Date.now()) return true;
    this.finish(itemId, wait.retryAt);
    return false;
  }

  /** James's own action (Pause, Resume) gets a fresh try at once. */
  clear(itemId: string): void {
    this.finish(itemId, Date.now());
  }

  /** End this item's stretch of waiting at `endedAt` and report it. */
  private finish(itemId: string, endedAt: number): void {
    const wait = this.until.get(itemId);
    if (!wait) return;
    this.until.delete(itemId);
    this.onEnded(itemId, wait.kind, Math.max(0, endedAt - wait.since));
  }
}
