/**
 * Work whose route has no usage left waits; it is never parked and never
 * counted as a round. The scheduler skips it until it may be tried again.
 */
import { getLogger } from '../logging/logger';
import type { PlanQueueItemState } from '@contracts/schemas/plan-queue';
import type { PlanQueueHistoryStore } from './plan-queue-history-store';
import { USAGE_RECHECK_MS, type PlanQueueSpawnOutOfUsage } from './plan-queue-spawn';
import type { PlanQueueItem } from './plan-queue.types';

const logger = getLogger('PlanQueueUsageWait');

/** Which session was waiting to start: a worker or a checker. */
export type UsageWaitKind = 'worker' | 'check';

const USAGE_WAIT_LIMIT_MS = 24 * 60 * 60_000;
const LONGEST_USAGE_WAIT_MS = 60 * 60_000;
/** Longer than any wait, so a bigger gap means the job got through and this is a new limit. */
const SAME_STRETCH_GAP_MS = 3 * LONGEST_USAGE_WAIT_MS;
const USAGE_LIMIT_HOLD = 'worker-usage-limit-hold';

/**
 * How long a session that hit a limit mid-turn waits, or null once this stretch has gone on for a day. A limit the usage
 * data knows about is waited out at the next start; this covers one it doesn't, so each try waits longer, up to an hour.
 */
export function nextUsageWait(holdTimes: readonly number[], now: number): number | null {
  const stretch: number[] = [];
  let later = now;
  for (const at of [...holdTimes].sort((a, b) => b - a)) {
    if (later - at > SAME_STRETCH_GAP_MS) break;
    stretch.push(at);
    later = at;
  }
  if (stretch.length && now - stretch.at(-1)! >= USAGE_WAIT_LIMIT_MS) return null;
  return Math.min(USAGE_RECHECK_MS * 2 ** stretch.length, LONGEST_USAGE_WAIT_MS);
}

/** Records one more wait and says how long, or null when it's time to stop waiting. Kept in history, so it survives a restart. */
export function takeUsageHold(history: Pick<PlanQueueHistoryStore, 'listEvents' | 'recordEvent'>, item: PlanQueueItem, toState: PlanQueueItemState): number | null {
  const holds = history.listEvents(item.id, 500).filter(event => event.reason === USAGE_LIMIT_HOLD).map(event => event.at);
  const waitMs = nextUsageWait(holds, Date.now());
  if (waitMs !== null) history.recordEvent({ itemId: item.id, runId: item.runId, fromState: item.state, toState, reason: USAGE_LIMIT_HOLD, detailHead: null, round: item.round, tokens: 0 });
  return waitMs;
}

export class PlanQueueUsageWaits {
  /** When each waiting item may be tried again, and since when this stretch of waiting began. */
  private readonly until = new Map<string, { retryAt: number; since: number; kind: UsageWaitKind }>();

  /** `onEnded` receives each finished stretch of waiting, so the queue can record how long usage held the item up. */
  constructor(private readonly onEnded: (itemId: string, kind: UsageWaitKind, waitedMs: number) => void = () => undefined) {}

  start(itemId: string, error: PlanQueueSpawnOutOfUsage, kind: UsageWaitKind, waitMs = USAGE_RECHECK_MS): void {
    this.finish(itemId, Date.now());
    const now = Date.now();
    this.until.set(itemId, { retryAt: now + waitMs, since: now, kind });
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
