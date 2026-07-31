import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';
import type { OperationalDecision } from '@contracts/schemas/workboard';

/** WS-C1: read-only Workboard cross-domain decision timeline. */
@Injectable({ providedIn: 'root' })
export class WorkboardIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  async getDecisionsForItem(query: {
    loopRunId?: string;
    automationRunId?: string;
    instanceId?: string;
  }): Promise<IpcResponse<OperationalDecision[]>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.workboardGetDecisionsForItem(query) as Promise<IpcResponse<OperationalDecision[]>>;
  }
}
