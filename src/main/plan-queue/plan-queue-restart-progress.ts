import type { PlanQueueFlowHost } from './plan-queue-host';
import { documentContentSha256, progressFingerprint } from './plan-queue-progress';
import type { PlanQueueItem } from './plan-queue.types';

/** Durable restart attempts, keyed by the same work/document/round fingerprint as verification. */
export async function recordQueueRestart(host: PlanQueueFlowHost, item: PlanQueueItem): Promise<number> {
  const fingerprint = JSON.stringify(progressFingerprint(item.checkpointCommit ?? item.baseCommit, await documentContentSha256(item.documentPath), item.round));
  let count = 1;
  for (const event of host.history.listEvents(item.id, 100)) {
    if (event.round !== item.round) break;
    if (event.reason !== 'restart-resume') continue;
    if (event.detailHead !== fingerprint) break;
    count++;
  }
  host.history.recordEvent({ itemId: item.id, runId: item.runId, fromState: item.state, toState: item.state,
    reason: 'restart-resume', detailHead: fingerprint, round: item.round, tokens: 0 });
  return count;
}
