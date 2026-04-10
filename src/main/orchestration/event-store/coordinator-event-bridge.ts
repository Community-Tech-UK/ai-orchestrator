/**
 * Coordinator Event Bridge
 *
 * Wires MultiVerifyCoordinator and DebateCoordinator EventEmitter events
 * into the OrchestrationEventStore for audit trail and replay.
 */

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { getLogger } from '../../logging/logger';
import type { OrchestrationEventStore } from './orchestration-event-store';
import type { OrchestrationEventType } from './orchestration-events';

const logger = getLogger('CoordinatorEventBridge');

export class CoordinatorEventBridge {
  private store: OrchestrationEventStore;

  constructor(store: OrchestrationEventStore) {
    this.store = store;
  }

  /**
   * Wire a MultiVerifyCoordinator (EventEmitter) to the event store.
   */
  wireVerifyCoordinator(coordinator: EventEmitter): void {
    coordinator.on('verification:started', (payload: Record<string, unknown>) => {
      this.appendSafe('verification.requested', String(payload['id'] ?? ''), payload, {
        instanceId: String(payload['instanceId'] ?? ''),
      });
    });

    coordinator.on('verification:completed', (payload: Record<string, unknown>) => {
      this.appendSafe('verification.completed', String(payload['id'] ?? ''), payload, {
        instanceId: String(payload['instanceId'] ?? ''),
      });
    });

    coordinator.on('verification:error', (payload: Record<string, unknown>) => {
      const request = (payload['request'] ?? {}) as Record<string, unknown>;
      this.appendSafe('verification.completed', String(request['id'] ?? ''), {
        error: String(payload['error'] ?? 'unknown'),
      }, {
        instanceId: String(request['instanceId'] ?? ''),
      });
    });

    logger.info('Wired verify coordinator to event store');
  }

  /**
   * Wire a DebateCoordinator (EventEmitter) to the event store.
   */
  wireDebateCoordinator(coordinator: EventEmitter): void {
    coordinator.on('debate:started', (payload: Record<string, unknown>) => {
      this.appendSafe('debate.started', String(payload['debateId'] ?? ''), payload);
    });

    coordinator.on('debate:round-complete', (payload: Record<string, unknown>) => {
      this.appendSafe('debate.round_completed', String(payload['debateId'] ?? ''), payload);
    });

    coordinator.on('debate:completed', (payload: Record<string, unknown>) => {
      this.appendSafe('debate.completed', String(payload['debateId'] ?? ''), payload);
    });

    logger.info('Wired debate coordinator to event store');
  }

  private appendSafe(
    type: OrchestrationEventType,
    aggregateId: string,
    payload: Record<string, unknown>,
    metadata?: { instanceId?: string },
  ): void {
    try {
      this.store.append({
        id: randomUUID(),
        type,
        aggregateId,
        timestamp: Date.now(),
        payload,
        metadata,
      });
    } catch (err) {
      logger.warn(`Failed to append event: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
