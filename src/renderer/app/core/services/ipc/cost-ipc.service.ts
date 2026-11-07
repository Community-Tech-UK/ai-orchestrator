/**
 * Cost IPC Service - Cost tracking and budget operations
 */

import type { CodexEphemeralUsageResult } from '../../../../../shared/types/codex-ephemeral-usage.types';
import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';
import type { CostPurposeRange, CostPurposeSummary } from '../../../../../shared/types/cost-purpose.types';
import type {
  CostRestoreInspection,
  CostRestoreRollbackSummary,
  CostRestoreSummary,
} from '../../../../../shared/types/cost-history-restore.types';
import type { SessionSpendBreakdown } from '../../../../../shared/types/cost-session.types';

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
    sessionId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens?: number,
    cacheWriteTokens?: number,
    reasoningTokens?: number
  ): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.costRecordUsage(
      instanceId,
      sessionId,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
    );
  }

  /**
   * Get cost summary
   */
  async costGetSummary(instanceId?: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.costGetSummary(instanceId);
  }
  async costGetEphemeralUsage(limit = 100): Promise<IpcResponse<CodexEphemeralUsageResult>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.costGetEphemeralUsage(limit);
  }
  async costGetPurposeSummary(range?: CostPurposeRange): Promise<IpcResponse<CostPurposeSummary>> {
    if (!this.api) return {success:false,error:{message:'Not in Electron'}};
    return this.api.costGetPurposeSummary(range);
  }

  async costGetSessionBreakdown(instanceId: string, sessionId?: string): Promise<IpcResponse<SessionSpendBreakdown>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.costGetSessionBreakdown(instanceId, sessionId);
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

  // ============================================
  // LT-707 cost history restoration (maintenance)
  // ============================================

  /** Read-only totals over the rows the restoration may repair. */
  async costHistoryRestoreStatus(): Promise<IpcResponse<CostRestoreInspection>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.costHistoryRestoreStatus();
  }

  /** Restore affected Claude turn costs from the A0 originals. */
  async costHistoryRestoreApply(): Promise<IpcResponse<CostRestoreSummary>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.costHistoryRestoreApply();
  }

  /** Undo the last restoration from its rollback snapshot. */
  async costHistoryRestoreRollback(): Promise<IpcResponse<CostRestoreRollbackSummary>> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.costHistoryRestoreRollback();
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
