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
import { getCostTracker, type BudgetAlert, type CostEntry } from '../../core/system/cost-tracker';
import { WindowManager } from '../../window-manager';
import { getRLMDatabase } from '../../persistence/rlm-database';
import { getLogger } from '../../logging/logger';

const logger = getLogger('CostHandlers');

// Renderer-facing push channels for budget alerts. The CostTracker emits a single
// `budget-alert` domain event; the preload bridge (infrastructure.preload.ts) splits
// it into warning vs exceeded listeners, so the main side forwards on these two
// channels. (`cost:usage-recorded` has a generated constant; these two do not.)
const COST_BUDGET_WARNING_CHANNEL = 'cost:budget-warning';
const COST_BUDGET_EXCEEDED_CHANNEL = 'cost:budget-exceeded';

export function registerCostHandlers(deps: {
  windowManager: WindowManager;
}): void {
  const costTracker = getCostTracker();

  // Wire the RLM database so cost history persists across restarts (best-effort).
  try {
    costTracker.setDatabase(getRLMDatabase().getRawDb());
  } catch (err) {
    logger.warn('Could not wire RLM database to CostTracker — cost history will be in-memory only', {
      error: String(err),
    });
  }

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
          validated.cacheWriteTokens,
          undefined,
          validated.reasoningTokens
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

  const sendToRenderer = (channel: string, data: unknown): void => {
    deps.windowManager.sendToRenderer(channel, data);
  };

  // Live usage: the tracker emits `cost-recorded` on every recorded turn. The
  // renderer cost page refreshes its summary/entries in response (the 10s poll is
  // only a fallback). Earlier this listened to a non-existent `usage-recorded`
  // event, so live updates never reached the renderer.
  costTracker.on('cost-recorded', (entry: CostEntry) => {
    sendToRenderer(IPC_CHANNELS.COST_USAGE_RECORDED, entry);
  });

  // Budget alerts: the tracker emits a single `budget-alert` carrying the breached
  // threshold (a percentage). Classify warning (<100%) vs exceeded (>=100% or over
  // the limit) and forward on the two channels the preload bridge listens to, with a
  // human-readable `message` the renderer renders. Earlier this listened to
  // non-existent `budget-warning`/`budget-exceeded` events, so alerts never fired.
  costTracker.on('budget-alert', (alert: BudgetAlert) => {
    const exceeded = alert.currentUsage >= alert.limit || alert.threshold >= 100;
    const message =
      `${alert.type} budget at ${Math.round(alert.threshold)}% ` +
      `($${alert.currentUsage.toFixed(2)} of $${alert.limit.toFixed(2)})`;
    const payload = { ...alert, message, exceeded };
    sendToRenderer(exceeded ? COST_BUDGET_EXCEEDED_CHANNEL : COST_BUDGET_WARNING_CHANNEL, payload);
  });
}
