import { Injectable, signal, inject } from '@angular/core';
import type { CliUpdatePillState } from '../../../../shared/types/diagnostics.types';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';

const EMPTY_STATE: CliUpdatePillState = {
  generatedAt: 0,
  count: 0,
  entries: [],
};

@Injectable({ providedIn: 'root' })
export class CliUpdatePillStore {
  private readonly ipc = inject(ElectronIpcService);
  private readonly _state = signal<CliUpdatePillState>(EMPTY_STATE);
  private readonly _loading = signal(false);
  private readonly _error = signal<string | null>(null);
  private cleanup: (() => void) | null = null;
  private initialized = false;

  readonly state = this._state.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();

  init(): void {
    if (this.initialized) {
      return;
    }

    this.initialized = true;
    const api = this.ipc.getApi();
    if (!api) {
      return;
    }

    this.cleanup = api.onCliUpdatePillDelta?.((state) => {
      this._state.set(state as CliUpdatePillState);
    }) ?? null;
    void this.load();
  }

  dispose(): void {
    this.cleanup?.();
    this.cleanup = null;
    this.initialized = false;
  }

  async load(): Promise<void> {
    const api = this.ipc.getApi();
    if (!api?.cliUpdatePillGetState) {
      return;
    }

    this._loading.set(true);
    this._error.set(null);
    try {
      const response = await api.cliUpdatePillGetState();
      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? 'Failed to load CLI update state');
      }
      this._state.set(response.data as CliUpdatePillState);
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this._loading.set(false);
    }
  }

  async refresh(): Promise<void> {
    const api = this.ipc.getApi();
    if (!api?.cliUpdatePillRefresh) {
      return;
    }

    this._loading.set(true);
    this._error.set(null);
    try {
      const response = await api.cliUpdatePillRefresh();
      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? 'Failed to refresh CLI update state');
      }
      this._state.set(response.data as CliUpdatePillState);
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this._loading.set(false);
    }
  }
}
