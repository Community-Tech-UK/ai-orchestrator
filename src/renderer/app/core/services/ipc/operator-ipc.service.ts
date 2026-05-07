import { Injectable, inject } from '@angular/core';
import type {
  OperatorRunEventNotification,
  OperatorRunGraph,
  OperatorRunRecord,
  OperatorRunStatus,
} from '../../../../../shared/types/operator.types';
import {
  ElectronIpcService,
  type IpcResponse,
} from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class OperatorIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  async listRuns(payload: {
    threadId?: string;
    status?: OperatorRunStatus;
    limit?: number;
  } = {}): Promise<IpcResponse<OperatorRunRecord[]>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.listOperatorRuns(payload) as Promise<IpcResponse<OperatorRunRecord[]>>;
  }

  async getRun(runId: string): Promise<IpcResponse<OperatorRunGraph | null>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.getOperatorRun({ runId }) as Promise<IpcResponse<OperatorRunGraph | null>>;
  }

  async cancelRun(runId: string): Promise<IpcResponse<OperatorRunGraph>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.cancelOperatorRun({ runId }) as Promise<IpcResponse<OperatorRunGraph>>;
  }

  onOperatorEvent(callback: (payload: OperatorRunEventNotification) => void): () => void {
    if (!this.api?.onOperatorEvent) {
      return () => { /* noop */ };
    }
    return this.api.onOperatorEvent((payload: unknown) => {
      this.base.getNgZone().run(() => callback(payload as OperatorRunEventNotification));
    });
  }
}
