import { DestroyRef, Injectable, effect, inject, signal } from '@angular/core';
import { IpcEventBusService } from '../services/ipc/ipc-event-bus.service';
import { InstanceStore } from './instance.store';

export interface PendingRequest {
  instanceId: string;
  kind: 'permission' | 'question' | 'other';
  toolName?: string;
  text: string;
  since: number;
}

const WAITING_STATUSES = new Set(['waiting_for_input', 'waiting_for_permission']);

// Request ids are connection-local (ACP json-rpc ids), so two sessions can
// both have request "1"; storage is keyed by the session too.
const requestKey = (instanceId: string, requestId: string): string => `${instanceId}\u0000${requestId}`;

@Injectable({ providedIn: 'root' })
export class PendingRequestStore {
  private readonly instances = inject(InstanceStore);
  private readonly requests = signal<ReadonlyMap<string, PendingRequest>>(new Map());
  private readonly lastStatus = new Map<string, string | undefined>();
  private readonly requestOwners = new Map<string, string>();

  constructor() {
    const bus = inject(IpcEventBusService);
    const added = bus.inputRequired$.subscribe((event) => {
      const instance = this.instances.instances().find((item) => item.id === event.instanceId);
      if (instance?.yoloMode) return;
      // Recording the observed status here keeps the lifecycle effect honest
      // even when the request is the store's first sight of this waiting state.
      if (instance) this.lastStatus.set(event.instanceId, instance.status as string | undefined);
      const type = event.metadata?.['type'];
      const tool = event.metadata?.['tool_name'];
      const key = requestKey(event.instanceId, event.requestId);
      this.requestOwners.set(key, event.instanceId);
      this.requests.update((items) => new Map(items).set(key, {
        instanceId: event.instanceId,
        kind: type === 'permission_denial' || type === 'deferred_permission' ? 'permission'
          : type === 'ask_user_question' || type === 'mcp_elicitation' ? 'question' : 'other',
        ...(typeof tool === 'string' ? { toolName: tool } : {}),
        text: (event.prompt ?? '').slice(0, 140),
        since: event.timestamp ?? Date.now(),
      }));
    });
    const resolved = bus.inputRequiredResolved$.subscribe((event) => {
      const key = requestKey(event.instanceId, event.requestId);
      this.requests.update((items) => {
        if (!items.has(key)) return items;
        const next = new Map(items);
        next.delete(key);
        return next;
      });
      this.requestOwners.delete(key);
    });
    // Answered prompts on the ordinary path emit no resolved event, so a
    // request is also dropped when its turn completes past it (the instance
    // leaves the waiting states) or its session is removed. Without this the
    // old prompt resurfaces as the pending request of the next waiting state.
    effect(() => {
      const statuses = new Map(this.instances.instances().map((item) => [item.id, item.status as string | undefined]));
      const finished = new Set<string>();
      for (const [id, previous] of this.lastStatus) {
        const next = statuses.get(id);
        if (next === undefined || (WAITING_STATUSES.has(previous ?? '') && !WAITING_STATUSES.has(next ?? ''))) {
          finished.add(id);
        }
      }
      for (const instanceId of this.requestOwners.values()) {
        if (!statuses.has(instanceId)) finished.add(instanceId);
      }
      this.lastStatus.clear();
      for (const [id, status] of statuses) this.lastStatus.set(id, status);
      if (finished.size === 0) return;
      this.requests.update((items) => {
        const next = new Map(items);
        for (const [key, item] of items) {
          if (finished.has(item.instanceId)) { next.delete(key); this.requestOwners.delete(key); }
        }
        return next;
      });
    });
    inject(DestroyRef).onDestroy(() => { added.unsubscribe(); resolved.unsubscribe(); });
  }

  forInstance(id: string): PendingRequest[] {
    const instance = this.instances.instances().find((item) => item.id === id);
    if (!instance || instance.yoloMode || !WAITING_STATUSES.has(instance.status)) return [];
    return [...this.requests().values()].filter((item) => item.instanceId === id).sort((a, b) => a.since - b.since);
  }
}
