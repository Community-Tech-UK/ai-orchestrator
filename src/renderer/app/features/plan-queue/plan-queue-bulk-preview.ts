import type { PlanQueueItemDto, PlanQueueParkReason } from '@contracts/schemas/plan-queue';
import { planQueueIsDiscarded } from '../../../../shared/utils/plan-queue-discarded';

export interface PlanQueueBulkPreview {
  willChange: PlanQueueItemDto[];
  leftAlone: { item: PlanQueueItemDto; reason: string }[];
  notApplicable: { item: PlanQueueItemDto; reason: string }[];
}

/** Only the newest retained attempt can be resumed; another live owner wins. */
export function planQueueBulkResumePreview(items: readonly PlanQueueItemDto[], reason: PlanQueueParkReason,
  busyDocuments: readonly string[]): PlanQueueBulkPreview {
  const newest = new Map<string, string>();
  for (const item of [...items].sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))) {
    if (!newest.has(item.documentPath)) newest.set(item.documentPath, item.id);
  }
  const busy = new Set(busyDocuments);
  const preview: PlanQueueBulkPreview = { willChange: [], leftAlone: [], notApplicable: [] };
  for (const item of items) {
    if (item.state !== 'parked' || item.parkReason !== reason) {
      preview.notApplicable.push({ item, reason: 'set aside for another reason, or no longer set aside' });
    } else {
      const why = planQueueIsDiscarded(item) ? 'its work was explicitly discarded'
        : busy.has(item.documentPath) ? 'another attempt is already active'
        : newest.get(item.documentPath) !== item.id ? 'a newer attempt exists' : null;
      if (why) preview.leftAlone.push({ item, reason: why });
      else preview.willChange.push(item);
    }
  }
  return preview;
}
