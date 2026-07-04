import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import {
  getModelDiscoveryService,
  type DiscoveredModel,
  type ProviderModelConfig,
} from '../providers/model-discovery';
import { getUnifiedModelCatalog } from '../providers/unified-model-catalog-service';
import type { UnifiedModelEntry } from '../../shared/types/unified-model-catalog.types';
import { registerModelOverrideHandlers } from './model-override-ipc-handlers';

export function registerModelDiscoveryHandlers(): void {
  const discoveryService = getModelDiscoveryService();

  ipcMain.handle(
    IPC_CHANNELS.MODEL_DISCOVER,
    async (_event, config: ProviderModelConfig | undefined) => {
      if (!hasProviderModelConfig(config)) {
        return getUnifiedCatalogModelsForLegacyDiscovery();
      }
      return discoveryService.discoverModels(normalizeProviderModelConfig(config));
    },
  );

  ipcMain.handle(IPC_CHANNELS.MODEL_GET_ALL, async (_event, config: ProviderModelConfig | undefined) => {
    if (!hasProviderModelConfig(config)) {
      return getUnifiedCatalogModelsForLegacyDiscovery();
    }
    return discoveryService.discoverModels(normalizeProviderModelConfig(config));
  });

  ipcMain.handle(
    IPC_CHANNELS.MODEL_GET,
    async (_event, payload: { config?: ProviderModelConfig; modelId?: unknown } | undefined) => {
      const modelId = readModelId(payload);
      if (!modelId) {
        return undefined;
      }
      if (!hasProviderModelConfig(payload?.config)) {
        const entry = getUnifiedModelCatalog().getModel(modelId);
        return entry ? toLegacyDiscoveredModel(entry) : undefined;
      }
      return discoveryService.getModelDetails(
        normalizeProviderModelConfig(payload.config),
        modelId,
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MODEL_SELECT,
    async (
      _event,
      payload: { config?: ProviderModelConfig; criteria?: { capabilities?: string[] } } | undefined,
    ) => {
      const models = hasProviderModelConfig(payload?.config)
        ? await discoveryService.discoverModels(normalizeProviderModelConfig(payload.config))
        : getUnifiedCatalogModelsForLegacyDiscovery();
      return selectBestDiscoveredModel(models, payload?.criteria);
    },
  );

  ipcMain.handle(IPC_CHANNELS.MODEL_CONFIGURE_PROVIDER, async () => {
    return {
      success: false,
      error: {
        code: 'MODEL_CONFIGURE_PROVIDER_UNSUPPORTED',
        message: 'Provider configuration is managed through provider settings; use provider:update-config.',
        timestamp: Date.now(),
      },
    };
  });

  ipcMain.handle(IPC_CHANNELS.MODEL_GET_PROVIDER_STATUS, async (_event, config: ProviderModelConfig) => {
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
  });

  ipcMain.handle(IPC_CHANNELS.MODEL_GET_STATS, async () => {
    const models = getUnifiedModelCatalog().getAllModels();
    const providers = new Set(models.map((model) => model.provider));
    return {
      totalProviders: providers.size,
      enabledProviders: providers.size,
      connectedProviders: providers.size,
      totalModels: models.length,
      availableModels: models.length,
    };
  });

  ipcMain.handle(
    IPC_CHANNELS.MODEL_VERIFY,
    async (_event, payload: { config?: ProviderModelConfig; modelId?: unknown } | undefined) => {
      const modelId = readModelId(payload);
      if (!modelId) {
        return false;
      }
      if (!hasProviderModelConfig(payload?.config)) {
        return getUnifiedModelCatalog().getModel(modelId) !== undefined;
      }
      return discoveryService.isModelAvailable(
        normalizeProviderModelConfig(payload.config),
        modelId,
      );
    },
  );

  registerModelOverrideHandlers();
}

function hasProviderModelConfig(config: ProviderModelConfig | undefined): config is ProviderModelConfig {
  return typeof config?.type === 'string' && config.type.trim().length > 0;
}

function readModelId(payload: { modelId?: unknown } | undefined): string | undefined {
  return typeof payload?.modelId === 'string' && payload.modelId.trim()
    ? payload.modelId.trim()
    : undefined;
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
