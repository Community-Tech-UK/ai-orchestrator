/**
 * Provider Quota IPC Handlers
 *
 * Exposes the ProviderQuotaService over IPC and forwards its events
 * (`quota-updated`, `quota-warning`, `quota-pacing-warning`,
 * `quota-exhausted`) to the renderer.
 *
 * Mirrors the structure of cost-handlers.ts.
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  QuotaGetAllPayloadSchema,
  QuotaGetProviderPayloadSchema,
  QuotaRefreshPayloadSchema,
  QuotaRefreshAllPayloadSchema,
  QuotaSetPollIntervalPayloadSchema,
} from '@contracts/schemas/quota';
import { getProviderQuotaService } from '../../core/system/provider-quota-service';
import type { WindowManager } from '../../window-manager';
import { getNotificationService, type NotificationInput } from '../../notifications/notification-service';
import type { ProviderQuotaPacingAlert } from '../../../shared/types/provider-quota.types';

/**
 * Fable WS2 Task 4: an early pacing warning is operator-actionable ("this
 * window will exhaust before it resets — slow down or switch provider"), so it
 * goes through the WS10 notification service (fingerprint-deduped per
 * provider+window) in addition to the renderer badge. Pure builder, exported
 * for the spec.
 */
export function buildQuotaPacingNotification(alert: ProviderQuotaPacingAlert): NotificationInput {
  return {
    kind: 'quota-pacing',
    title: `${alert.provider} quota pacing warning`,
    body:
      `${alert.window.label}: ${Math.round(alert.utilizationPercent)}% used with only ` +
      `${Math.round(alert.elapsedPercent)}% of the window elapsed — on pace to exhaust before reset.`,
    urgency: 'normal',
    fingerprintFields: { provider: alert.provider, windowId: alert.window.id },
  };
}

export function registerQuotaHandlers(deps: {
  windowManager: WindowManager;
}): void {
  const quotaService = getProviderQuotaService();

  // ============================================
  // Read handlers
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.QUOTA_GET_ALL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        validateIpcPayload(QuotaGetAllPayloadSchema, payload, 'QUOTA_GET_ALL');
        return { success: true, data: quotaService.getAll() };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'QUOTA_GET_ALL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.QUOTA_GET_PROVIDER,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          QuotaGetProviderPayloadSchema,
          payload,
          'QUOTA_GET_PROVIDER',
        );
        return { success: true, data: quotaService.getSnapshot(validated.provider) };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'QUOTA_GET_PROVIDER_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  // ============================================
  // Action handlers
  // ============================================

  ipcMain.handle(
    IPC_CHANNELS.QUOTA_REFRESH,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          QuotaRefreshPayloadSchema,
          payload,
          'QUOTA_REFRESH',
        );
        const snapshot = await quotaService.refresh(validated.provider);
        return { success: true, data: snapshot };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'QUOTA_REFRESH_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.QUOTA_REFRESH_ALL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        validateIpcPayload(QuotaRefreshAllPayloadSchema, payload, 'QUOTA_REFRESH_ALL');
        const snapshots = await quotaService.refreshAll();
        return { success: true, data: snapshots };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'QUOTA_REFRESH_ALL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.QUOTA_SET_POLL_INTERVAL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(
          QuotaSetPollIntervalPayloadSchema,
          payload,
          'QUOTA_SET_POLL_INTERVAL',
        );
        quotaService.startPolling(validated.provider, validated.intervalMs);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'QUOTA_SET_POLL_INTERVAL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  // ============================================
  // Event Forwarding to Renderer
  // ============================================

  quotaService.on('quota-updated', (snapshot) => {
    deps.windowManager.sendToRenderer(IPC_CHANNELS.QUOTA_UPDATED, snapshot);
  });

  quotaService.on('quota-warning', (alert) => {
    deps.windowManager.sendToRenderer(IPC_CHANNELS.QUOTA_WARNING, alert);
  });

  quotaService.on('quota-pacing-warning', (alert) => {
    deps.windowManager.sendToRenderer(IPC_CHANNELS.QUOTA_PACING_WARNING, alert);
    // WS2 Task 4: also raise a deduped operator notification (WS10 service).
    try {
      getNotificationService().notify(buildQuotaPacingNotification(alert));
    } catch {
      // Notification failure must never break quota event forwarding.
    }
  });

  quotaService.on('quota-exhausted', (alert) => {
    deps.windowManager.sendToRenderer(IPC_CHANNELS.QUOTA_EXHAUSTED, alert);
  });
}
