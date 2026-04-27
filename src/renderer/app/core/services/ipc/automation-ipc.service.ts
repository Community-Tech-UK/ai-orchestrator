import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, type IpcResponse } from './electron-ipc.service';
import type {
  CreateAutomationInput,
  UpdateAutomationInput,
} from '../../../../../shared/types/automation.types';

@Injectable({ providedIn: 'root' })
export class AutomationIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  private get ngZone() {
    return this.base.getNgZone();
  }

  async list(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationList();
  }

  async get(id: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationGet({ id });
  }

  async create(payload: CreateAutomationInput): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationCreate(payload);
  }

  async update(id: string, updates: UpdateAutomationInput): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationUpdate({ id, updates });
  }

  async delete(id: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationDelete({ id });
  }

  async runNow(id: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationRunNow({ id });
  }

  async cancelPending(id: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationCancelPending({ id });
  }

  async listRuns(payload: { automationId?: string; limit?: number } = {}): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationListRuns(payload);
  }

  async markSeen(payload: { automationId?: string; runId?: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.automationMarkSeen(payload);
  }

  onChanged(callback: (event: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onAutomationChanged((event) => {
      this.ngZone.run(() => callback(event));
    });
  }

  onRunChanged(callback: (event: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onAutomationRunChanged((event) => {
      this.ngZone.run(() => callback(event));
    });
  }
}
