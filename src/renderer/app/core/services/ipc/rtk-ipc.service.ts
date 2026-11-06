/**
 * RTK IPC Service — read-only access to RTK token-savings analytics.
 *
 * Pulls aggregate stats from the main process, which in turn reads RTK's
 * SQLite tracking DB. Used by the RTK Savings panel under Settings → Performance.
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';

export interface RtkCoverageRow {
  surface: string;
  mode: 'Hook' | 'Instructions only' | 'Trial' | 'Off';
  note: string;
}

export interface RtkStatusData {
  enabled: boolean;
  available: boolean;
  binarySource: 'bundled' | 'system' | 'override' | 'none';
  version: string | null;
  trackingDbPath: string;
  trackingDbAvailable: boolean;
  coverage: RtkCoverageRow[];
  trial?: { startedAt: string | null; sessionsWithHook: number; sessionsWithout: number } | null;
}

export interface RtkCommandStat {
  rtkCmd: string;
  count: number;
  saved: number;
  avgSavingsPct: number;
}

export interface RtkSavingsSummary {
  commands: number;
  commandsFiltered: number;
  commandsRanInFull: number;
  projectBursts?: { projectPath: string; commands: number }[];
  totalInput: number;
  totalOutput: number;
  totalSaved: number;
  savedTokensCapped: number;
  weightedReductionPct: number;
  windowDays: number;
  avgSavingsPct: number;
  byCommand: RtkCommandStat[];
  byProgram: { program: string; count: number; savedTokensCapped: number }[];
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
  /** Cache the requested period: summary.windowDays measures the recorded span instead. */
  readonly lastSummary = { value: null as RtkSavingsSummary | null, windowDays: 7 };
  private summaryEpoch = 0;

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
    const epoch = ++this.summaryEpoch;
    const windowDays = opts?.sinceMs === undefined ? 0 : Math.round((Date.now() - opts.sinceMs) / 86_400_000);
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    const response = await this.api.rtkGetSummary(opts) as IpcResponse<RtkSavingsSummary | null>;
    if (response.success && epoch === this.summaryEpoch && !opts?.projectPath
      && (opts?.topN === undefined || opts.topN === 10)) {
      this.lastSummary.value = response.data ?? null;
      this.lastSummary.windowDays = windowDays;
    }
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
