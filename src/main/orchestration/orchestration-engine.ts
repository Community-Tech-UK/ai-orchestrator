import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { OrchestrationEventStore } from './event-store/orchestration-event-store';
import type { OrchestrationEvent, OrchestrationEventType } from './event-store/orchestration-events';
import { DrainableQueue } from '../testing/drainable-queue';
import type { OrchestrationCommandReceipt } from './orchestration-command-receipts';

export interface OrchestrationCommand {
  commandId?: string;
  type: OrchestrationEventType;
  aggregateId: string;
  payload: Record<string, unknown>;
  metadata?: OrchestrationEvent['metadata'];
}

export interface OrchestrationDispatchResult {
  event?: OrchestrationEvent;
  receipt: OrchestrationCommandReceipt;
  duplicate: boolean;
}

type EngineStore = Pick<OrchestrationEventStore, 'append'> & Partial<
  Pick<OrchestrationEventStore, 'getCommandReceipt' | 'recordCommandReceipt'>
>;

export class OrchestrationEngine extends EventEmitter {
  private readonly queue: DrainableQueue<OrchestrationEvent>;
  private readonly receipts = new Map<string, OrchestrationCommandReceipt>();

  constructor(private readonly store: EngineStore) {
    super();
    this.queue = new DrainableQueue<OrchestrationEvent>(
      async (event) => {
        this.store.append(event);
        this.emit('event:appended', event);
      },
      { concurrency: 1 },
    );
  }

  dispatch(command: OrchestrationCommand): OrchestrationDispatchResult {
    const commandId = command.commandId?.trim() || randomUUID();
    const existingReceipt = this.getReceipt(commandId);
    if (existingReceipt) {
      this.emit('command:duplicate', existingReceipt);
      return { receipt: existingReceipt, duplicate: true };
    }

    const rejectedReason = this.validateCommand(command);
    if (rejectedReason) {
      const receipt: OrchestrationCommandReceipt = {
        commandId,
        status: 'rejected',
        type: command.type,
        aggregateId: command.aggregateId,
        reason: rejectedReason,
        timestamp: Date.now(),
        metadata: command.metadata,
      };
      this.recordReceipt(receipt);
      this.emit('command:rejected', receipt);
      return { receipt, duplicate: false };
    }

    const event: OrchestrationEvent = {
      id: randomUUID(),
      type: command.type,
      aggregateId: command.aggregateId,
      timestamp: Date.now(),
      payload: command.payload,
      metadata: command.metadata,
    };
    const receipt: OrchestrationCommandReceipt = {
      commandId,
      status: 'accepted',
      type: command.type,
      aggregateId: command.aggregateId,
      eventId: event.id,
      timestamp: event.timestamp,
      metadata: command.metadata,
    };
    this.recordReceipt(receipt);
    this.queue.enqueue(event);
    this.emit('command:dispatched', { ...command, commandId });
    return { event, receipt, duplicate: false };
  }

  async drain(): Promise<void> {
    await this.queue.drain();
  }

  getReceipt(commandId: string): OrchestrationCommandReceipt | undefined {
    const persisted = this.store.getCommandReceipt?.(commandId);
    if (persisted) {
      this.receipts.set(commandId, persisted);
      return persisted;
    }
    return this.receipts.get(commandId);
  }

  private validateCommand(command: OrchestrationCommand): string | null {
    if (!command.type || typeof command.type !== 'string') {
      return 'Command type is required';
    }
    if (!command.aggregateId || typeof command.aggregateId !== 'string') {
      return 'Aggregate ID is required';
    }
    if (!command.payload || typeof command.payload !== 'object' || Array.isArray(command.payload)) {
      return 'Payload must be an object';
    }
    return null;
  }

  private recordReceipt(receipt: OrchestrationCommandReceipt): void {
    this.receipts.set(receipt.commandId, receipt);
    this.store.recordCommandReceipt?.(receipt);
  }
}
