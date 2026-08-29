import { EventEmitter } from 'events';
import type { CliAsyncWorkEvent } from '../cli/adapters/claude-cli-async-work';

export interface InstanceAsyncWorkTerminalEvent {
  instanceId: string;
  event: Extract<CliAsyncWorkEvent, { phase: 'terminal' }>;
}

export class InstanceAsyncWorkRegistry extends EventEmitter {
  private readonly activeWork = new Map<string, Map<string, CliAsyncWorkEvent['kind']>>();
  private readonly completionDeliveries = new Set<string>();
  private readonly deliveredTerminalEvents = new Map<string, Set<string>>();

  observe(instanceId: string, event: CliAsyncWorkEvent): void {
    if (event.phase === 'progress') {
      this.emit('work:progress', { instanceId, event });
      return;
    }

    if (event.phase === 'started') {
      const instanceWork = this.activeWork.get(instanceId) ?? new Map();
      if (event.replacesWorkId) {
        instanceWork.delete(event.replacesWorkId);
      }
      instanceWork.set(event.workId, event.kind);
      this.activeWork.set(instanceId, instanceWork);
      this.emit('work:started', { instanceId, event });
      return;
    }

    const instanceWork = this.activeWork.get(instanceId);
    instanceWork?.delete(event.workId);
    if (event.replacesWorkId) {
      instanceWork?.delete(event.replacesWorkId);
    }
    if (instanceWork?.size === 0) {
      this.activeWork.delete(instanceId);
    }

    if (event.continueOnCompletion === false) {
      return;
    }

    const terminalKey = `${event.kind}:${event.workId}:${event.status}`;
    const delivered = this.deliveredTerminalEvents.get(instanceId) ?? new Set<string>();
    if (delivered.has(terminalKey)) {
      return;
    }
    delivered.add(terminalKey);
    this.deliveredTerminalEvents.set(instanceId, delivered);
    this.beginCompletionDelivery(instanceId);
    this.emit('work:terminal', { instanceId, event } satisfies InstanceAsyncWorkTerminalEvent);
  }

  hasInhibitor(instanceId: string): boolean {
    return (this.activeWork.get(instanceId)?.size ?? 0) > 0
      || this.completionDeliveries.has(instanceId);
  }

  activeWorkIds(instanceId: string): string[] {
    return [...(this.activeWork.get(instanceId)?.keys() ?? [])].sort();
  }

  beginCompletionDelivery(instanceId: string): void {
    this.completionDeliveries.add(instanceId);
  }

  finishCompletionDelivery(instanceId: string): void {
    this.completionDeliveries.delete(instanceId);
  }

  clearInstance(instanceId: string): void {
    this.activeWork.delete(instanceId);
    this.completionDeliveries.delete(instanceId);
    this.deliveredTerminalEvents.delete(instanceId);
  }
}

let instance: InstanceAsyncWorkRegistry | null = null;

export function getInstanceAsyncWorkRegistry(): InstanceAsyncWorkRegistry {
  instance ??= new InstanceAsyncWorkRegistry();
  return instance;
}

export function _resetForTesting(): void {
  instance?.removeAllListeners();
  instance = null;
}
