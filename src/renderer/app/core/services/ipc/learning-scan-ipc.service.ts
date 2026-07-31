import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';
import type { LearningScanCheckpoint, LearningScanResultSummary } from '../../../features/memory-review/memory-review.types';

/**
 * Renderer IPC wrapper for the WS-B8 fail->fix correction scan: manual
 * trigger + status/last-result read. Never auto-promotes anything.
 */
@Injectable({ providedIn: 'root' })
export class LearningScanIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  async run(payload: {
    workspaceId?: string;
    sessionLimit?: number;
    sinceTs?: number;
  } = {}): Promise<IpcResponse<LearningScanResultSummary>> {
    return this.call(() => this.api?.learningScanRun(payload));
  }

  async getStatus(workspaceId?: string): Promise<IpcResponse<LearningScanCheckpoint | null>> {
    return this.call(() => this.api?.learningScanGetStatus(workspaceId));
  }

  private async call<T>(fn: () => Promise<IpcResponse> | undefined): Promise<IpcResponse<T>> {
    const response = await fn();
    return response ? (response as IpcResponse<T>) : this.notInElectron<T>();
  }

  private notInElectron<T>(): IpcResponse<T> {
    return { success: false, error: { message: 'Not in Electron' } };
  }
}
