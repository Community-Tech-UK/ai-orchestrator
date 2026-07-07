import { Injectable, inject } from '@angular/core';
import type {
  OperatorRunEventNotification,
  OperatorRunGraph,
  OperatorRunRecord,
  OperatorRunStatus,
  OperatorProjectRecord,
  OperatorProjectResolution,
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

  async listProjects(payload: {
    query?: string;
    limit?: number;
  } = {}): Promise<IpcResponse<OperatorProjectRecord[]>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.listOperatorProjects(payload) as Promise<IpcResponse<OperatorProjectRecord[]>>;
  }

  async rescanProjects(payload: {
    includeRecent?: boolean;
    includeActiveInstances?: boolean;
    includeConversationLedger?: boolean;
    roots?: string[];
  } = {}): Promise<IpcResponse<OperatorProjectRecord[]>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.rescanOperatorProjects(payload) as Promise<IpcResponse<OperatorProjectRecord[]>>;
  }

  async resolveProject(query: string): Promise<IpcResponse<OperatorProjectResolution>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.resolveOperatorProject({ query }) as Promise<IpcResponse<OperatorProjectResolution>>;
  }

  async planProjectVerification(projectPath: string): Promise<IpcResponse<unknown>> {
    if (!this.api) {
      return { success: false, error: { message: 'Not in Electron' } };
    }
    return this.api.planOperatorProjectVerification({ projectPath }) as Promise<IpcResponse<unknown>>;
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
