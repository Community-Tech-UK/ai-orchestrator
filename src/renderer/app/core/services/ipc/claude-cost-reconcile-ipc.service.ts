/**
 * Claude cost check IPC service: the daily comparison of Harness's booked Claude
 * spend with Claude's own totals.
 */

import { Injectable, inject } from '@angular/core';
import type { ClaudeCostReconcileSnapshot } from '../../../../../shared/types/claude-cost-reconcile.types';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class ClaudeCostReconcileIpcService {
  private readonly base = inject(ElectronIpcService);

  /** The stored result of the latest check. */
  async get(): Promise<IpcResponse<ClaudeCostReconcileSnapshot>> {
    const api = this.base.getApi();
    if (!api) return { success: false, error: { message: 'Not in Electron' } };
    return api.claudeCostReconcileGet();
  }

  /** Run the check now and return the new result. */
  async run(): Promise<IpcResponse<ClaudeCostReconcileSnapshot>> {
    const api = this.base.getApi();
    if (!api) return { success: false, error: { message: 'Not in Electron' } };
    return api.claudeCostReconcileRun();
  }
}
