/**
 * Cost IPC Service - Cost tracking and budget operations
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class CostIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  private get ngZone() {
    return this.base.getNgZone();
  }

  // ============================================
  // Cost Tracking
  // ============================================

  /**
   * Record token usage and cost
   */
  async costRecordUsage(
    instanceId: string,
    provider: string,
    model: string,
    inputTokens: number,
    outputTokens: number
  ): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.costRecordUsage(instanceId, provider, model, inputTokens, outputTokens);
  }

  /**
   * Get cost summary
   */
  async costGetSummary(instanceId?: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.costGetSummary(instanceId);
  }

  /**
   * Get cost history
   */
  async costGetHistory(instanceId?: string, limit?: number): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.costGetHistory(instanceId, limit);
  }

  /**
   * Get cost entries (raw CostEntry records, uses the registered COST_GET_ENTRIES handler)
   */
  async costGetEntries(limit?: number): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.costGetEntries(limit);
  }

  /**
   * Set budget limits
   */
  async costSetBudget(budget: {
    daily?: number;
    weekly?: number;
    monthly?: number;
    warningThreshold?: number;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.costSetBudget(budget);
  }

  /**
   * Get current budget status
   */
  async costGetBudgetStatus(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.costGetBudgetStatus();
  }

  /**
   * Listen for cost usage events
   */
  onCostUsageRecorded(callback: (data: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onCostUsageRecorded((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  /**
   * Listen for budget warning events
   */
  onCostBudgetWarning(callback: (data: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onCostBudgetWarning((data) => {
      this.ngZone.run(() => callback(data));
    });
  }

  /**
   * Listen for budget exceeded events
   */
  onCostBudgetExceeded(callback: (data: unknown) => void): () => void {
    if (!this.api) return () => { /* noop */ };
    return this.api.onCostBudgetExceeded((data) => {
      this.ngZone.run(() => callback(data));
    });
  }
}
