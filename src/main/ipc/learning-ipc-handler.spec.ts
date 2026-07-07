import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import type { UnifiedModelEntry } from '../../shared/types/unified-model-catalog.types';

type IpcHandler = (event: unknown, payload?: unknown) => unknown | Promise<unknown>;

const electronMocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
}));

const modelDiscoveryMocks = vi.hoisted(() => ({
  discoverModels: vi.fn(),
  getModelDetails: vi.fn(),
  isModelAvailable: vi.fn(),
}));

const unifiedCatalogMocks = vi.hoisted(() => ({
  models: [] as UnifiedModelEntry[],
  getAllModels: vi.fn(() => unifiedCatalogMocks.models),
  getModel: vi.fn((id: string) => unifiedCatalogMocks.models.find((model) => model.id === id)),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      electronMocks.handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../providers/model-discovery', () => ({
  getModelDiscoveryService: () => modelDiscoveryMocks,
}));

vi.mock('../providers/unified-model-catalog-service', () => ({
  getUnifiedModelCatalog: () => unifiedCatalogMocks,
}));

vi.mock('./model-override-ipc-handlers', () => ({
  registerModelOverrideHandlers: vi.fn(),
}));

vi.mock('../rlm/context-manager', () => ({
  RLMContextManager: { getInstance: () => ({}) },
}));

vi.mock('../learning/outcome-tracker', () => ({
  OutcomeTracker: {
    getInstance: () => ({
      getTopPatterns: vi.fn(() => [
        { id: 'pattern-1', effectiveness: 0.9 },
        { id: 'pattern-2', effectiveness: 0.4 },
      ]),
    }),
  },
}));

vi.mock('../learning/strategy-learner', () => ({
  StrategyLearner: {
    getInstance: () => ({
      getRecommendation: vi.fn(() => ({ strategy: 'reuse winning pattern' })),
    }),
  },
}));

vi.mock('../learning/prompt-enhancer', () => ({
  PromptEnhancer: { getInstance: () => ({}) },
}));

vi.mock('../learning/ab-testing', () => ({
  ABTestingEngine: { getInstance: () => ({}) },
}));

vi.mock('./rlm-ipc-serialization', () => ({
  serializeContextSectionForIpc: vi.fn((section) => section),
  serializeContextStoreForIpc: vi.fn((store) => store),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { registerLearningHandlers } from './learning-ipc-handler';

describe('learning IPC legacy model discovery handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    electronMocks.handlers.clear();
    unifiedCatalogMocks.models = [];
    unifiedCatalogMocks.getAllModels.mockClear();
    unifiedCatalogMocks.getModel.mockClear();
    registerLearningHandlers();
  });

  it('reports provider status from discovered model availability instead of a hard-coded connected status', async () => {
    modelDiscoveryMocks.discoverModels.mockResolvedValueOnce([
      {
        id: 'model-a',
        name: 'Model A',
        provider: 'openai',
        capabilities: {},
        isAvailable: false,
        lastChecked: Date.now(),
      },
    ]);

    const result = await invoke(IPC_CHANNELS.MODEL_GET_PROVIDER_STATUS, {
      type: 'openai',
      apiKey: 'test-key',
    });

    expect(modelDiscoveryMocks.discoverModels).toHaveBeenCalledWith({
      type: 'openai',
      apiKey: 'test-key',
    });
    expect(result).toMatchObject({
      provider: 'openai',
      configured: true,
      connected: false,
      totalModels: 1,
      availableModels: 0,
    });
  });

  it('selects an available model that satisfies requested capabilities', async () => {
    modelDiscoveryMocks.discoverModels.mockResolvedValueOnce([
      {
        id: 'text-only',
        name: 'Text Only',
        provider: 'openai',
        capabilities: { streaming: true },
        isAvailable: true,
        lastChecked: Date.now(),
      },
      {
        id: 'vision-model',
        name: 'Vision Model',
        provider: 'openai',
        capabilities: { streaming: true, vision: true },
        isAvailable: true,
        lastChecked: Date.now(),
      },
    ]);

    const result = await invoke(IPC_CHANNELS.MODEL_SELECT, {
      config: { type: 'openai' },
      criteria: { capabilities: ['vision'] },
    });

    expect(result).toMatchObject({ id: 'vision-model' });
  });

  it('serves no-config model discovery from the unified catalog instead of dereferencing a missing config', async () => {
    unifiedCatalogMocks.models = [
      {
        ...catalogEntry('claude', 'opus'),
        name: 'Opus',
        contextWindow: 200_000,
        pricing: { inputPerMillion: 15, outputPerMillion: 75 },
      },
    ];

    const result = await invoke(IPC_CHANNELS.MODEL_DISCOVER);

    expect(modelDiscoveryMocks.discoverModels).not.toHaveBeenCalled();
    expect(result).toEqual([
      expect.objectContaining({
        id: 'opus',
        name: 'Opus',
        provider: 'claude',
        contextLength: 200_000,
        pricing: {
          inputPer1kTokens: 0.015,
          outputPer1kTokens: 0.075,
          currency: 'USD',
        },
        isAvailable: true,
      }),
    ]);
  });

  it('verifies no-config model ids against the unified catalog', async () => {
    unifiedCatalogMocks.models = [catalogEntry('codex', 'gpt-5.5')];

    const available = await invoke(IPC_CHANNELS.MODEL_VERIFY, { modelId: 'gpt-5.5' });
    const missing = await invoke(IPC_CHANNELS.MODEL_VERIFY, { modelId: 'does-not-exist' });

    expect(modelDiscoveryMocks.isModelAvailable).not.toHaveBeenCalled();
    expect(available).toBe(true);
    expect(missing).toBe(false);
  });

  it('registers renderer-facing learning pattern and suggestion aliases', async () => {
    await expect(invoke(IPC_CHANNELS.LEARNING_GET_PATTERNS, { minSuccessRate: 0.5 }))
      .resolves.toEqual([{ id: 'pattern-1', effectiveness: 0.9 }]);

    await expect(invoke(IPC_CHANNELS.LEARNING_GET_SUGGESTIONS, {
      context: 'CI has failed repeatedly',
      maxSuggestions: 3,
    })).resolves.toEqual({ strategy: 'reuse winning pattern' });
  });

  it('reports model stats from the unified catalog instead of placeholder totals', async () => {
    unifiedCatalogMocks.models = [
      catalogEntry('claude', 'opus'),
      catalogEntry('claude', 'sonnet'),
      catalogEntry('codex', 'gpt-5.5'),
    ];

    const result = await invoke(IPC_CHANNELS.MODEL_GET_STATS);

    expect(unifiedCatalogMocks.getAllModels).toHaveBeenCalled();
    expect(result).toEqual({
      totalProviders: 2,
      enabledProviders: 2,
      connectedProviders: 2,
      totalModels: 3,
      availableModels: 3,
    });
  });

  it('rejects legacy model provider configuration instead of returning fake success', async () => {
    const result = await invoke(IPC_CHANNELS.MODEL_CONFIGURE_PROVIDER, {
      type: 'openai',
      apiKey: 'test-key',
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: 'MODEL_CONFIGURE_PROVIDER_UNSUPPORTED',
      },
    });
  });
});

async function invoke(channel: string, payload?: unknown): Promise<unknown> {
  const handler = electronMocks.handlers.get(channel);
  if (!handler) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return handler({}, payload);
}

function catalogEntry(provider: string, id: string): UnifiedModelEntry {
  return {
    id,
    provider,
    tier: 'balanced',
    source: 'static',
    discoveredAt: 1,
  };
}
