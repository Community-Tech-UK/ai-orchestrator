import { describe, expect, it, vi } from 'vitest';
import { initializeUnifiedModelCatalogRuntime } from './unified-model-catalog-initialization';
import type { CatalogOverrideEntry } from '../providers/catalog-override-source';
import type { LocalModelInventoryEntry } from '../../shared/types/local-model-runtime.types';

describe('initializeUnifiedModelCatalogRuntime', () => {
  it('loads override sources before attaching them to the catalog', async () => {
    const events: string[] = [];
    const localEntry = overrideEntry('claude', 'claude-local-opus', 'local');
    const remoteEntry = overrideEntry('gemini', 'gemini-remote-pro', 'remote');
    const source = {
      entries: [] as CatalogOverrideEntry[],
      async startLocal(): Promise<void> {
        events.push('startLocal');
        this.entries = [localEntry];
      },
      async attachSettingsManager(): Promise<void> {
        events.push('attachSettingsManager');
        this.entries = [...this.entries, remoteEntry];
      },
      getEntries(): CatalogOverrideEntry[] {
        return this.entries;
      },
      on: vi.fn(),
    };
    let attachedEntries: CatalogOverrideEntry[] = [];
    const catalog = {
      attachSettingsManager: vi.fn(() => {
        events.push('catalogSettings');
      }),
      attachCatalogOverrideSource: vi.fn((attachedSource: { getEntries: () => CatalogOverrideEntry[] }) => {
        events.push('catalogOverride');
        attachedEntries = attachedSource.getEntries();
      }),
    };
    const modelsDev = {
      loadOfflineSnapshot: vi.fn(() => {
        events.push('offlineSnapshot');
      }),
      refresh: vi.fn(async () => false),
    };
    const codexDiscovery = {
      start: vi.fn(() => {
        events.push('codexDiscovery');
      }),
    };
    const cursorCopilotDiscovery = {
      start: vi.fn(() => {
        events.push('cursorCopilotDiscovery');
      }),
    };

    await initializeUnifiedModelCatalogRuntime({
      userDataPath: '/tmp/aio-user-data',
      settingsManager: { get: vi.fn(), on: vi.fn() },
      catalog,
      catalogOverrideSource: source,
      modelsDevService: modelsDev,
      codexDiscoveryService: codexDiscovery,
      cursorCopilotDiscoveryService: cursorCopilotDiscovery,
      localModelInventoryService: localModelInventoryService(),
      logger: { warn: vi.fn() },
    });

    expect(events.slice(0, 5)).toEqual([
      'offlineSnapshot',
      'catalogSettings',
      'startLocal',
      'attachSettingsManager',
      'catalogOverride',
    ]);
    expect(codexDiscovery.start).toHaveBeenCalledOnce();
    expect(cursorCopilotDiscovery.start).toHaveBeenCalledOnce();
    expect(attachedEntries.map((entry) => `${entry.provider}:${entry.id}`)).toEqual([
      'claude:claude-local-opus',
      'gemini:gemini-remote-pro',
    ]);
  });

  it('refreshes local model inventory before seeding the catalog', async () => {
    const refreshed: LocalModelInventoryEntry[] = [{
      selectorId: 'lm://this-device/ollama/ollama/llama3.2',
      source: 'this-device',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'llama3.2',
      displayName: 'llama3.2 on This device',
      healthy: true,
      loaded: false,
      capabilities: {
        streaming: true,
        multiTurn: true,
        toolUse: 'none',
        vision: 'unknown',
      },
      discoveredAt: 1783468800000,
    }];
    const catalog = {
      attachSettingsManager: vi.fn(),
      attachCatalogOverrideSource: vi.fn(),
      onLocalModelInventoryRefreshed: vi.fn(),
    };
    const localModelInventoryService = {
      list: vi.fn(() => []),
      refresh: vi.fn(async () => refreshed),
      on: vi.fn(),
    };

    await initializeUnifiedModelCatalogRuntime({
      userDataPath: '/tmp/aio-user-data',
      settingsManager: { get: vi.fn(), on: vi.fn() },
      catalog,
      catalogOverrideSource: catalogOverrideSource(),
      modelsDevService: modelsDevService(),
      codexDiscoveryService: { start: vi.fn() },
      cursorCopilotDiscoveryService: { start: vi.fn() },
      localModelInventoryService,
      logger: { warn: vi.fn() },
    });

    expect(localModelInventoryService.refresh).toHaveBeenCalledOnce();
    expect(catalog.onLocalModelInventoryRefreshed).toHaveBeenCalledWith(
      refreshed,
      { immediate: true },
    );
  });

  it('falls back to cached local model inventory when refresh fails', async () => {
    const cached: LocalModelInventoryEntry[] = [{
      selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
      source: 'worker-node',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'qwen',
      displayName: 'qwen on windows-pc',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      healthy: true,
      loaded: false,
      capabilities: {
        streaming: true,
        multiTurn: true,
        toolUse: 'none',
        vision: 'unknown',
      },
      discoveredAt: 1783468800000,
    }];
    const catalog = {
      attachSettingsManager: vi.fn(),
      attachCatalogOverrideSource: vi.fn(),
      onLocalModelInventoryRefreshed: vi.fn(),
    };
    const localModelInventoryService = {
      list: vi.fn(() => cached),
      refresh: vi.fn(async () => {
        throw new Error('probe failed');
      }),
      on: vi.fn(),
    };
    const logger = { warn: vi.fn() };

    await initializeUnifiedModelCatalogRuntime({
      userDataPath: '/tmp/aio-user-data',
      settingsManager: { get: vi.fn(), on: vi.fn() },
      catalog,
      catalogOverrideSource: catalogOverrideSource(),
      modelsDevService: modelsDevService(),
      codexDiscoveryService: { start: vi.fn() },
      cursorCopilotDiscoveryService: { start: vi.fn() },
      localModelInventoryService,
      logger,
    });

    expect(catalog.onLocalModelInventoryRefreshed).toHaveBeenCalledWith(
      cached,
      { immediate: true },
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'Local model inventory refresh failed; using cached inventory',
      { error: 'probe failed' },
    );
  });
});

function catalogOverrideSource() {
  return {
    startLocal: vi.fn(async () => undefined),
    attachSettingsManager: vi.fn(async () => undefined),
    getEntries: vi.fn(() => []),
    on: vi.fn(),
  };
}

function modelsDevService() {
  return {
    loadOfflineSnapshot: vi.fn(),
    refresh: vi.fn(async () => false),
  };
}

function localModelInventoryService() {
  return {
    list: vi.fn(() => []),
    refresh: vi.fn(async () => []),
    on: vi.fn(),
  };
}

function overrideEntry(
  provider: string,
  id: string,
  origin: 'local' | 'remote',
): CatalogOverrideEntry {
  return {
    provider,
    id,
    origin,
    source: 'catalog-override',
    discoveredAt: 123,
  };
}
