/** Checks that ran out of time. A timeout judges no code, so it uses no round and goes to no worker. */
import type { PlanQueueGateReceipt } from './plan-queue-gate-receipts';
import type { PlanQueueFlowHost } from './plan-queue-host';
import type { PlanQueueItem } from './plan-queue.types';

export const CHECK_TIMEOUT_REASON = 'check-timeout';
const MERGE_CHECK_TIMEOUT_REASON = 'merge-check-timeout';
export const CHECK_HUNG_DETAIL = 'The checks ran out of time twice in a row on the same work, so one may hang. Press Resume to send it back to a worker and check it again.';

/** The check after merging didn't finish. The commit it was checking stays unproved until a later run passes. */
export function recordMergeCheckTimeout(host: Pick<PlanQueueFlowHost, 'history'>, item: PlanQueueItem): void {
  host.history.recordEvent({ itemId: item.id, runId: item.runId, fromState: item.state, toState: item.state,
    reason: MERGE_CHECK_TIMEOUT_REASON, detailHead: item.checkpointCommit, round: item.round, tokens: 0 });
}

/** True when the last attempt merged this exact commit but its check never finished. */
export function mergeCheckStillOwed(host: Pick<PlanQueueFlowHost, 'history'>, item: PlanQueueItem): boolean {
  return host.history.listEvents(item.id).find(event => event.reason === MERGE_CHECK_TIMEOUT_REASON)?.detailHead === item.checkpointCommit;
}

/** The run's last progress line, which says how far it got and on how many test workers. */
function lastProgress(tail: string): string | undefined {
  return tail.split('\n').map(line => line.trim()).filter(line => line.startsWith('…')).at(-1);
}

/** Records one, and returns how many in a row this job has had since a worker last changed it. */
export function recordCheckTimeout(host: Pick<PlanQueueFlowHost, 'history'>, item: PlanQueueItem, receipts: readonly PlanQueueGateReceipt[]): number {
  const timedOut = receipts.find(receipt => receipt.timedOut);
  host.history.recordEvent({ itemId: item.id, runId: item.runId, fromState: item.state, toState: item.state, reason: CHECK_TIMEOUT_REASON,
    detailHead: JSON.stringify({ command: timedOut?.command, durationMs: timedOut?.durationMs, progress: lastProgress(timedOut?.tail ?? '') }),
    round: item.round, tokens: 0 });
  const newestFirst = host.history.listEvents(item.id);
  const workerRan = newestFirst.findIndex(event => event.fromState !== event.toState && (event.toState === 'working' || event.toState === 'fixing'));
  return (workerRan < 0 ? newestFirst : newestFirst.slice(0, workerRan)).filter(event => event.reason === CHECK_TIMEOUT_REASON).length;
}
