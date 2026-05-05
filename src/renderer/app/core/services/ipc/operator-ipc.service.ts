import { Injectable, inject } from '@angular/core';
import type {
  OperatorProjectSummary,
  OperatorEvent,
  OperatorRunSummary,
  OperatorSendMessageRequest,
  OperatorSendMessageResult,
  OperatorThreadResult,
} from '../../../../../shared/types/operator.types';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class OperatorIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  async getThread(): Promise<IpcResponse<OperatorThreadResult>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.operatorGetThread({}) as Promise<IpcResponse<OperatorThreadResult>>;
  }

  async sendMessage(payload: OperatorSendMessageRequest): Promise<IpcResponse<OperatorSendMessageResult>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.operatorSendMessage(payload) as Promise<IpcResponse<OperatorSendMessageResult>>;
  }

  async listRuns(payload: { limit?: number } = {}): Promise<IpcResponse<OperatorRunSummary[]>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.operatorListRuns(payload) as Promise<IpcResponse<OperatorRunSummary[]>>;
  }

  async getRun(runId: string): Promise<IpcResponse<OperatorRunSummary | null>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.operatorGetRun({ runId }) as Promise<IpcResponse<OperatorRunSummary | null>>;
  }

  async cancelRun(runId: string): Promise<IpcResponse<OperatorThreadResult>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.operatorCancelRun({ runId }) as Promise<IpcResponse<OperatorThreadResult>>;
  }

  async retryRun(runId: string): Promise<IpcResponse<OperatorSendMessageResult>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.operatorRetryRun({ runId }) as Promise<IpcResponse<OperatorSendMessageResult>>;
  }

  async listProjects(payload: { limit?: number } = {}): Promise<IpcResponse<OperatorProjectSummary[]>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.operatorListProjects(payload) as Promise<IpcResponse<OperatorProjectSummary[]>>;
  }

  async rescanProjects(payload: { roots?: string[] } = {}): Promise<IpcResponse<OperatorProjectSummary[]>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.operatorRescanProjects(payload) as Promise<IpcResponse<OperatorProjectSummary[]>>;
  }

  onEvent(callback: (event: OperatorEvent) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onOperatorEvent(callback as (data: unknown) => void);
  }
}
