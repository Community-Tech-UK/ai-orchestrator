import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import {
  ModelDiscoverPayloadSchema,
  ModelEmptyPayloadSchema,
  ModelGetPayloadSchema,
  ModelProviderStatusPayloadSchema,
  ModelSelectPayloadSchema,
  ModelVerifyPayloadSchema,
} from '@contracts/schemas/provider';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import {
  getModelDiscoveryService,
  type DiscoveredModel,
  type ProviderModelConfig,
} from '../providers/model-discovery';
import { getUnifiedModelCatalog } from '../providers/unified-model-catalog-service';
import type { UnifiedModelEntry } from '../../shared/types/unified-model-catalog.types';
import { registerModelOverrideHandlers } from './model-override-ipc-handlers';
import { validatedHandler, type IpcResponse } from './validated-handler';

export interface ModelDiscoveryHandlerDeps {
  ensureTrustedSender?: (
    event: IpcMainInvokeEvent,
    channel: string,
  ) => IpcResponse | null;
}

export function registerModelDiscoveryHandlers(deps: ModelDiscoveryHandlerDeps = {}): void {
  const discoveryService = getModelDiscoveryService();

  registerModelHandler(
    IPC_CHANNELS.MODEL_DISCOVER,
    ModelDiscoverPayloadSchema,
    async (config) => {
      if (!hasProviderModelConfig(config)) {
        return getUnifiedCatalogModelsForLegacyDiscovery();
      }
      return discoveryService.discoverModels(normalizeProviderModelConfig(config));
    },
    deps,
  );

  registerModelHandler(
    IPC_CHANNELS.MODEL_GET_ALL,
    ModelDiscoverPayloadSchema,
    async (config) => {
      if (!hasProviderModelConfig(config)) {
        return getUnifiedCatalogModelsForLegacyDiscovery();
      }
      return discoveryService.discoverModels(normalizeProviderModelConfig(config));
    },
    deps,
  );

  registerModelHandler(
    IPC_CHANNELS.MODEL_GET,
    ModelGetPayloadSchema,
    async (payload) => {
      if (!hasProviderModelConfig(payload.config)) {
        const entry = getUnifiedModelCatalog().getModel(payload.modelId);
        return entry ? toLegacyDiscoveredModel(entry) : undefined;
      }
      return discoveryService.getModelDetails(
        normalizeProviderModelConfig(payload.config),
        payload.modelId,
      );
    },
    deps,
  );

  registerModelHandler(
    IPC_CHANNELS.MODEL_SELECT,
    ModelSelectPayloadSchema,
    async (payload) => {
      const models = hasProviderModelConfig(payload?.config)
        ? await discoveryService.discoverModels(normalizeProviderModelConfig(payload.config))
        : getUnifiedCatalogModelsForLegacyDiscovery();
      return selectBestDiscoveredModel(models, payload?.criteria);
    },
    deps,
  );

  ipcMain.handle(
    IPC_CHANNELS.MODEL_CONFIGURE_PROVIDER,
    validatedHandler(
      IPC_CHANNELS.MODEL_CONFIGURE_PROVIDER,
      ModelDiscoverPayloadSchema,
      async () => ({
        success: false,
        error: {
          code: 'MODEL_CONFIGURE_PROVIDER_UNSUPPORTED',
          message: 'Provider configuration is managed through provider settings; use provider:update-config.',
          timestamp: Date.now(),
        },
      }),
      {
        ensureTrustedSender: deps.ensureTrustedSender,
        errorCode: 'MODEL_CONFIGURE_PROVIDER_FAILED',
      },
    ),
  );

  registerModelHandler(
    IPC_CHANNELS.MODEL_GET_PROVIDER_STATUS,
    ModelProviderStatusPayloadSchema,
    async (config) => {
      const providerConfig = normalizeProviderModelConfig(config);
      const models = await discoveryService.discoverModels(providerConfig);
      const availableModels = models.filter((model) => model.isAvailable).length;
      return {
        provider: providerConfig.type,
        enabled: providerConfig.type.length > 0,
        configured: isProviderConfigured(providerConfig),
        connected: availableModels > 0,
        totalModels: models.length,
        availableModels,
        lastChecked: latestModelCheck(models),
      };
    },
    deps,
  );

  registerModelHandler(
    IPC_CHANNELS.MODEL_GET_STATS,
    ModelEmptyPayloadSchema,
    () => {
      const models = getUnifiedModelCatalog().getAllModels();
      const providers = new Set(models.map((model) => model.provider));
      return {
        totalProviders: providers.size,
        enabledProviders: providers.size,
        connectedProviders: providers.size,
        totalModels: models.length,
        availableModels: models.length,
      };
    },
    deps,
  );

  ipcMain.handle(
    IPC_CHANNELS.MODEL_VERIFY,
    validatedHandler(
      IPC_CHANNELS.MODEL_VERIFY,
      ModelVerifyPayloadSchema,
      async (payload) => {
        const available = !hasProviderModelConfig(payload.config)
          ? getUnifiedModelCatalog().getModel(payload.modelId) !== undefined
          : await discoveryService.isModelAvailable(
            normalizeProviderModelConfig(payload.config),
            payload.modelId,
          );
        return available
          ? { success: true, data: true }
          : {
            success: false,
            data: false,
            error: {
              code: 'MODEL_NOT_AVAILABLE',
              message: 'Model is not available.',
              timestamp: Date.now(),
            },
          };
      },
      {
        ensureTrustedSender: deps.ensureTrustedSender,
        errorCode: 'MODEL_VERIFY_FAILED',
      },
    ),
  );

  registerModelOverrideHandlers(deps);
}

function registerModelHandler<TPayload, TResult>(
  channel: string,
  schema: z.ZodSchema<TPayload>,
  call: (payload: TPayload) => TResult | Promise<TResult>,
  deps: ModelDiscoveryHandlerDeps,
): void {
  ipcMain.handle(
    channel,
    validatedHandler(
      channel,
      schema,
      async (payload) => {
        const data = await call(payload);
        return data === undefined
          ? { success: true }
          : { success: true, data };
      },
      {
        ensureTrustedSender: deps.ensureTrustedSender,
        errorCode: `${channel.replace(/[:-]/g, '_').toUpperCase()}_FAILED`,
      },
    ),
  );
}

function hasProviderModelConfig(config: ProviderModelConfig | undefined): config is ProviderModelConfig {
  return typeof config?.type === 'string' && config.type.trim().length > 0;
}

function normalizeProviderModelConfig(config: ProviderModelConfig): ProviderModelConfig {
  return {
    type: typeof config?.type === 'string' ? config.type.trim() : '',
    ...(typeof config?.apiKey === 'string' && config.apiKey.trim()
      ? { apiKey: config.apiKey.trim() }
      : {}),
    ...(typeof config?.baseUrl === 'string' && config.baseUrl.trim()
      ? { baseUrl: config.baseUrl.trim() }
      : {}),
    ...(typeof config?.organizationId === 'string' && config.organizationId.trim()
      ? { organizationId: config.organizationId.trim() }
      : {}),
  };
}

function getUnifiedCatalogModelsForLegacyDiscovery(): DiscoveredModel[] {
  return getUnifiedModelCatalog().getAllModels().map(toLegacyDiscoveredModel);
}

function toLegacyDiscoveredModel(entry: UnifiedModelEntry): DiscoveredModel {
  const result: DiscoveredModel = {
    id: entry.id,
    name: entry.name ?? entry.id,
    displayName: entry.name ?? entry.id,
    provider: entry.provider,
    isAvailable: true,
    lastChecked: entry.discoveredAt,
  };
  if (entry.contextWindow !== undefined) {
    result.contextLength = entry.contextWindow;
  }
  if (entry.maxOutputTokens !== undefined) {
    result.maxOutputTokens = entry.maxOutputTokens;
  }
  if (entry.pricing) {
    result.pricing = {
      inputPer1kTokens: entry.pricing.inputPerMillion / 1000,
      outputPer1kTokens: entry.pricing.outputPerMillion / 1000,
      currency: 'USD',
    };
  }
  return result;
}

function isProviderConfigured(config: ProviderModelConfig): boolean {
  return Boolean(config.apiKey || config.baseUrl || config.type === 'ollama');
}

function latestModelCheck(models: { lastChecked?: number }[]): number | null {
  const latest = Math.max(0, ...models.map((model) => model.lastChecked ?? 0));
  return latest > 0 ? latest : null;
}

function selectBestDiscoveredModel<T extends {
  capabilities?: object;
  isAvailable: boolean;
}>(
  models: T[],
  criteria: { capabilities?: string[] } = {},
): T | null {
  const available = models.filter((model) => model.isAvailable);
  const requiredCapabilities = (criteria.capabilities ?? [])
    .map((capability) => capability.trim())
    .filter(Boolean);

  if (requiredCapabilities.length > 0) {
    const match = available.find((model) => hasCapabilities(model, requiredCapabilities));
    if (match) {
      return match;
    }
  }

  return available[0] ?? models[0] ?? null;
}

function hasCapabilities(
  model: { capabilities?: object },
  requiredCapabilities: string[],
): boolean {
  const capabilities = model.capabilities as Record<string, unknown> | undefined;
  return requiredCapabilities.every((capability) => capabilities?.[capability] === true);
}
