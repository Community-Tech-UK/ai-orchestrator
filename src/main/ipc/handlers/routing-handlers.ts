/**
 * Routing IPC Handlers
 * Handles model routing configuration and hot model switching requests
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { getLogger } from '../../logging/logger';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { getModelRouter } from '../../routing/model-router';
import { getHotModelSwitcher } from '../../routing/hot-model-switcher';

const logger = getLogger('RoutingHandlers');

// Routing config and hot-switcher config are open-ended; validate the payload
// is a plain object and let the underlying service handle field-level checks.
const ConfigUpdatePayloadSchema = z.record(z.string(), z.unknown());

const RoutingPreviewPayloadSchema = z.object({
  task: z.string().min(1).max(50_000),
});

const RoutingGetTierPayloadSchema = z.object({
  modelId: z.string().min(1).max(200),
});

export function registerRoutingHandlers(): void {

  // ============================================
  // Model Router Handlers
  // ============================================

  // Get current routing configuration
  ipcMain.handle(
    IPC_CHANNELS.ROUTING_GET_CONFIG,
    async (): Promise<IpcResponse> => {
      try {
        const config = getModelRouter().getConfig();
        return {
          success: true,
          data: config
        };
      } catch (error) {
        logger.error('Failed to get routing config', error as Error);
        return {
          success: false,
          error: {
            code: 'ROUTING_GET_CONFIG_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Update routing configuration
  ipcMain.handle(
    IPC_CHANNELS.ROUTING_UPDATE_CONFIG,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const config = ConfigUpdatePayloadSchema.parse(payload);
        getModelRouter().updateConfig(
          config as Parameters<ReturnType<typeof getModelRouter>['updateConfig']>[0]
        );
        return {
          success: true,
          data: getModelRouter().getConfig()
        };
      } catch (error) {
        logger.error('Failed to update routing config', error as Error);
        return {
          success: false,
          error: {
            code: 'ROUTING_UPDATE_CONFIG_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Preview routing decision for a task
  ipcMain.handle(
    IPC_CHANNELS.ROUTING_PREVIEW,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const { task } = RoutingPreviewPayloadSchema.parse(payload);
        const router = getModelRouter();
        const decision = router.route(task);
        const explanation = router.getRoutingExplanation(task, decision);

        return {
          success: true,
          data: { decision, explanation }
        };
      } catch (error) {
        logger.error('Failed to preview routing decision', error as Error);
        return {
          success: false,
          error: {
            code: 'ROUTING_PREVIEW_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get model tier for a given model ID
  ipcMain.handle(
    IPC_CHANNELS.ROUTING_GET_TIER,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const { modelId } = RoutingGetTierPayloadSchema.parse(payload);
        const tier = getModelRouter().getModelTier(modelId);
        return {
          success: true,
          data: { modelId, tier }
        };
      } catch (error) {
        logger.error('Failed to get model tier', error as Error);
        return {
          success: false,
          error: {
            code: 'ROUTING_GET_TIER_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Hot Model Switcher Handlers
  // ============================================

  // Get hot switcher configuration
  ipcMain.handle(
    IPC_CHANNELS.HOT_SWITCH_GET_CONFIG,
    async (): Promise<IpcResponse> => {
      try {
        const config = getHotModelSwitcher().getConfig();
        return {
          success: true,
          data: config
        };
      } catch (error) {
        logger.error('Failed to get hot switcher config', error as Error);
        return {
          success: false,
          error: {
            code: 'HOT_SWITCH_GET_CONFIG_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Update hot switcher configuration
  ipcMain.handle(
    IPC_CHANNELS.HOT_SWITCH_UPDATE_CONFIG,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const config = ConfigUpdatePayloadSchema.parse(payload);
        getHotModelSwitcher().configure(
          config as Parameters<ReturnType<typeof getHotModelSwitcher>['configure']>[0]
        );
        return {
          success: true,
          data: getHotModelSwitcher().getConfig()
        };
      } catch (error) {
        logger.error('Failed to update hot switcher config', error as Error);
        return {
          success: false,
          error: {
            code: 'HOT_SWITCH_UPDATE_CONFIG_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Perform a hot model switch (stub - requires InstanceManager wiring)
  ipcMain.handle(
    IPC_CHANNELS.HOT_SWITCH_PERFORM,
    async (): Promise<IpcResponse> => {
      return {
        success: false,
        error: {
          code: 'NOT_IMPLEMENTED',
          message: 'Hot switch requires InstanceManager wiring - use instance:change-model for now',
          timestamp: Date.now()
        }
      };
    }
  );

  // Get hot switcher statistics
  ipcMain.handle(
    IPC_CHANNELS.HOT_SWITCH_GET_STATS,
    async (): Promise<IpcResponse> => {
      try {
        const stats = getHotModelSwitcher().getStats();
        return {
          success: true,
          data: stats
        };
      } catch (error) {
        logger.error('Failed to get hot switcher stats', error as Error);
        return {
          success: false,
          error: {
            code: 'HOT_SWITCH_GET_STATS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );
}
