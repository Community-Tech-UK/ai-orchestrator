import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';
import type { StorageCleanupPreview, StorageCleanupTarget, StorageUsage } from '../../../../shared/types/storage.types';

@Injectable({ providedIn: 'root' })
export class StorageUsageStore implements OnDestroy {
  private readonly ipc = inject(ElectronIpcService);
  private readonly _usage = signal<StorageUsage | null>(null);
  private readonly _preview = signal<StorageCleanupPreview | null>(null);
  private readonly _busy = signal(false);
  private readonly _loading = signal(false);
  private readonly _error = signal<string | null>(null);
  readonly usage = this._usage.asReadonly();
  readonly preview = this._preview.asReadonly();
  readonly busy = computed(() => this._busy() || this._usage()?.progress?.running === true);
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();
  private poll: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;

  async refresh(force = false): Promise<void> {
    const api = this.ipc.getApi();
    if (!api?.storageGetUsage || this.refreshing) return;
    this.refreshing = true;
    this._loading.set(true);
    try {
      const response = await api.storageGetUsage(force);
      if (!response.success || !response.data) throw new Error(response.error?.message ?? 'Unable to measure disk space.');
      const usage = response.data as StorageUsage;
      this._usage.set(usage);
      if (usage.progress?.running) this.startPolling();
      else if (!this._busy()) this.stopPolling();
    } catch (error) { this._error.set(error instanceof Error ? error.message : String(error)); }
    finally { this.refreshing = false; this._loading.set(false); }
  }
  async review(target: StorageCleanupTarget): Promise<void> {
    const api = this.ipc.getApi();
    if (!api?.storagePreviewCleanup || this.busy()) return;
    this._busy.set(true); this._error.set(null); this._preview.set(null);
    try {
      const response = await api.storagePreviewCleanup(target);
      if (!response.success || !response.data) throw new Error(response.error?.message ?? 'Unable to preview this clean-up.');
      this._preview.set(response.data as StorageCleanupPreview);
    } catch (error) { this._error.set(error instanceof Error ? error.message : String(error)); }
    finally { this._busy.set(false); }
  }
  cancel(): void { if (!this.busy()) this._preview.set(null); }
  async run(): Promise<void> {
    const api = this.ipc.getApi();
    const preview = this.preview();
    if (!api?.storageRunCleanup || !preview || this.busy()) return;
    this._busy.set(true); this._error.set(null);
    this.startPolling();
    try {
      const response = await api.storageRunCleanup(preview.target, preview.previewId);
      if (!response.success) throw new Error(response.error?.message ?? 'The clean-up failed.');
      this._preview.set(null);
    } catch (error) { this._error.set(error instanceof Error ? error.message : String(error)); this._preview.set(null); }
    finally { this.stopPolling(); this._busy.set(false); await this.refresh(true); }
  }
  private startPolling(): void { if (this.poll === null) this.poll = setInterval(() => { void this.refresh(); }, 2000); }
  stopPolling(): void { if (this.poll !== null) clearInterval(this.poll); this.poll = null; }
  ngOnDestroy(): void { this.stopPolling(); }
}
