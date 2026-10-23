/**
 * RTK IPC Service — read-only access to RTK token-savings analytics.
 *
 * Pulls aggregate stats from the main process, which in turn reads RTK's
 * SQLite tracking DB. Used by the RTK Savings panel under Settings → Performance.
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';

export interface RtkStatusData {
  enabled: boolean;
  available: boolean;
  binarySource: 'bundled' | 'system' | 'override' | 'none';
  version: string | null;
  trackingDbPath: string;
  trackingDbAvailable: boolean;
}

export interface RtkCommandStat {
  rtkCmd: string;
  count: number;
  saved: number;
  avgSavingsPct: number;
}

export interface RtkSavingsSummary {
  commands: number;
  projectBursts?: { projectPath: string; commands: number }[];
  totalInput: number;
  totalOutput: number;
  totalSaved: number;
  avgSavingsPct: number;
  byCommand: RtkCommandStat[];
  lastCommandAt: string | null;
}

export interface RtkCommandRecord {
  timestamp: string;
  originalCmd: string;
  rtkCmd: string;
  savedTokens: number;
  savingsPct: number;
  projectPath: string;
}

@Injectable({ providedIn: 'root' })
export class RtkIpcService {
  private base = inject(ElectronIpcService);
  /** Last successful result survives tab destruction while a new result loads. */
  readonly lastSummary = { value: null as RtkSavingsSummary | null };

  private get api() {
    return this.base.getApi();
  }

  async getStatus(): Promise<IpcResponse<RtkStatusData>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rtkGetStatus() as Promise<IpcResponse<RtkStatusData>>;
  }

  async getSummary(opts?: {
    projectPath?: string;
    sinceMs?: number;
    topN?: number;
  }): Promise<IpcResponse<RtkSavingsSummary | null>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    const response = await this.api.rtkGetSummary(opts) as IpcResponse<RtkSavingsSummary | null>;
    if (response.success) this.lastSummary.value = response.data ?? null;
    return response;
  }

  async getHistory(opts?: {
    projectPath?: string;
    limit?: number;
  }): Promise<IpcResponse<RtkCommandRecord[]>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.rtkGetHistory(opts) as Promise<IpcResponse<RtkCommandRecord[]>>;
  }
}
