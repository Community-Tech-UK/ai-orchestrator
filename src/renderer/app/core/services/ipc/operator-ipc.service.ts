import { Injectable, inject } from '@angular/core';
import type { ConversationLedgerConversation } from '../../../../../shared/types/conversation-ledger.types';
import type {
  OperatorProjectListQuery,
  OperatorProjectRecord,
  OperatorProjectRefreshOptions,
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

  async getThread(): Promise<IpcResponse<ConversationLedgerConversation>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.getOperatorThread({}) as Promise<IpcResponse<ConversationLedgerConversation>>;
  }

  async sendMessage(payload: {
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<IpcResponse<ConversationLedgerConversation>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.sendOperatorMessage(payload) as Promise<IpcResponse<ConversationLedgerConversation>>;
  }

  async listProjects(payload: OperatorProjectListQuery = {}): Promise<IpcResponse<OperatorProjectRecord[]>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.listOperatorProjects(payload) as Promise<IpcResponse<OperatorProjectRecord[]>>;
  }

  async rescanProjects(payload: OperatorProjectRefreshOptions = {}): Promise<IpcResponse<OperatorProjectRecord[]>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.rescanOperatorProjects(payload) as Promise<IpcResponse<OperatorProjectRecord[]>>;
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
}
