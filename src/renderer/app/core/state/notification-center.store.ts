import { Injectable, computed, inject, signal } from '@angular/core';
import type { NotificationRecord } from '../../../../shared/types/notification.types';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';

const MAX_RECORDS = 500;

@Injectable({ providedIn: 'root' })
export class NotificationCenterStore {
  private readonly ipc = inject(ElectronIpcService);
  private readonly _records = signal<readonly NotificationRecord[]>([]);
  private readonly _error = signal<string | null>(null);
  private unsubscribe: (() => void) | null = null;
  private initialized = false;

  readonly records = this._records.asReadonly();
  readonly error = this._error.asReadonly();
  readonly count = computed(() => this._records().length);

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    const api = this.ipc.getApi();
    if (!api?.notificationList || !api.onNotificationDelta) return;

    this.unsubscribe = api.onNotificationDelta((record) => {
      this._records.set(this.mergeRecords(this._records(), [record]));
      this._error.set(null);
    });
    void this.load();
  }

  dispose(): void {
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
      for (const record of batch) byId.set(record.id, record);
    }
    return [...byId.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .slice(0, MAX_RECORDS);
  }
}
