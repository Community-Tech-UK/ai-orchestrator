import { Injectable, computed, inject, signal } from '@angular/core';
import type { UpdateStatus } from '../../../../shared/types/update.types';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';

interface StatusResponse {
  success: boolean;
  data?: unknown;
  error?: { message: string };
}

function updateIdentity(status: UpdateStatus): string {
  return status.availableVersion ?? status.currentVersion ?? 'downloaded';
}

@Injectable({ providedIn: 'root' })
export class AppUpdateStore {
  private readonly ipc = inject(ElectronIpcService);
  private readonly _status = signal<UpdateStatus | null>(null);
  private readonly _loading = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly dismissedVersion = signal<string | null>(null);
  private unsubscribe: (() => void) | null = null;
  private initialized = false;

  readonly status = this._status.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();
  readonly visible = computed(() => {
    const status = this._status();
    return status?.state === 'downloaded'
      && updateIdentity(status) !== this.dismissedVersion();
  });

  init(): void {
    if (this.initialized) return;
    this.initialized = true;

    const api = this.ipc.getApi();
    if (!api) return;

    this.unsubscribe = api.onUpdateStatusChanged((status) => {
      this.applyStatus(status as UpdateStatus);
    });
    void this.load();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.initialized = false;
  }

  dismissForSession(): void {
    const status = this._status();
    if (status?.state === 'downloaded') {
      this.dismissedVersion.set(updateIdentity(status));
    }
  }

  async check(): Promise<void> {
    const api = this.ipc.getApi();
    if (!api) return;
    await this.runStatusAction(() => api.updateCheck());
  }

  async retryDownload(): Promise<void> {
    const api = this.ipc.getApi();
    if (!api) return;
    await this.runStatusAction(() => api.updateDownload());
  }

  async restartAndInstall(): Promise<void> {
    const api = this.ipc.getApi();
    if (!api) return;

    this._loading.set(true);
    this._error.set(null);
    try {
      const response = await api.updateInstall();
      if (!response.success) {
        throw new Error(response.error?.message ?? 'Failed to restart and install the update');
      }
      const data = response.data as { installing?: boolean } | undefined;
      if (data?.installing !== true) {
        throw new Error('The update is not ready to install');
      }
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this._loading.set(false);
    }
  }

  private async load(): Promise<void> {
    const api = this.ipc.getApi();
    if (!api) return;
    await this.runStatusAction(() => api.updateGetStatus());
  }

  private async runStatusAction(action: () => Promise<StatusResponse>): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    try {
      const response = await action();
      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? 'Failed to load application update status');
      }
      this.applyStatus(response.data as UpdateStatus);
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this._loading.set(false);
    }
  }

  private applyStatus(status: UpdateStatus): void {
    this._status.set(status);
    this._error.set(null);
  }
}
