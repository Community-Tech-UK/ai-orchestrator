import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { OrchestrationEventStore } from './event-store/orchestration-event-store';
import type { OrchestrationEvent, OrchestrationEventType } from './event-store/orchestration-events';
import { DrainableQueue } from '../testing/drainable-queue';

export interface OrchestrationCommand {
  type: OrchestrationEventType;
  aggregateId: string;
  payload: Record<string, unknown>;
  metadata?: OrchestrationEvent['metadata'];
}

export class OrchestrationEngine extends EventEmitter {
  private readonly queue: DrainableQueue<OrchestrationEvent>;

  constructor(private readonly store: OrchestrationEventStore) {
    super();
    this.queue = new DrainableQueue<OrchestrationEvent>(
      async (event) => {
        this.store.append(event);
        this.emit('event:appended', event);
      },
      { concurrency: 1 },
    );
  }

  dispatch(command: OrchestrationCommand): OrchestrationEvent {
    const event: OrchestrationEvent = {
      id: randomUUID(),
      type: command.type,
      aggregateId: command.aggregateId,
      timestamp: Date.now(),
      payload: command.payload,
      metadata: command.metadata,
    };
    this.queue.enqueue(event);
    this.emit('command:dispatched', command);
    return event;
  }

  async drain(): Promise<void> {
    await this.queue.drain();
  }
}
