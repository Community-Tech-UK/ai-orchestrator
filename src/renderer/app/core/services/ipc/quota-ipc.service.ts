/**
 * Quota IPC Service — provider quota tracking (remaining usage budgets).
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class QuotaIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  private get ngZone() {
    return this.base.getNgZone();
  }

  // ============================================
  // Reads
  // ============================================

  async quotaGetAll(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.quotaGetAll();
  }

  async quotaGetProvider(provider: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.quotaGetProvider(provider);
  }

  // ============================================
  // Actions
  // ============================================

  async quotaRefresh(provider: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.quotaRefresh(provider);
  }

  async quotaRefreshAll(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.quotaRefreshAll();
  }

  async quotaSetPollInterval(provider: string, intervalMs: number): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.quotaSetPollInterval(provider, intervalMs);
  }

  // ============================================
  // Push events (NgZone-wrapped so signals re-render)
  // ============================================

  onQuotaUpdated(callback: (data: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onQuotaUpdated((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  onQuotaWarning(callback: (data: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onQuotaWarning((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  onQuotaExhausted(callback: (data: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onQuotaExhausted((data) => {
      this.ngZone.run(() => callback(data));
    });
  }
}
