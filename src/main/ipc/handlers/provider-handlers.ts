/**
 * Provider IPC Handlers
 * Handles provider configuration and model catalog requests
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import type { ProviderType } from '../../../shared/types/provider.types';
import { getProviderInstanceManager } from '../../providers';
import {
  getUnifiedModelCatalog,
  CATALOG_UPDATED_EVENT,
  type CatalogUpdatedPayload,
} from '../../providers/unified-model-catalog-service';
import {
  getLocalModelInventoryService,
  LOCAL_MODEL_INVENTORY_UPDATED_EVENT,
  type LocalModelInventoryUpdatedPayload,
} from '../../local-models/local-model-inventory-service';
import type { WindowManager } from '../../window-manager';
import { LocalReviewerQualificationController } from '../../review/local-reviewer-qualification-controller';
import { handleLocalReviewerQualification } from './local-reviewer-qualification-handler';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  ModelsCLIPushPayloadSchema,
  ProviderRunLoginPayloadSchema,
  ProviderStatusPayloadSchema,
  ProviderUpdateConfigPayloadSchema,
} from '@contracts/schemas/provider';
import { launchProviderLogin } from '../../providers/provider-login-launcher';

interface RegisterProviderHandlersDeps {
  windowManager: WindowManager;
  ensureAuthorized: (
    event: IpcMainInvokeEvent,
    channel: string,
    payload: unknown
  ) => IpcResponse | null;
}

export function registerProviderHandlers(
  deps: RegisterProviderHandlersDeps
): void {
  const registry = getProviderInstanceManager();
  const localModelInventory = getLocalModelInventoryService();
  const localReviewerQualification = new LocalReviewerQualificationController(localModelInventory);

  // ============================================
  // Provider Handlers
  // ============================================

  // List all provider configurations
  ipcMain.handle(
    IPC_CHANNELS.PROVIDER_LIST,
    async (): Promise<IpcResponse> => {
      try {
        const configs = registry.getAllConfigs();
        return {
          success: true,
          data: configs
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PROVIDER_LIST_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get status of a specific provider
  ipcMain.handle(
    IPC_CHANNELS.PROVIDER_STATUS,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(ProviderStatusPayloadSchema, payload, 'PROVIDER_STATUS');
        const status = await registry.checkProviderStatus(
          validated.providerType as ProviderType,
          validated.forceRefresh
        );
        return {
          success: true,
          data: status
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PROVIDER_STATUS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get status of all providers
  ipcMain.handle(
    IPC_CHANNELS.PROVIDER_STATUS_ALL,
    async (): Promise<IpcResponse> => {
      try {
        const statuses = await registry.checkAllProviderStatus();
        // Convert Map to object for IPC
        const statusObj: Record<string, unknown> = {};
        for (const [type, status] of statuses) {
          statusObj[type] = status;
        }
        return {
          success: true,
          data: statusObj
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PROVIDER_STATUS_ALL_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Update provider configuration
  ipcMain.handle(
    IPC_CHANNELS.PROVIDER_UPDATE_CONFIG,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const authError = deps.ensureAuthorized(
          event,
          IPC_CHANNELS.PROVIDER_UPDATE_CONFIG,
          payload
        );
        if (authError) return authError;
        const validated = validateIpcPayload(ProviderUpdateConfigPayloadSchema, payload, 'PROVIDER_UPDATE_CONFIG');
        registry.updateConfig(
          validated.providerType as ProviderType,
          validated.config
        );
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PROVIDER_UPDATE_CONFIG_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Open a terminal running the provider's interactive sign-in command.
  // Provider logins need a TTY and a browser round-trip, so the app hands the
  // user a ready-to-go terminal instead of asking them to recall the command.
  ipcMain.handle(
    IPC_CHANNELS.PROVIDER_RUN_LOGIN,
    async (
      event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const authError = deps.ensureAuthorized(
          event,
          IPC_CHANNELS.PROVIDER_RUN_LOGIN,
          payload
        );
        if (authError) return authError;
        const validated = validateIpcPayload(ProviderRunLoginPayloadSchema, payload, 'PROVIDER_RUN_LOGIN');
        return {
          success: true,
          data: await launchProviderLogin(validated.provider, validated.copilotProfile),
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'PROVIDER_RUN_LOGIN_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ============================================
  // Unified Model Catalog
  // ============================================

  // Read the full unified catalog (static, models.dev, overrides, custom, CLI).
  ipcMain.handle(
    IPC_CHANNELS.MODELS_UNIFIED_CATALOG,
    (): IpcResponse => {
      try {
        const catalog = getUnifiedModelCatalog();
        return {
          success: true,
          data: {
            models: catalog.getAllModels(),
            status: catalog.getCatalogStatus(),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MODELS_UNIFIED_CATALOG_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Read sanitized local model inventory (no endpoint URLs or credentials).
  ipcMain.handle(
    IPC_CHANNELS.MODELS_LOCAL_MODEL_INVENTORY,
    async (): Promise<IpcResponse> => {
      try {
        return {
          success: true,
          data: {
            models: await localModelInventory.refresh(),
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MODELS_LOCAL_MODEL_INVENTORY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MODELS_LOCAL_REVIEWER_QUALIFY,
    (event: IpcMainInvokeEvent, payload: unknown): Promise<IpcResponse> =>
      handleLocalReviewerQualification(
        event,
        payload,
        localReviewerQualification,
        deps.ensureAuthorized,
      ),
  );

  // Push renderer-side CLI-discovered models into the backend catalog.
  // The renderer runs dynamic-model-catalog.service; this bridges its results
  // into the main-process unified catalog so backend services (routing, cost
  // accounting) can see live models without querying the renderer.
  ipcMain.handle(
    IPC_CHANNELS.MODELS_CLI_PUSH,
    (_event: IpcMainInvokeEvent, payload: unknown): IpcResponse => {
      try {
        const validated = validateIpcPayload(ModelsCLIPushPayloadSchema, payload, 'MODELS_CLI_PUSH');
        getUnifiedModelCatalog().onCliDiscoveryRefreshed(validated.provider, validated.models);
        return { success: true };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'MODELS_CLI_PUSH_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Forward unified-catalog refreshes to the renderer (A1 consume-half) so a
  // UnifiedCatalogStore can live-refresh pickers when models.dev/CLI discovery
  // updates the catalog. The payload mirrors CatalogUpdatedPayload.
  getUnifiedModelCatalog().on(
    CATALOG_UPDATED_EVENT,
    (payload: CatalogUpdatedPayload) => {
      deps.windowManager.sendToRenderer(IPC_CHANNELS.MODELS_CATALOG_UPDATED, payload);
    },
  );

  localModelInventory.on(
    LOCAL_MODEL_INVENTORY_UPDATED_EVENT,
    (payload: LocalModelInventoryUpdatedPayload) => {
      getUnifiedModelCatalog().onLocalModelInventoryRefreshed(payload.models);
      deps.windowManager.sendToRenderer(IPC_CHANNELS.MODELS_LOCAL_MODEL_INVENTORY_UPDATED, payload);
    },
  );
}
