import type { OrchestrationEvent, OrchestrationEventType } from './event-store/orchestration-events';
import type { OrchestrationCommandType } from './orchestration-commands';

export type OrchestrationCommandReceiptStatus = 'accepted' | 'rejected';

export interface OrchestrationCommandReceipt {
  commandId: string;
  status: OrchestrationCommandReceiptStatus;
  commandType: OrchestrationCommandType;
  eventType?: OrchestrationEventType;
  aggregateId: string;
  timestamp: number;
  eventId?: string;
  reason?: string;
  metadata?: OrchestrationEvent['metadata'];
}
