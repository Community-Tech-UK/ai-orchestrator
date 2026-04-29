import { effect, Injectable, inject } from '@angular/core';
import { InstanceIpcService, type PersistedQueuedMessage } from '../../services/ipc/instance-ipc.service';
import { SettingsStore } from '../settings.store';
import { InstanceStateService } from './instance-state.service';
import type { QueuedMessage } from './instance.types';

const SAVE_DEBOUNCE_MS = 300;

@Injectable({ providedIn: 'root' })
export class QueuePersistenceService {
  private stateService = inject(InstanceStateService);
  private ipc = inject(InstanceIpcService);
  private settings = inject(SettingsStore);
  private pendingSaves = new Map<string, ReturnType<typeof setTimeout>>();
  private persistedIds = new Set<string>();
  private initialPromptUnsubscribe: (() => void) | null = null;

  constructor() {
    effect(() => {
      if (!this.settings.isInitialized()) return;
      if (!this.settings.get('pauseFeatureEnabled') || !this.settings.get('persistSessionContent')) {
        this.clearPendingSaves();
        return;
      }

      const queues = this.stateService.messageQueue();
      for (const [instanceId, queue] of queues) {
        this.scheduleSave(instanceId, queue);
      }
      for (const instanceId of [...this.persistedIds]) {
        if (!queues.has(instanceId)) {
          this.scheduleSave(instanceId, []);
        }
      }
    });
  }

  async restoreFromDisk(): Promise<void> {
    if (!this.canPersist()) return;

    const response = await this.ipc.instanceQueueLoadAll();
    if (!response.success || !response.data) return;

    const queues = response.data.queues ?? {};
    this.persistedIds = new Set(Object.keys(queues));
    this.stateService.messageQueue.update((current) => {
      const next = new Map(current);
      for (const [instanceId, queue] of Object.entries(queues)) {
        next.set(instanceId, queue.map((entry) => this.fromPersisted(entry)));
      }
      return next;
    });
  }

  subscribeToInitialPrompts(): void {
    if (this.initialPromptUnsubscribe || !this.isPauseFeatureEnabled()) return;
    this.initialPromptUnsubscribe = this.ipc.onInstanceQueueInitialPrompt((payload) => {
      if (!this.isPauseFeatureEnabled()) return;
      this.stateService.messageQueue.update((current) => {
        const next = new Map(current);
        const queue = next.get(payload.instanceId) ?? [];
        next.set(payload.instanceId, [
          ...queue,
          {
            message: payload.message,
            files: undefined,
            seededAlready: true,
            hadAttachmentsDropped: Boolean(payload.attachments?.length),
          },
        ]);
        return next;
      });
    });
  }

  unsubscribeFromInitialPrompts(): void {
    this.initialPromptUnsubscribe?.();
    this.initialPromptUnsubscribe = null;
  }

  clearPendingSaves(): void {
    for (const timer of this.pendingSaves.values()) clearTimeout(timer);
    this.pendingSaves.clear();
  }

  private scheduleSave(instanceId: string, queue: QueuedMessage[]): void {
    const existing = this.pendingSaves.get(instanceId);
    if (existing) clearTimeout(existing);

    this.pendingSaves.set(
      instanceId,
      setTimeout(() => {
        this.persistNow(instanceId, queue).catch((error) => {
          console.warn('QueuePersistenceService: failed to persist queued messages', error);
        });
      }, SAVE_DEBOUNCE_MS)
    );
  }

  private async persistNow(instanceId: string, queue: QueuedMessage[]): Promise<void> {
    this.pendingSaves.delete(instanceId);
    if (!this.canPersist()) return;

    const persisted = queue.map((entry) => this.toPersisted(entry));
    const response = await this.ipc.instanceQueueSave(instanceId, persisted);
    if (response.success) {
      if (persisted.length === 0) this.persistedIds.delete(instanceId);
      else this.persistedIds.add(instanceId);
    }
  }

  private canPersist(): boolean {
    return this.isPauseFeatureEnabled() && this.settings.get('persistSessionContent');
  }

  private isPauseFeatureEnabled(): boolean {
    return this.settings.isInitialized() && this.settings.get('pauseFeatureEnabled');
  }

  private toPersisted(entry: QueuedMessage): PersistedQueuedMessage {
    return {
      message: entry.message,
      hadAttachmentsDropped: entry.hadAttachmentsDropped ?? Boolean(entry.files?.length),
      retryCount: entry.retryCount,
      seededAlready: entry.seededAlready,
      kind: entry.kind,
    };
  }

  private fromPersisted(entry: PersistedQueuedMessage): QueuedMessage {
    return {
      message: entry.message,
      files: undefined,
      retryCount: entry.retryCount,
      seededAlready: entry.seededAlready,
      kind: entry.kind,
      hadAttachmentsDropped: entry.hadAttachmentsDropped,
    };
  }
}
