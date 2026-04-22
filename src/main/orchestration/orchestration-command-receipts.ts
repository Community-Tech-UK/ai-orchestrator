import type { OrchestrationEvent, OrchestrationEventType } from './event-store/orchestration-events';

export type OrchestrationCommandReceiptStatus = 'accepted' | 'rejected';

export interface OrchestrationCommandReceipt {
  commandId: string;
  status: OrchestrationCommandReceiptStatus;
  type: OrchestrationEventType;
  aggregateId: string;
  timestamp: number;
  eventId?: string;
  reason?: string;
  metadata?: OrchestrationEvent['metadata'];
}
