/**
 * Plan Mode IPC Service - Plan mode operations
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class PlanModeIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  // ============================================
  // Plan Mode
  // ============================================

  /**
   * Enter plan mode (read-only exploration)
   */
  async enterPlanMode(instanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.enterPlanMode(instanceId);
  }

  /**
   * Exit plan mode
   */
  async exitPlanMode(instanceId: string, force?: boolean): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.exitPlanMode(instanceId, force);
  }

  /**
   * Approve a plan (allows transition to implementation)
   */
  async approvePlan(instanceId: string, planContent?: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.approvePlan(instanceId, planContent);
  }

  /**
   * Update plan content
   */
  async updatePlanContent(instanceId: string, planContent: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.updatePlanContent(instanceId, planContent);
  }

  /**
   * Get plan mode state
   */
  async getPlanModeState(instanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.getPlanModeState(instanceId);
  }

  async previewPlanHandoff(instanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.previewPlanHandoff(instanceId);
  }

  async startPlanHandoff(payload: {
    instanceId: string;
    requestId?: string;
    planText?: string;
    model?: string;
    idempotencyKey?: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.startPlanHandoff(payload);
  }
}
