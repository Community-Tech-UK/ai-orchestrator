import type { PlanQueueItemDto, PlanQueueParkReason } from '@contracts/schemas/plan-queue';
import { planQueueIsDiscarded } from '../../../../shared/utils/plan-queue-discarded';

export interface PlanQueueBulkPreview {
  willChange: PlanQueueItemDto[];
  leftAlone: { item: PlanQueueItemDto; reason: string }[];
  notApplicable: { item: PlanQueueItemDto; reason: string }[];
}

/** Oldest first, because later branches often build on earlier ones. A retry keeps each job's passed check. */
export function planQueueBulkRetryPreview(items: readonly PlanQueueItemDto[], busyDocuments: readonly string[],
  pausedRuns: ReadonlySet<string>): PlanQueueBulkPreview {
  const busy = new Set(busyDocuments);
  const preview: PlanQueueBulkPreview = { willChange: [], leftAlone: [], notApplicable: [] };
  for (const item of [...items].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    const why = busy.has(item.sourceRef) ? 'another attempt is already active' : pausedRuns.has(item.runId) ? 'its run is paused' : null;
    if (why) preview.leftAlone.push({ item, reason: why });
    else preview.willChange.push(item);
  }
  return preview;
}

/**
 * Only the newest retained attempt can be resumed; another live owner wins. `newestMerged` holds when each document's
 * newest merged attempt was created, because resuming an older attempt redoes finished work. Resume also wipes a passed check.
 */
export function planQueueBulkResumePreview(items: readonly PlanQueueItemDto[], reason: PlanQueueParkReason,
  busyDocuments: readonly string[], newestMerged: ReadonlyMap<string, number>): PlanQueueBulkPreview {
  const newest = new Map<string, string>();
  for (const item of [...items].sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))) {
    if (!newest.has(item.sourceRef)) newest.set(item.sourceRef, item.id);
  }
  const busy = new Set(busyDocuments);
  const preview: PlanQueueBulkPreview = { willChange: [], leftAlone: [], notApplicable: [] };
  for (const item of items) {
    if (item.state !== 'parked' || item.parkReason !== reason) {
      preview.notApplicable.push({ item, reason: 'set aside for another reason, or no longer set aside' });
    } else {
      const why = planQueueIsDiscarded(item) ? 'its work was explicitly discarded'
        : busy.has(item.sourceRef) ? 'another attempt is already active'
        : (newestMerged.get(item.sourceRef) ?? 0) > item.createdAt ? 'a newer attempt already merged'
        : newest.get(item.sourceRef) !== item.id ? 'a newer attempt exists'
        : item.verdict?.verdict === 'PASS' ? 'it passed its checks, and Resume would clear that' : null;
      if (why) preview.leftAlone.push({ item, reason: why });
      else preview.willChange.push(item);
    }
  }
  return preview;
}
