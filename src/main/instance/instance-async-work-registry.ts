import { EventEmitter } from 'events';
import type { CliAsyncWorkEvent, CliAsyncWorkKind } from '../cli/adapters/claude-cli-async-work';
import type { InstanceBackgroundWork } from '../../shared/types/instance.types';

export interface InstanceAsyncWorkTerminalEvent {
  instanceId: string;
  event: Extract<CliAsyncWorkEvent, { phase: 'terminal' }>;
}

export interface InstanceAsyncWorkChangedEvent {
  instanceId: string;
  summary: InstanceBackgroundWork | null;
}

export interface InstanceAsyncWorkProviderResumedEvent {
  instanceId: string;
}

interface ActiveWorkRecord {
  kind: CliAsyncWorkKind;
  startedAt: number;
}

export class InstanceAsyncWorkRegistry extends EventEmitter {
  private readonly activeWork = new Map<string, Map<string, ActiveWorkRecord>>();
  private readonly completionDeliveries = new Set<string>();
  private readonly deliveredTerminalEvents = new Map<string, Set<string>>();

  constructor(private readonly now: () => number = () => Date.now()) {
    super();
  }

  observe(instanceId: string, event: CliAsyncWorkEvent): void {
    if (event.phase === 'progress') {
      this.emit('work:progress', { instanceId, event });
      return;
    }

    if (event.phase === 'provider-resumed') {
      this.emit('work:provider-resumed', { instanceId } satisfies InstanceAsyncWorkProviderResumedEvent);
      return;
    }

    if (event.phase === 'snapshot') {
      this.applySnapshot(instanceId, event.work);
      return;
    }

    if (event.phase === 'started') {
      const before = this.summaryKey(instanceId);
      const instanceWork = this.activeWork.get(instanceId) ?? new Map<string, ActiveWorkRecord>();
      const replaced = event.replacesWorkId ? instanceWork.get(event.replacesWorkId) : undefined;
      if (event.replacesWorkId) {
        instanceWork.delete(event.replacesWorkId);
      }
      if (!instanceWork.has(event.workId)) {
        instanceWork.set(event.workId, { kind: event.kind, startedAt: replaced?.startedAt ?? this.now() });
      }
      this.activeWork.set(instanceId, instanceWork);
      this.emit('work:started', { instanceId, event });
      this.emitChangedIfDifferent(instanceId, before);
      return;
    }

    const before = this.summaryKey(instanceId);
    const instanceWork = this.activeWork.get(instanceId);
    instanceWork?.delete(event.workId);
    if (event.replacesWorkId) {
      instanceWork?.delete(event.replacesWorkId);
    }
    if (instanceWork?.size === 0) {
      this.activeWork.delete(instanceId);
    }
    this.emitChangedIfDifferent(instanceId, before);

    if (event.continueOnCompletion === false) {
      return;
    }

    // Keyed without `kind`: the legacy user-text notification parser cannot
    // tell a background agent from a shell, so the same task can arrive twice
    // with different kinds.
    const terminalKey = `${event.workId}:${event.status}`;
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

  /** Live provider-owned background work, or null when there is none. */
  backgroundWorkSummary(instanceId: string): InstanceBackgroundWork | null {
    const instanceWork = this.activeWork.get(instanceId);
    if (!instanceWork || instanceWork.size === 0) {
      return null;
    }
    let since = Number.POSITIVE_INFINITY;
    for (const record of instanceWork.values()) {
      since = Math.min(since, record.startedAt);
    }
    return { count: instanceWork.size, since };
  }

  instancesWithActiveWork(): string[] {
    return [...this.activeWork.keys()];
  }

  beginCompletionDelivery(instanceId: string): void {
    this.completionDeliveries.add(instanceId);
  }

  finishCompletionDelivery(instanceId: string): void {
    this.completionDeliveries.delete(instanceId);
  }

  clearInstance(instanceId: string): void {
    const before = this.summaryKey(instanceId);
    this.activeWork.delete(instanceId);
    this.completionDeliveries.delete(instanceId);
    this.deliveredTerminalEvents.delete(instanceId);
    this.emitChangedIfDifferent(instanceId, before);
  }

  private applySnapshot(instanceId: string, work: { workId: string; kind: CliAsyncWorkKind }[]): void {
    const before = this.summaryKey(instanceId);
    const previous = this.activeWork.get(instanceId);
    const next = new Map<string, ActiveWorkRecord>();
    const now = this.now();
    for (const item of work) {
      next.set(item.workId, { kind: item.kind, startedAt: previous?.get(item.workId)?.startedAt ?? now });
    }
    if (next.size === 0) {
      this.activeWork.delete(instanceId);
    } else {
      this.activeWork.set(instanceId, next);
    }
    this.emitChangedIfDifferent(instanceId, before);
  }

  private summaryKey(instanceId: string): string {
    const summary = this.backgroundWorkSummary(instanceId);
    return summary ? `${summary.count}:${summary.since}` : '';
  }

  private emitChangedIfDifferent(instanceId: string, before: string): void {
    if (this.summaryKey(instanceId) === before) {
      return;
    }
    this.emit('work:changed', {
      instanceId,
      summary: this.backgroundWorkSummary(instanceId),
    } satisfies InstanceAsyncWorkChangedEvent);
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
