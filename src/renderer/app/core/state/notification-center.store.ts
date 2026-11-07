import { Injectable, computed, inject, signal } from '@angular/core';
import type { NotificationRecord } from '../../../../shared/types/notification.types';
import { SessionNavigator } from '../services/session-navigator.service';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';

const MAX_RECORDS = 500;

@Injectable({ providedIn: 'root' })
export class NotificationCenterStore {
  private readonly navigator = inject(SessionNavigator);
  private openTargetCleanup: (() => void) | null = null;
  private readonly marking = new Set<string>();
  private readonly ipc = inject(ElectronIpcService);
  private readonly _records = signal<readonly NotificationRecord[]>([]);
  private readonly _error = signal<string | null>(null);
  private unsubscribe: (() => void) | null = null;
  private initialized = false;

  readonly records = this._records.asReadonly();
  readonly error = this._error.asReadonly();
  readonly count = computed(() => this._records().filter(record => record.seenAt === undefined && record.resolvedAt === undefined).length);

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    const api = this.ipc.getApi();
    if (!api?.notificationList || !api.onNotificationDelta) return;
    this.openTargetCleanup = api.onNotificationOpenTarget?.(({ instanceId }) => this.navigator.openSession(instanceId)) ?? null;

    this.unsubscribe = api.onNotificationDelta((record) => {
      this._records.set(this.mergeRecords(this._records(), [record]));
      this._error.set(null);
    });
    void this.load();
  }

  dispose(): void {
    this.openTargetCleanup?.();
    this.openTargetCleanup = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.initialized = false;
  }

  async load(): Promise<void> {
    const api = this.ipc.getApi();
    if (!api?.notificationList) return;

    try {
      const response = await api.notificationList();
      if (!response.success || !Array.isArray(response.data)) {
        throw new Error(response.error?.message ?? 'Failed to load notifications');
      }
      this._records.set(this.mergeRecords(response.data as NotificationRecord[], this._records()));
      this._error.set(null);
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : String(error));
    }
  }

  async markSeen(selection: { ids?: string[]; instanceId?: string }): Promise<void> {
    const api = this.ipc.getApi();
    if (!api?.notificationMarkSeen) return;
    const ids = this._records().filter(record => record.seenAt === undefined &&
      (selection.ids?.includes(record.id) || (!!selection.instanceId && record.instanceId === selection.instanceId)))
      .map(record => record.id).filter(id => !this.marking.has(id)).slice(0, selection.instanceId ? MAX_RECORDS : 100);
    if (!ids.length) return;
    ids.forEach(id => this.marking.add(id));
    try {
      const response = await api.notificationMarkSeen(selection.instanceId ? { instanceId: selection.instanceId } : { ids });
      if (!response.success) throw new Error('Could not mark notifications seen');
      const seenAt = Date.now();
      this._records.update(records => records.map(record => ids.includes(record.id) && record.seenAt === undefined
        ? { ...record, seenAt } : record));
    } catch {
      this._error.set('Could not mark notifications as seen.');
    } finally {
      ids.forEach(id => this.marking.delete(id));
    }
  }

  markSessionSeen(instanceId: string): void { void this.markSeen({ instanceId }); }

  /** Removes one record locally and asks the main process to drop it. */
  async dismiss(id: string): Promise<void> {
    const previous = this._records();
    this._records.set(previous.filter((record) => record.id !== id));
    const api = this.ipc.getApi();
    if (!api?.notificationDismiss) return;
    try {
      const response = await api.notificationDismiss(id);
      if (!response.success) throw new Error(response.error?.message ?? 'Failed to dismiss notification');
    } catch (error) {
      this._records.set(previous);
      this._error.set(error instanceof Error ? error.message : String(error));
    }
  }

  /** Clears every retained record locally and in the main process. */
  async clearAll(): Promise<void> {
    const previous = this._records();
    this._records.set([]);
    const api = this.ipc.getApi();
    if (!api?.notificationClear) return;
    try {
      const response = await api.notificationClear();
      if (!response.success) throw new Error(response.error?.message ?? 'Failed to clear notifications');
    } catch (error) {
      this._records.set(previous);
      this._error.set(error instanceof Error ? error.message : String(error));
    }
  }

  private mergeRecords(...batches: (readonly NotificationRecord[])[]): readonly NotificationRecord[] {
    const byId = new Map<string, NotificationRecord>();
    for (const batch of batches) {
      for (const record of batch) {
        const previous = byId.get(record.id);
        if (!previous || (record.updatedAt ?? record.createdAt) >= (previous.updatedAt ?? previous.createdAt)) {
          byId.set(record.id, record);
        }
      }
    }
    return [...byId.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, MAX_RECORDS);
  }
}
