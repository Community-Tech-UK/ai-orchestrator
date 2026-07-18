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

const rlmMocks = vi.hoisted(() => ({
  createStore: vi.fn(),
  addSection: vi.fn(),
  removeSection: vi.fn(),
  getStore: vi.fn(),
  listStores: vi.fn(() => []),
  listSections: vi.fn(() => []),
  listSessions: vi.fn(() => []),
  deleteStore: vi.fn(),
  startSession: vi.fn(),
  endSession: vi.fn(),
  executeQuery: vi.fn(),
  getSession: vi.fn(),
  getStoreStats: vi.fn(),
  getSessionStats: vi.fn(),
  configure: vi.fn(),
  getTokenSavingsHistory: vi.fn((_days: number): unknown[] => []),
  getQueryStats: vi.fn(() => ({})),
  getStorageStats: vi.fn(() => ({})),
  exportStore: vi.fn(),
  importStore: vi.fn(),
}));

const outcomeMocks = vi.hoisted(() => ({
  getTopPatterns: vi.fn(() => [
    { id: 'pattern-1', effectiveness: 0.9 },
    { id: 'pattern-2', effectiveness: 0.4 },
  ]),
  recordOutcome: vi.fn(),
  getOutcome: vi.fn(),
  getRecentOutcomes: vi.fn((): unknown[] => []),
  getExperience: vi.fn(),
  getAllExperiences: vi.fn((): unknown[] => []),
  getInsights: vi.fn((): unknown[] => []),
  getStats: vi.fn(),
  getTaskTypeStats: vi.fn(),
  rateOutcome: vi.fn(),
  configure: vi.fn(),
}));

const strategyMocks = vi.hoisted(() => ({
  getRecommendation: vi.fn(() => ({ strategy: 'reuse winning pattern' })),
}));

const enhancerMocks = vi.hoisted(() => ({
  enhance: vi.fn(),
}));

const abMocks = vi.hoisted(() => ({
  createExperiment: vi.fn(),
  updateExperiment: vi.fn(),
  deleteExperiment: vi.fn(),
  startExperiment: vi.fn(),
  pauseExperiment: vi.fn(),
  completeExperiment: vi.fn(),
  getExperiment: vi.fn(),
  listExperiments: vi.fn((): unknown[] => []),
  getVariant: vi.fn(),
  recordOutcome: vi.fn(),
  getResults: vi.fn((): unknown[] => []),
  getWinner: vi.fn(),
  getStats: vi.fn(),
  configure: vi.fn(),
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
  RLMContextManager: { getInstance: () => rlmMocks },
}));

vi.mock('../learning/outcome-tracker', () => ({
  OutcomeTracker: {
    getInstance: () => outcomeMocks,
  },
}));

vi.mock('../learning/strategy-learner', () => ({
  StrategyLearner: {
    getInstance: () => strategyMocks,
  },
}));

vi.mock('../learning/prompt-enhancer', () => ({
  PromptEnhancer: { getInstance: () => enhancerMocks },
}));

vi.mock('../learning/ab-testing', () => ({
  ABTestingEngine: { getInstance: () => abMocks },
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
      success: true,
      data: {
        provider: 'openai',
        configured: true,
        connected: false,
        totalModels: 1,
        availableModels: 0,
      },
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

    expect(result).toMatchObject({
      success: true,
      data: { id: 'vision-model' },
    });
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
    expect(result).toEqual({
      success: true,
      data: [
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
      ],
    });
  });

  it('verifies no-config model ids against the unified catalog', async () => {
    unifiedCatalogMocks.models = [catalogEntry('codex', 'gpt-5.5')];

    const available = await invoke(IPC_CHANNELS.MODEL_VERIFY, { modelId: 'gpt-5.5' });
    const missing = await invoke(IPC_CHANNELS.MODEL_VERIFY, { modelId: 'does-not-exist' });

    expect(modelDiscoveryMocks.isModelAvailable).not.toHaveBeenCalled();
    expect(available).toEqual({ success: true, data: true });
    expect(missing).toMatchObject({
      success: false,
      data: false,
      error: expect.objectContaining({ code: 'MODEL_NOT_AVAILABLE' }),
    });
  });

  it('registers renderer-facing learning pattern and suggestion aliases', async () => {
    await expect(invoke(IPC_CHANNELS.LEARNING_GET_PATTERNS, { minSuccessRate: 0.5 }))
      .resolves.toEqual({
        success: true,
        data: [{ id: 'pattern-1', effectiveness: 0.9 }],
      });

    await expect(invoke(IPC_CHANNELS.LEARNING_GET_SUGGESTIONS, {
      context: 'CI has failed repeatedly',
      maxSuggestions: 3,
    })).resolves.toEqual({
      success: true,
      data: { strategy: 'reuse winning pattern' },
    });
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
      success: true,
      data: {
        totalProviders: 2,
        enabledProviders: 2,
        connectedProviders: 2,
        totalModels: 3,
        availableModels: 3,
      },
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

  it('rejects invalid model verification payloads before discovery', async () => {
    const result = await invoke(IPC_CHANNELS.MODEL_VERIFY, { modelId: '' });

    expect(result).toMatchObject({
      success: false,
      error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    });
    expect(modelDiscoveryMocks.isModelAvailable).not.toHaveBeenCalled();
  });

  it('rejects an untrusted sender before model discovery', async () => {
    const trustError = {
      success: false,
      error: { code: 'IPC_TRUST_FAILED', message: 'Untrusted sender', timestamp: 123 },
    };
    const ensureTrustedSender = vi.fn(() => trustError);
    registerLearningHandlers({ ensureTrustedSender });

    await expect(invoke(IPC_CHANNELS.MODEL_DISCOVER)).resolves.toEqual(trustError);
    expect(ensureTrustedSender).toHaveBeenCalledWith({}, IPC_CHANNELS.MODEL_DISCOVER);
    expect(unifiedCatalogMocks.getAllModels).not.toHaveBeenCalled();
  });

  describe('RLM handlers', () => {
    it('validates and wraps store creation', async () => {
      const store = { id: 'store-1', instanceId: 'instance-1', sections: [] };
      rlmMocks.createStore.mockReturnValue(store);

      await expect(invoke(IPC_CHANNELS.RLM_CREATE_STORE, 'instance-1')).resolves.toEqual({
        success: true,
        data: store,
      });
      expect(rlmMocks.createStore).toHaveBeenCalledWith('instance-1');
    });

    it('rejects an invalid store creation payload before writing', async () => {
      const result = await invoke(IPC_CHANNELS.RLM_CREATE_STORE, '');

      expect(result).toMatchObject({
        success: false,
        error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      });
      expect(rlmMocks.createStore).not.toHaveBeenCalled();
    });

    it('accepts the section types exposed by the preload contract', async () => {
      const section = { id: 'section-1', type: 'file', content: 'hello' };
      rlmMocks.addSection.mockReturnValue(section);

      const result = await invoke(IPC_CHANNELS.RLM_ADD_SECTION, {
        storeId: 'store-1',
        type: 'file',
        name: 'README.md',
        content: 'hello',
      });

      expect(result).toEqual({ success: true, data: section });
      expect(rlmMocks.addSection).toHaveBeenCalledWith(
        'store-1',
        'file',
        'README.md',
        'hello',
        undefined,
      );
    });

    it('rejects an invalid query before executing it', async () => {
      const result = await invoke(IPC_CHANNELS.RLM_EXECUTE_QUERY, {
        sessionId: 'session-1',
        query: { type: 'shell', params: {} },
      });

      expect(result).toMatchObject({
        success: false,
        error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      });
      expect(rlmMocks.executeQuery).not.toHaveBeenCalled();
    });

    it('wraps read failures in a structured error response', async () => {
      rlmMocks.listStores.mockImplementation(() => {
        throw new Error('database unavailable');
      });

      const result = await invoke(IPC_CHANNELS.RLM_LIST_STORES);

      expect(result).toMatchObject({
        success: false,
        error: {
          code: 'RLM_LIST_STORES_FAILED',
          message: 'database unavailable',
          timestamp: expect.any(Number),
        },
      });
    });

    it('rejects an untrusted sender before reading RLM state', async () => {
      const trustError = {
        success: false,
        error: { code: 'IPC_TRUST_FAILED', message: 'Untrusted sender', timestamp: 123 },
      };
      const ensureTrustedSender = vi.fn(() => trustError);
      registerLearningHandlers({ ensureTrustedSender });

      await expect(invoke(IPC_CHANNELS.RLM_LIST_STORES)).resolves.toEqual(trustError);
      expect(ensureTrustedSender).toHaveBeenCalledWith({}, IPC_CHANNELS.RLM_LIST_STORES);
      expect(rlmMocks.listStores).not.toHaveBeenCalled();
    });

    it('defaults analytics to 30 days and returns a structured response', async () => {
      const history = [{ day: '2026-07-17', saved: 42 }];
      rlmMocks.getTokenSavingsHistory.mockReturnValue(history);

      await expect(invoke(IPC_CHANNELS.RLM_GET_TOKEN_SAVINGS_HISTORY)).resolves.toEqual({
        success: true,
        data: history,
      });
      expect(rlmMocks.getTokenSavingsHistory).toHaveBeenCalledWith(30);
    });

    it('returns a structured validation error for an invalid analytics range', async () => {
      const result = await invoke(IPC_CHANNELS.RLM_GET_QUERY_STATS, { range: 'forever' });

      expect(result).toMatchObject({
        success: false,
        error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      });
      expect(rlmMocks.getQueryStats).not.toHaveBeenCalled();
    });
  });

  describe('self-improvement handlers', () => {
    const outcomePayload = {
      instanceId: 'instance-1',
      taskType: 'bug-fix',
      taskDescription: 'Fix a renderer race',
      prompt: 'Please fix it',
      agentUsed: 'reviewer',
      modelUsed: 'model-1',
      toolsUsed: [{ tool: 'read', count: 1, avgDuration: 5, errorCount: 0 }],
      tokensUsed: 200,
      duration: 1_000,
      success: true,
    };

    it('wraps every outcome and self-improvement result in IpcResponse', async () => {
      const outcome = { id: 'outcome-1' };
      const experience = { id: 'experience-1' };
      const insight = { id: 'insight-1' };
      const recommendation = { strategy: 'inspect first' };
      const enhancement = { enhancedPrompt: 'Inspect first, then fix.' };
      const stats = { totalOutcomes: 1 };
      const taskStats = { taskType: 'bug-fix' };
      outcomeMocks.recordOutcome.mockReturnValue(outcome);
      outcomeMocks.getOutcome.mockReturnValue(outcome);
      outcomeMocks.getRecentOutcomes.mockReturnValue([outcome]);
      outcomeMocks.getExperience.mockReturnValue(experience);
      outcomeMocks.getAllExperiences.mockReturnValue([experience]);
      outcomeMocks.getInsights.mockReturnValue([insight]);
      outcomeMocks.getStats.mockReturnValue(stats);
      outcomeMocks.getTaskTypeStats.mockReturnValue(taskStats);
      outcomeMocks.rateOutcome.mockReturnValue(true);
      strategyMocks.getRecommendation.mockReturnValue(recommendation);
      enhancerMocks.enhance.mockReturnValue(enhancement);

      const cases: Array<[string, unknown, unknown]> = [
        [IPC_CHANNELS.RLM_RECORD_OUTCOME, outcomePayload, outcome],
        [IPC_CHANNELS.LEARNING_RECORD_OUTCOME, outcomePayload, outcome],
        [IPC_CHANNELS.LEARNING_GET_OUTCOME, 'outcome-1', outcome],
        [IPC_CHANNELS.LEARNING_GET_RECENT_OUTCOMES, 10, [outcome]],
        [IPC_CHANNELS.LEARNING_GET_EXPERIENCE, 'bug-fix', experience],
        [IPC_CHANNELS.LEARNING_GET_ALL_EXPERIENCES, undefined, [experience]],
        [IPC_CHANNELS.LEARNING_GET_INSIGHTS, {}, [insight]],
        [IPC_CHANNELS.LEARNING_GET_RECOMMENDATION, { taskType: 'bug-fix' }, recommendation],
        [IPC_CHANNELS.LEARNING_ENHANCE_PROMPT, { prompt: 'Fix it' }, enhancement],
        [IPC_CHANNELS.LEARNING_GET_STATS, undefined, stats],
        [IPC_CHANNELS.LEARNING_GET_TASK_STATS, 'bug-fix', taskStats],
        [IPC_CHANNELS.LEARNING_RATE_OUTCOME, { outcomeId: 'outcome-1', satisfaction: 1 }, true],
      ];

      for (const [channel, payload, data] of cases) {
        await expect(invoke(channel, payload)).resolves.toEqual({ success: true, data });
      }
      await expect(invoke(IPC_CHANNELS.LEARNING_CONFIGURE, {
        enableAutoEnhancement: true,
      })).resolves.toEqual({ success: true });
    });

    it('rejects an invalid outcome before writing learning state', async () => {
      const result = await invoke(IPC_CHANNELS.LEARNING_RECORD_OUTCOME, {
        ...outcomePayload,
        instanceId: '',
      });

      expect(result).toMatchObject({
        success: false,
        error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      });
      expect(outcomeMocks.recordOutcome).not.toHaveBeenCalled();
    });

    it('rejects an untrusted sender before writing learning state', async () => {
      const trustError = {
        success: false,
        error: { code: 'IPC_TRUST_FAILED', message: 'Untrusted sender', timestamp: 123 },
      };
      const ensureTrustedSender = vi.fn(() => trustError);
      registerLearningHandlers({ ensureTrustedSender });

      await expect(invoke(IPC_CHANNELS.LEARNING_RECORD_OUTCOME, outcomePayload))
        .resolves.toEqual(trustError);
      expect(ensureTrustedSender).toHaveBeenCalledWith({}, IPC_CHANNELS.LEARNING_RECORD_OUTCOME);
      expect(outcomeMocks.recordOutcome).not.toHaveBeenCalled();
    });
  });

  describe('A/B testing handlers', () => {
    const experimentIdPayload = { experimentId: 'experiment-1' };
    const experiment = { id: 'experiment-1', status: 'draft' };

    it('validates experiment creation and returns a structured response', async () => {
      abMocks.createExperiment.mockReturnValue(experiment);

      const payload = {
        name: 'Prompt wording',
        taskType: 'bug-fix',
        variants: [
          { name: 'Direct', template: 'Fix it', weight: 1 },
          { name: 'Investigate', template: 'Investigate, then fix', weight: 1 },
        ],
      };

      await expect(invoke(IPC_CHANNELS.AB_CREATE_EXPERIMENT, payload)).resolves.toEqual({
        success: true,
        data: experiment,
      });
      expect(abMocks.createExperiment).toHaveBeenCalledWith(payload);
    });

    it('rejects invalid experiment creation before writing state', async () => {
      const result = await invoke(IPC_CHANNELS.AB_CREATE_EXPERIMENT, {
        name: 'Missing variants',
        taskType: 'bug-fix',
        variants: [],
      });

      expect(result).toMatchObject({
        success: false,
        error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      });
      expect(abMocks.createExperiment).not.toHaveBeenCalled();
    });

    it('accepts the object-shaped experiment IDs emitted by preload', async () => {
      abMocks.getExperiment.mockReturnValue(experiment);
      abMocks.startExperiment.mockReturnValue(true);
      abMocks.pauseExperiment.mockReturnValue(true);
      abMocks.completeExperiment.mockReturnValue({ experiment, winner: null });
      abMocks.getResults.mockReturnValue([{ variantId: 'variant-1' }]);
      abMocks.getWinner.mockReturnValue(null);

      await expect(invoke(IPC_CHANNELS.AB_GET_EXPERIMENT, experimentIdPayload))
        .resolves.toEqual({ success: true, data: experiment });
      await expect(invoke(IPC_CHANNELS.AB_START_EXPERIMENT, experimentIdPayload))
        .resolves.toEqual({ success: true, data: true });
      await expect(invoke(IPC_CHANNELS.AB_PAUSE_EXPERIMENT, experimentIdPayload))
        .resolves.toEqual({ success: true, data: true });
      await expect(invoke(IPC_CHANNELS.AB_COMPLETE_EXPERIMENT, experimentIdPayload))
        .resolves.toEqual({ success: true, data: { experiment, winner: null } });
      await expect(invoke(IPC_CHANNELS.AB_GET_RESULTS, experimentIdPayload))
        .resolves.toEqual({ success: true, data: [{ variantId: 'variant-1' }] });
      await expect(invoke(IPC_CHANNELS.AB_GET_WINNER, experimentIdPayload))
        .resolves.toEqual({ success: true, data: null });

      expect(abMocks.getExperiment).toHaveBeenCalledWith('experiment-1');
      expect(abMocks.startExperiment).toHaveBeenCalledWith('experiment-1');
      expect(abMocks.pauseExperiment).toHaveBeenCalledWith('experiment-1');
      expect(abMocks.completeExperiment).toHaveBeenCalledWith('experiment-1');
      expect(abMocks.getResults).toHaveBeenCalledWith('experiment-1');
      expect(abMocks.getWinner).toHaveBeenCalledWith('experiment-1');
    });

    it('selects variants by task type and optional session ID', async () => {
      const selection = { experiment, variant: { id: 'variant-1' } };
      abMocks.getVariant.mockReturnValue(selection);

      await expect(invoke(IPC_CHANNELS.AB_GET_VARIANT, {
        taskType: 'bug-fix',
        sessionId: 'session-1',
      })).resolves.toEqual({ success: true, data: selection });
      expect(abMocks.getVariant).toHaveBeenCalledWith('bug-fix', 'session-1');
    });

    it('uses the engine status vocabulary when listing experiments', async () => {
      abMocks.listExperiments.mockReturnValue([experiment]);

      await expect(invoke(IPC_CHANNELS.AB_LIST_EXPERIMENTS, { status: 'running' }))
        .resolves.toEqual({ success: true, data: [experiment] });
      expect(abMocks.listExperiments).toHaveBeenCalledWith({ status: 'running' });

      const invalid = await invoke(IPC_CHANNELS.AB_LIST_EXPERIMENTS, { status: 'active' });
      expect(invalid).toMatchObject({
        success: false,
        error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      });
    });

    it('returns structured operation errors', async () => {
      abMocks.startExperiment.mockReturnValue(false);

      const result = await invoke(IPC_CHANNELS.AB_START_EXPERIMENT, experimentIdPayload);

      expect(result).toMatchObject({
        success: false,
        error: {
          code: 'AB_START_EXPERIMENT_FAILED',
          message: 'Failed to start experiment',
          timestamp: expect.any(Number),
        },
      });
    });

    it('rejects an untrusted sender before reading experiment state', async () => {
      const trustError = {
        success: false,
        error: { code: 'IPC_TRUST_FAILED', message: 'Untrusted sender', timestamp: 123 },
      };
      const ensureTrustedSender = vi.fn(() => trustError);
      registerLearningHandlers({ ensureTrustedSender });

      await expect(invoke(IPC_CHANNELS.AB_GET_STATS)).resolves.toEqual(trustError);
      expect(ensureTrustedSender).toHaveBeenCalledWith({}, IPC_CHANNELS.AB_GET_STATS);
      expect(abMocks.getStats).not.toHaveBeenCalled();
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
