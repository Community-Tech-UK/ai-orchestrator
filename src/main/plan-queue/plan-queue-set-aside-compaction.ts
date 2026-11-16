/**
 * Shrink a queue worker's conversation before its job is set aside (Oct-2 T13.1).
 *
 * A set-aside job waits for a person or a repair, so nobody knows when its worker will be
 * reopened, but it is always longer than Claude's prompt cache lasts. If the worker is still
 * open, idle and holds 200K or more, compacting now (while its cache is warm) saves the whole
 * conversation being rewritten when Resume reopens it. The general pre-sleep service
 * (`context/pre-sleep-context.ts`) owns the size, cache-lifetime and pending-work rules.
 *
 * Only stops that a finished round led to are handled: the worker is idle and nobody is
 * waiting for the stop to complete. A cancel, a provider limit (the account cannot answer a
 * compaction) or a failure is never delayed by one.
 */

import type { PlanQueueParkReason } from '@contracts/schemas/plan-queue';
import { getPreSleepContext } from '../context/pre-sleep-context';
import { getLogger } from '../logging/logger';

const logger = getLogger('PlanQueueSetAsideCompaction');

const AFTER_A_FINISHED_ROUND: ReadonlySet<PlanQueueParkReason> = new Set<PlanQueueParkReason>([
  'round-limit',
  'stuck-on-same-finding',
  'verifier-unreliable',
  'no-diverse-verifier',
  'needs-setup',
  'needs-james',
]);

/** No wake-up time exists; a day is far past any cache lifetime, which is what the decision compares against. */
export const SET_ASIDE_ASSUMED_SLEEP_MS = 24 * 60 * 60_000;

export function parkReasonLeavesIdleWorker(reason: PlanQueueParkReason): boolean {
  return AFTER_A_FINISHED_ROUND.has(reason);
}

export interface SetAsideCompactionDeps {
  /** Stop the queue reacting to this worker's turns: a compaction is not a worker turn. */
  untrack(instanceId: string): void;
  now?(): number;
}

/** Compact the worker if that is worthwhile. Never throws: the job is being set aside either way. */
export async function compactWorkerBeforeSetAside(
  instanceId: string | null,
  reason: PlanQueueParkReason,
  deps: SetAsideCompactionDeps,
): Promise<void> {
  const service = getPreSleepContext();
  if (!instanceId || !service || !parkReasonLeavesIdleWorker(reason)) return;
  const claimKey = `set-aside:${instanceId}`;
  try {
    deps.untrack(instanceId);
    const outcome = await service.note({
      instanceId,
      wakeAt: (deps.now?.() ?? Date.now()) + SET_ASIDE_ASSUMED_SLEEP_MS,
      source: 'set-aside',
      claimKey,
    });
    if (outcome.kind === 'failed') {
      logger.warn('Could not compact a worker before its job was set aside', { instanceId, reason: outcome.reason });
    }
  } catch (error) {
    logger.warn('Could not compact a worker before its job was set aside', {
      instanceId,
      reason: error instanceof Error ? error.message : String(error),
    });
  } finally {
    // A busy worker would otherwise keep a deferred request and compact after it is closed.
    service.revokeClaim(claimKey);
  }
}
