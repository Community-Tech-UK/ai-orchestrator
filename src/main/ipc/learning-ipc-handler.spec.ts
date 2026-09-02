import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import type { UnifiedModelEntry } from '../../shared/types/unified-model-catalog.types';
import type {
  RlmRendererWorkerRequest,
  RlmWorkerPort,
  RlmWorkerResult,
} from '../instance/rlm-worker-port';

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

const rlmPortMocks = vi.hoisted(() => ({
  invokeRlm: vi.fn(),
}));

const contextManagerImportProbe = vi.hoisted(() => ({
  imports: 0,
  getInstance: vi.fn(() => {
    throw new Error('Main-process RLMContextManager must not be instantiated');
  }),
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

vi.mock('../instance/context-worker-client', () => ({
  getContextWorkerClient: () => rlmPortMocks,
}));

vi.mock('./model-override-ipc-handlers', () => ({
  registerModelOverrideHandlers: vi.fn(),
}));

vi.mock('../rlm/context-manager', () => {
  contextManagerImportProbe.imports++;
  return {
    RLMContextManager: { getInstance: contextManagerImportProbe.getInstance },
  };
});

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

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { registerLearningHandlers } from './learning-ipc-handler';

const rlmPort = rlmPortMocks as unknown as RlmWorkerPort;

type RlmRequestKind = RlmRendererWorkerRequest['kind'];
interface RlmParityCase<TKind extends RlmRequestKind> {
  channel: string;
  payload?: unknown;
  request: Extract<RlmRendererWorkerRequest, { kind: TKind }>;
  workerResult: RlmWorkerResult<Extract<RlmRendererWorkerRequest, { kind: TKind }>>;
  expectedResponse: unknown;
}
type RlmParityCases = {
  [TKind in RlmRequestKind]: RlmParityCase<TKind>;
};

const workerSection = {
  id: 'section-1',
  type: 'file' as const,
  name: 'README.md',
  content: '',
  tokens: 3,
  startOffset: 0,
  endOffset: 5,
  checksum: 'checksum-1',
  depth: 0,
};
const workerStore = {
  id: 'store-1',
  instanceId: 'instance-1',
  sections: [workerSection],
  totalTokens: 3,
  totalSize: 5,
  createdAt: 1,
  lastAccessed: 2,
  accessCount: 1,
  config: { ipcSectionCount: 1, ipcSectionsTruncated: false },
};
const workerQueryResult = {
  query: { type: 'grep' as const, params: { pattern: 'needle' } },
  result: 'match',
  tokensUsed: 2,
  sectionsAccessed: ['section-1'],
  duration: 4,
  depth: 0,
};
const workerSession = {
  id: 'session-1',
  storeId: 'store-1',
  instanceId: 'instance-1',
  queries: [workerQueryResult],
  recursiveCalls: [],
  totalRootTokens: 2,
  totalSubQueryTokens: 0,
  estimatedDirectTokens: 8,
  tokenSavingsPercent: 75,
  startedAt: 1,
  lastActivityAt: 2,
};

const rlmParityCases = {
  'create-store': {
    channel: IPC_CHANNELS.RLM_CREATE_STORE,
    payload: 'instance-1',
    request: { kind: 'create-store', instanceId: 'instance-1' },
    workerResult: workerStore,
    expectedResponse: { success: true, data: workerStore },
  },
  'delete-store': {
    channel: IPC_CHANNELS.RLM_DELETE_STORE,
    payload: 'store-1',
    request: { kind: 'delete-store', storeId: 'store-1' },
    workerResult: undefined,
    expectedResponse: { success: true },
  },
  'get-store': {
    channel: IPC_CHANNELS.RLM_GET_STORE,
    payload: 'store-1',
    request: { kind: 'get-store', storeId: 'store-1' },
    workerResult: workerStore,
    expectedResponse: { success: true, data: workerStore },
  },
  'list-stores': {
    channel: IPC_CHANNELS.RLM_LIST_STORES,
    request: { kind: 'list-stores' },
    workerResult: [workerStore],
    expectedResponse: { success: true, data: [workerStore] },
  },
  'add-section': {
    channel: IPC_CHANNELS.RLM_ADD_SECTION,
    payload: { storeId: 'store-1', type: 'file', name: 'README.md', content: 'hello' },
    request: {
      kind: 'add-section', storeId: 'store-1', type: 'file', name: 'README.md',
      content: 'hello', metadata: undefined,
    },
    workerResult: workerSection,
    expectedResponse: { success: true, data: workerSection },
  },
  'remove-section': {
    channel: IPC_CHANNELS.RLM_REMOVE_SECTION,
    payload: { storeId: 'store-1', sectionId: 'section-1' },
    request: { kind: 'remove-section', storeId: 'store-1', sectionId: 'section-1' },
    workerResult: true,
    expectedResponse: { success: true, data: true },
  },
  'list-sections': {
    channel: IPC_CHANNELS.RLM_LIST_SECTIONS,
    payload: 'store-1',
    request: { kind: 'list-sections', storeId: 'store-1' },
    workerResult: [workerSection],
    expectedResponse: { success: true, data: [workerSection] },
  },
  'start-session': {
    channel: IPC_CHANNELS.RLM_START_SESSION,
    payload: { storeId: 'store-1', instanceId: 'instance-1' },
    request: { kind: 'start-session', storeId: 'store-1', instanceId: 'instance-1' },
    workerResult: workerSession,
    expectedResponse: { success: true, data: workerSession },
  },
  'end-session': {
    channel: IPC_CHANNELS.RLM_END_SESSION,
    payload: 'session-1',
    request: { kind: 'end-session', sessionId: 'session-1' },
    workerResult: undefined,
    expectedResponse: { success: true },
  },
  'get-session': {
    channel: IPC_CHANNELS.RLM_GET_SESSION,
    payload: 'session-1',
    request: { kind: 'get-session', sessionId: 'session-1' },
    workerResult: workerSession,
    expectedResponse: { success: true, data: workerSession },
  },
  'list-sessions': {
    channel: IPC_CHANNELS.RLM_LIST_SESSIONS,
    request: { kind: 'list-sessions' },
    workerResult: [workerSession],
    expectedResponse: { success: true, data: [workerSession] },
  },
  'execute-query': {
    channel: IPC_CHANNELS.RLM_EXECUTE_QUERY,
    payload: {
      sessionId: 'session-1', query: { type: 'grep', params: { pattern: 'needle' } }, depth: 0,
    },
    request: {
      kind: 'execute-query', sessionId: 'session-1',
      query: { type: 'grep', params: { pattern: 'needle' } }, depth: 0,
    },
    workerResult: workerQueryResult,
    expectedResponse: { success: true, data: workerQueryResult },
  },
  'get-store-stats': {
    channel: IPC_CHANNELS.RLM_GET_STORE_STATS,
    payload: 'store-1',
    request: { kind: 'get-store-stats', storeId: 'store-1' },
    workerResult: {
      sections: 1, originalSections: 1, summaries: 0, totalTokens: 3,
      summaryLevels: 0, indexedTerms: 0,
    },
    expectedResponse: {
      success: true,
      data: {
        sections: 1, originalSections: 1, summaries: 0, totalTokens: 3,
        summaryLevels: 0, indexedTerms: 0,
      },
    },
  },
  'get-session-stats': {
    channel: IPC_CHANNELS.RLM_GET_SESSION_STATS,
    payload: 'session-1',
    request: { kind: 'get-session-stats', sessionId: 'session-1' },
    workerResult: {
      totalQueries: 1, totalRecursiveCalls: 0, rootTokens: 2, subQueryTokens: 0,
      estimatedSavings: 6, avgQueryDuration: 4,
    },
    expectedResponse: {
      success: true,
      data: {
        totalQueries: 1, totalRecursiveCalls: 0, rootTokens: 2, subQueryTokens: 0,
        estimatedSavings: 6, avgQueryDuration: 4,
      },
    },
  },
  'get-storage-stats': {
    channel: IPC_CHANNELS.RLM_GET_STORAGE_STATS,
    request: { kind: 'get-storage-stats' },
    workerResult: {
      totalStores: 1, totalSections: 1, totalTokens: 3, totalSizeBytes: 5,
      byType: [{ type: 'file', count: 1, tokens: 3 }],
    },
    expectedResponse: {
      success: true,
      data: {
        totalStores: 1, totalSections: 1, totalTokens: 3, totalSizeBytes: 5,
        byType: [{ type: 'file', count: 1, tokens: 3 }],
      },
    },
  },
  'get-query-stats': {
    channel: IPC_CHANNELS.RLM_GET_QUERY_STATS,
    payload: { range: '90d' },
    request: { kind: 'get-query-stats', days: 90 },
    workerResult: [{ type: 'grep', count: 1, avgDuration: 4, avgTokens: 2 }],
    expectedResponse: {
      success: true,
      data: [{ type: 'grep', count: 1, avgDuration: 4, avgTokens: 2 }],
    },
  },
  'get-token-savings-history': {
    channel: IPC_CHANNELS.RLM_GET_TOKEN_SAVINGS_HISTORY,
    payload: { range: '7d' },
    request: { kind: 'get-token-savings-history', days: 7 },
    workerResult: [{
      date: '2026-09-01', directTokens: 8, actualTokens: 2, savingsPercent: 75,
    }],
    expectedResponse: {
      success: true,
      data: [{ date: '2026-09-01', directTokens: 8, actualTokens: 2, savingsPercent: 75 }],
    },
  },
  configure: {
    channel: IPC_CHANNELS.RLM_CONFIGURE,
    payload: { maxRecursionDepth: 4 },
    request: { kind: 'configure', config: { maxRecursionDepth: 4 } },
    workerResult: undefined,
    expectedResponse: { success: true },
  },
} satisfies RlmParityCases;
const rlmParityCaseList: RlmParityCase<RlmRequestKind>[] = Object.values(rlmParityCases);

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
    registerLearningHandlers({ ensureTrustedSender, rlmPort });

    await expect(invoke(IPC_CHANNELS.MODEL_DISCOVER)).resolves.toEqual(trustError);
    expect(ensureTrustedSender).toHaveBeenCalledWith({}, IPC_CHANNELS.MODEL_DISCOVER);
    expect(unifiedCatalogMocks.getAllModels).not.toHaveBeenCalled();
  });

  describe('RLM handlers', () => {
    it('registers the worker port without directly importing or instantiating the main-process context manager', () => {
      expect(contextManagerImportProbe.imports).toBe(0);
      expect(contextManagerImportProbe.getInstance).not.toHaveBeenCalled();
    });

    it.each(rlmParityCaseList)(
      'maps $channel to the exact worker request and preserves its result envelope',
      async ({ channel, payload, request, workerResult, expectedResponse }) => {
        rlmPortMocks.invokeRlm.mockResolvedValueOnce(workerResult);

        await expect(invoke(channel, payload)).resolves.toEqual(expectedResponse);
        expect(rlmPortMocks.invokeRlm).toHaveBeenCalledOnce();
        expect(rlmPortMocks.invokeRlm).toHaveBeenCalledWith(request);
      },
    );

    it('preserves undefined for a missing worker read without adding data', async () => {
      rlmPortMocks.invokeRlm.mockResolvedValueOnce(undefined);

      await expect(invoke(IPC_CHANNELS.RLM_GET_STORE, 'missing-store')).resolves.toEqual({
        success: true,
      });
      expect(rlmPortMocks.invokeRlm).toHaveBeenCalledWith({
        kind: 'get-store',
        storeId: 'missing-store',
      });
    });

    it('rejects an invalid store creation payload before writing', async () => {
      const result = await invoke(IPC_CHANNELS.RLM_CREATE_STORE, '');

      expect(result).toMatchObject({
        success: false,
        error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      });
      expect(rlmPortMocks.invokeRlm).not.toHaveBeenCalled();
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
      expect(rlmPortMocks.invokeRlm).not.toHaveBeenCalled();
    });

    it('wraps read failures in a structured error response', async () => {
      rlmPortMocks.invokeRlm.mockRejectedValueOnce(new Error('database unavailable'));

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
      registerLearningHandlers({ ensureTrustedSender, rlmPort });

      await expect(invoke(IPC_CHANNELS.RLM_LIST_STORES)).resolves.toEqual(trustError);
      expect(ensureTrustedSender).toHaveBeenCalledWith({}, IPC_CHANNELS.RLM_LIST_STORES);
      expect(rlmPortMocks.invokeRlm).not.toHaveBeenCalled();
    });

    it('defaults analytics to 30 days and returns a structured response', async () => {
      const history = [{ day: '2026-07-17', saved: 42 }];
      rlmPortMocks.invokeRlm.mockResolvedValueOnce(history);

      await expect(invoke(IPC_CHANNELS.RLM_GET_TOKEN_SAVINGS_HISTORY)).resolves.toEqual({
        success: true,
        data: history,
      });
      expect(rlmPortMocks.invokeRlm).toHaveBeenCalledWith({
        kind: 'get-token-savings-history',
        days: 30,
      });
    });

    it('returns a structured validation error for an invalid analytics range', async () => {
      const result = await invoke(IPC_CHANNELS.RLM_GET_QUERY_STATS, { range: 'forever' });

      expect(result).toMatchObject({
        success: false,
        error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
      });
      expect(rlmPortMocks.invokeRlm).not.toHaveBeenCalled();
    });

    it('does not retry an ambiguous mutation failure in the handler', async () => {
      rlmPortMocks.invokeRlm.mockRejectedValueOnce(new Error('worker request timed out'));

      const result = await invoke(IPC_CHANNELS.RLM_ADD_SECTION, {
        storeId: 'store-1',
        type: 'conversation',
        name: 'turn',
        content: 'one write only',
      });

      expect(result).toMatchObject({
        success: false,
        error: {
          code: 'RLM_ADD_SECTION_FAILED',
          message: 'worker request timed out',
          timestamp: expect.any(Number),
        },
      });
      expect(rlmPortMocks.invokeRlm).toHaveBeenCalledOnce();
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

      const cases: [string, unknown, unknown][] = [
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
      registerLearningHandlers({ ensureTrustedSender, rlmPort });

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
      registerLearningHandlers({ ensureTrustedSender, rlmPort });

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
