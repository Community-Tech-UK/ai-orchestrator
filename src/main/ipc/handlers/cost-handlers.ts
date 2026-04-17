/**
 * Cost Tracking IPC Handlers
 * Handles cost recording, budget management, and cost reporting
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  CostClearEntriesPayloadSchema,
  CostGetBudgetPayloadSchema,
  CostGetBudgetStatusPayloadSchema,
  CostGetEntriesPayloadSchema,
  CostGetSessionCostPayloadSchema,
  CostGetSummaryPayloadSchema,
  CostRecordUsagePayloadSchema,
  CostSetBudgetPayloadSchema,
} from '@contracts/schemas/session';
import { getCostTracker } from '../../core/system/cost-tracker';
import { WindowManager } from '../../window-manager';

export function registerCostHandlers(deps: {
  windowManager: WindowManager;
}): void {
  const costTracker = getCostTracker();

  // ============================================
  // Cost Recording and Reporting
  // ============================================

  // Record usage
  ipcMain.handle(
    IPC_CHANNELS.COST_RECORD_USAGE,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CostRecordUsagePayloadSchema, payload, 'COST_RECORD_USAGE');
        costTracker.recordUsage(
          validated.instanceId,
          validated.sessionId,
          validated.model,
          validated.inputTokens,
          validated.outputTokens,
          validated.cacheReadTokens,
          validated.cacheWriteTokens
        );
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'COST_RECORD_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get summary
  ipcMain.handle(
    IPC_CHANNELS.COST_GET_SUMMARY,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CostGetSummaryPayloadSchema, payload, 'COST_GET_SUMMARY');
        const summary = costTracker.getSummary(
          validated?.startTime,
          validated?.endTime
        );
        return { success: true, data: summary };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'COST_GET_SUMMARY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get session cost
  ipcMain.handle(
    IPC_CHANNELS.COST_GET_SESSION_COST,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CostGetSessionCostPayloadSchema, payload, 'COST_GET_SESSION_COST');
        const cost = costTracker.getSessionCost(validated.sessionId);
        return { success: true, data: cost };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'COST_GET_SESSION_COST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Budget Management
  // ============================================

  // Get budget
  ipcMain.handle(
    IPC_CHANNELS.COST_GET_BUDGET,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        validateIpcPayload(CostGetBudgetPayloadSchema, payload, 'COST_GET_BUDGET');
        const budget = costTracker.getBudget();
        return { success: true, data: budget };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'COST_GET_BUDGET_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Set budget
  ipcMain.handle(
    IPC_CHANNELS.COST_SET_BUDGET,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CostSetBudgetPayloadSchema, payload, 'COST_SET_BUDGET');
        const { ipcAuthToken: _token, ...budgetConfig } = validated;
        costTracker.setBudget(budgetConfig);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'COST_SET_BUDGET_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get budget status
  ipcMain.handle(
    IPC_CHANNELS.COST_GET_BUDGET_STATUS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        validateIpcPayload(CostGetBudgetStatusPayloadSchema, payload, 'COST_GET_BUDGET_STATUS');
        const status = costTracker.getBudgetStatus();
        return { success: true, data: status };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'COST_GET_BUDGET_STATUS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Cost Entry Management
  // ============================================

  // Get entries
  ipcMain.handle(
    IPC_CHANNELS.COST_GET_ENTRIES,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(CostGetEntriesPayloadSchema, payload, 'COST_GET_ENTRIES');
        const entries = costTracker.getEntries(validated?.limit);
        return { success: true, data: entries };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'COST_GET_ENTRIES_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Clear entries
  ipcMain.handle(
    IPC_CHANNELS.COST_CLEAR_ENTRIES,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        validateIpcPayload(CostClearEntriesPayloadSchema, payload, 'COST_CLEAR_ENTRIES');
        costTracker.clearEntries();
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'COST_CLEAR_ENTRIES_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Event Forwarding to Renderer
  // ============================================

  // Forward cost events to renderer
  costTracker.on('usage-recorded', (data) => {
    deps.windowManager
      .getMainWindow()
      ?.webContents.send(IPC_CHANNELS.COST_USAGE_RECORDED, data);
  });

  costTracker.on('budget-warning', (data) => {
    deps.windowManager
      .getMainWindow()
      ?.webContents.send(IPC_CHANNELS.COST_BUDGET_ALERT, data);
  });

  costTracker.on('budget-exceeded', (data) => {
    deps.windowManager
      .getMainWindow()
      ?.webContents.send(IPC_CHANNELS.COST_BUDGET_ALERT, data);
  });
}
