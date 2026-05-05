import { EventEmitter } from 'events';
import type {
  OperatorRunEventNotification,
  OperatorRunEventRecord,
} from '../../shared/types/operator.types';

type OperatorEventBusEvent = 'operator:event';

export class OperatorEventBus extends EventEmitter {
  private static instance: OperatorEventBus | null = null;

  static getInstance(): OperatorEventBus {
    this.instance ??= new OperatorEventBus();
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance?.removeAllListeners();
    this.instance = null;
  }

  publish(event: OperatorRunEventRecord): void {
    this.emit('operator:event', {
      runId: event.runId,
      nodeId: event.nodeId,
      event,
    } satisfies OperatorRunEventNotification);
  }

  subscribe(callback: (payload: OperatorRunEventNotification) => void): () => void {
    const eventName: OperatorEventBusEvent = 'operator:event';
    this.on(eventName, callback);
    return () => this.off(eventName, callback);
  }
}

export function getOperatorEventBus(): OperatorEventBus {
  return OperatorEventBus.getInstance();
}
