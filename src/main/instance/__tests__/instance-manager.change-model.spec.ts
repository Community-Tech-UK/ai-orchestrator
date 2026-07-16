/**
 * InstanceManager changeModel / orchestration / events Tests
 *
 * Split from instance-manager.spec.ts. Full mock preamble duplicated
 * (same pattern as instance-manager.normalized-event.spec.ts) so Vitest
 * mock hoisting stays reliable.
 *
 * Note: vi.mock() paths are resolved relative to THIS test file location:
 *   src/main/instance/__tests__/instance-manager.change-model.spec.ts
 * So paths like '../../cli/...' resolve to src/main/cli/...
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const {
  mockCreateCliAdapter,
  mockCommandExecuteCommandString,
  mockIndexedBuildContext,
  mockIndexedFormatContextBlock,
  mockIndexedBuildFastPathResult,
  mockContextWorkerBuildProjectMemoryBrief,
  mockProjectMemoryBuildBrief,
  mockPromptHistoryRecord,
  mockPromptHistoryClearForInstance,
  mockSessionContinuity,
  mockResourceGovernorGetCreationBlockReason,
  mockLoopCoordinator,
  mockLoopStore,
  mockPrepareLoopStartConfig,
  mockAppendLoopStartPrompt,
  mockChatService,
  mockGetModelsForProvider,
  mockGetKnownCatalogModelIdsForProvider,
  mockGetDefaultModelForCli,
  mockGetProviderModelContextWindow,
  mockIsModelTier,
  mockLooksLikeCodexModelId,
  mockResolveModelForTier,
  mockLocalModelInventory,
  mockLocalModelRefresh,
} = vi.hoisted(() => ({
  mockCreateCliAdapter: vi.fn(),
  mockCommandExecuteCommandString: vi.fn().mockResolvedValue(null),
  mockIndexedBuildContext: vi.fn(),
  mockIndexedFormatContextBlock: vi.fn(),
  mockIndexedBuildFastPathResult: vi.fn(),
  mockContextWorkerBuildProjectMemoryBrief: vi.fn().mockResolvedValue(null),
  mockProjectMemoryBuildBrief: vi.fn().mockResolvedValue({
    text: '',
    sections: [],
    sources: [],
    stats: {
      projectKey: '/tmp/test-project',
      candidatesScanned: 0,
      candidatesIncluded: 0,
      truncated: false,
    },
  }),
  mockPromptHistoryRecord: vi.fn(),
  mockPromptHistoryClearForInstance: vi.fn(),
  mockSessionContinuity: {
    startTracking: vi.fn().mockResolvedValue(undefined),
    stopTracking: vi.fn().mockResolvedValue(undefined),
    resumeSession: vi.fn().mockResolvedValue(null),
    updateState: vi.fn().mockResolvedValue(undefined),
    markNativeResumeFailed: vi.fn().mockResolvedValue(undefined),
    writeThroughIdentityLocked: vi.fn().mockResolvedValue(undefined),
    createSnapshot: vi.fn().mockResolvedValue({ id: 'snapshot-1' }),
  },
  mockResourceGovernorGetCreationBlockReason: vi.fn<() => string | null>(() => null),
  mockLoopCoordinator: {
    startLoop: vi.fn(),
    getActiveLoops: vi.fn(),
    pauseLoop: vi.fn(),
    resumeLoop: vi.fn(),
    cancelLoop: vi.fn(),
    getLoop: vi.fn(),
  },
  mockLoopStore: {
    upsertRun: vi.fn(),
  },
  mockPrepareLoopStartConfig: vi.fn(),
  mockAppendLoopStartPrompt: vi.fn(),
  mockChatService: {
    tryGetChat: vi.fn(),
  },
  mockGetModelsForProvider: vi.fn(),
  mockGetKnownCatalogModelIdsForProvider: vi.fn(),
  mockGetDefaultModelForCli: vi.fn(),
  mockGetProviderModelContextWindow: vi.fn(),
  mockIsModelTier: vi.fn(),
  mockLooksLikeCodexModelId: vi.fn(),
  mockResolveModelForTier: vi.fn(),
  mockLocalModelInventory: [] as unknown[],
  mockLocalModelRefresh: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

// Mock electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn((name: string) => {
      if (name === 'home') return '/home/testuser';
      if (name === 'userData') return '/tmp/test-userData';
      return '/tmp/test-path';
    }),
    isPackaged: false,
  },
}));

// Mock electron-store
vi.mock('electron-store', () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      store: {
        defaultYoloMode: false,
        defaultWorkingDirectory: '',
        defaultCli: 'auto',
        defaultModel: 'opus',
        theme: 'dark',
        maxChildrenPerParent: 10,
        maxTotalInstances: 20,
        autoTerminateIdleMinutes: 30,
        allowNestedOrchestration: false,
        outputBufferSize: 500,
        enableDiskStorage: true,
        maxDiskStorageMB: 500,
        memoryWarningThresholdMB: 1024,
        autoTerminateOnMemoryPressure: true,
        persistSessionContent: true,
        fontSize: 14,
        contextWarningThreshold: 80,
        showToolMessages: true,
        showThinking: true,
        thinkingDefaultExpanded: false,
        maxRecentDirectories: 20,
        customModelOverride: '',
        parserBufferMaxKB: 512,
      },
      path: '/tmp/test-userData/settings.json',
      get: vi.fn((key: string) => {
        const defaults: Record<string, unknown> = {
          defaultModel: 'opus',
          defaultCli: 'auto',
          maxChildrenPerParent: 10,
          maxTotalInstances: 20,
          allowNestedOrchestration: false,
        };
        return defaults[key];
      }),
      set: vi.fn(),
      clear: vi.fn(),
    })),
  };
});

// ---------------------------------------------------------------------------
// Shared mock for settings manager (used in many sub-modules)
// ---------------------------------------------------------------------------
const mockSettingsData = {
  defaultYoloMode: false,
  defaultWorkingDirectory: '',
  defaultCli: 'auto' as const,
  defaultModel: 'opus',
  theme: 'dark' as const,
  maxChildrenPerParent: 10,
  maxTotalInstances: 20,
  autoTerminateIdleMinutes: 30,
  allowNestedOrchestration: false,
  outputBufferSize: 500,
  enableDiskStorage: true,
  maxDiskStorageMB: 500,
  memoryWarningThresholdMB: 1024,
  autoTerminateOnMemoryPressure: true,
  persistSessionContent: true,
  fontSize: 14,
  contextWarningThreshold: 80,
  showToolMessages: true,
  showThinking: true,
  thinkingDefaultExpanded: false,
  maxRecentDirectories: 20,
  customModelOverride: '',
  parserBufferMaxKB: 512,
};

const mockSettingsGetAll = vi.fn(() => ({ ...mockSettingsData }));
const mockSettingsOn = vi.fn();
const mockSettingsManager = {
  getAll: mockSettingsGetAll,
  get: vi.fn((key: string) => mockSettingsData[key as keyof typeof mockSettingsData]),
  on: mockSettingsOn,
  emit: vi.fn(),
};

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: vi.fn(() => mockSettingsManager),
  SettingsManager: vi.fn().mockImplementation(() => mockSettingsManager),
}));

vi.mock('../../indexing/indexed-codebase-context', () => ({
  getIndexedCodebaseContextService: vi.fn(() => ({
    buildContext: mockIndexedBuildContext,
    formatContextBlock: mockIndexedFormatContextBlock,
    buildFastPathResult: mockIndexedBuildFastPathResult,
  })),
}));

// ---------------------------------------------------------------------------
// Logger mock
// ---------------------------------------------------------------------------
vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  getLogManager: vi.fn(() => ({
    getLogger: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  })),
}));

// ---------------------------------------------------------------------------
// CLI adapter mock - must intercept the real factory module
// ---------------------------------------------------------------------------
const mockAdapterSpawn = vi.fn().mockResolvedValue(12345);
const mockAdapterSendInput = vi.fn().mockResolvedValue(undefined);
const acceptedInterruptResult = () => ({
  status: 'accepted' as const,
  completion: Promise.resolve({ status: 'interrupted' as const }),
});
const mockAdapterInterrupt = vi.fn(acceptedInterruptResult);
const mockAdapterTerminate = vi.fn().mockResolvedValue(undefined);
const mockAutoTitleMaybeGenerate = vi.fn().mockResolvedValue(undefined);
const mockAutoTitleClearInstance = vi.fn();
let mockAdapterName = 'claude-cli';

// Build a per-test adapter factory so we can get fresh adapters
function makeMockAdapter() {
  const adapter = new EventEmitter() as EventEmitter & {
    spawn: () => Promise<number>;
    sendInput: (msg: string, attachments?: unknown[]) => Promise<void>;
    interrupt: () => ReturnType<typeof acceptedInterruptResult>;
    terminate: (graceful: boolean) => Promise<void>;
    getName: () => string;
    getRuntimeCapabilities: () => {
      supportsResume: boolean;
      supportsForkSession: boolean;
      supportsNativeCompaction: boolean;
      supportsPermissionPrompts: boolean;
      supportsDeferPermission: boolean;
      selfManagedAutoCompaction: boolean;
    };
    formatter: { isWritable: () => boolean };
  };
  adapter.spawn = mockAdapterSpawn;
  adapter.sendInput = mockAdapterSendInput;
  adapter.interrupt = mockAdapterInterrupt;
  adapter.terminate = mockAdapterTerminate;
  adapter.getName = () => mockAdapterName;
  adapter.getRuntimeCapabilities = () => ({
    supportsResume: true,
    supportsForkSession: false,
    supportsNativeCompaction: false,
    supportsPermissionPrompts: false,
    supportsDeferPermission: false,
    selfManagedAutoCompaction: false,
  });
  adapter.formatter = { isWritable: () => true };
  return adapter;
}

vi.mock('../../cli/adapters/adapter-factory', () => ({
  createCliAdapter: mockCreateCliAdapter,
  // Return the concretely requested CLI (available), falling back to claude
  // for 'auto'. Provider-swap tests override with mockResolvedValueOnce to
  // simulate a missing target CLI.
  resolveCliType: vi.fn(async (requested?: string) =>
    requested && requested !== 'auto' ? requested : 'claude'),
  getCliDisplayName: vi.fn((cli: string) => (cli === 'claude' ? 'Claude Code' : cli)),
}));

vi.mock('../../local-models/local-model-inventory-service', () => ({
  getLocalModelInventoryService: () => ({
    list: () => mockLocalModelInventory,
    refresh: mockLocalModelRefresh,
  }),
}));

vi.mock('../../cli/hooks/hook-path-resolver', () => ({
  ensureHookScript: vi.fn(() => '/tmp/test-hooks/defer-permission-hook.mjs'),
}));

vi.mock('../auto-title-service', () => ({
  getAutoTitleService: vi.fn(() => ({
    maybeGenerateTitle: mockAutoTitleMaybeGenerate,
    clearInstance: mockAutoTitleClearInstance,
  })),
}));

// ---------------------------------------------------------------------------
// CLI detection mock (used by adapter factory's resolveCliType in real code)
// ---------------------------------------------------------------------------
vi.mock('../../cli/cli-detection', () => ({
  CliDetectionService: {
    getInstance: vi.fn().mockReturnValue({
      detectAll: vi.fn().mockResolvedValue({ available: [{ name: 'claude', version: '2.0.0' }] }),
      detectCli: vi.fn().mockResolvedValue({ name: 'claude', version: '2.0.0' }),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Supervisor tree mock
// ---------------------------------------------------------------------------
const mockSupervisorTree = {
  registerInstance: vi.fn().mockReturnValue({
    supervisorNodeId: 'supervisor-node-1',
    workerNodeId: 'worker-node-1',
  }),
  unregisterInstance: vi.fn(),
  terminate: vi.fn(),
};

vi.mock('../../process', () => ({
  getSupervisorTree: vi.fn(() => mockSupervisorTree),
}));

vi.mock('../../process/supervisor-tree', () => ({
  getSupervisorTree: vi.fn(() => mockSupervisorTree),
  SupervisorTree: {
    getInstance: vi.fn(() => mockSupervisorTree),
    _resetForTesting: vi.fn(),
  },
}));

vi.mock('../../process/resource-governor', () => ({
  getResourceGovernor: vi.fn(() => ({
    getCreationBlockReason: mockResourceGovernorGetCreationBlockReason,
  })),
}));

// ---------------------------------------------------------------------------
// Agent registry mock
// ---------------------------------------------------------------------------
const mockResolveAgent = vi.fn().mockResolvedValue({
  id: 'build',
  name: 'Build Agent',
  mode: 'build',
  systemPrompt: 'You are a helpful build agent.',
  permissions: { allowFileRead: true, allowFileWrite: true, allowShellExec: true },
  modelOverride: undefined,
});

vi.mock('../../agents/agent-registry', () => ({
  getAgentRegistry: vi.fn(() => ({
    resolveAgent: mockResolveAgent,
  })),
}));

vi.mock('../../../shared/types/agent.types', () => ({
  getDefaultAgent: vi.fn(() => ({ id: 'build', name: 'Build', mode: 'build' })),
  getAgentById: vi.fn(() => ({ id: 'build', name: 'Build', mode: 'build' })),
}));

// ---------------------------------------------------------------------------
// Security / permission manager mock
// ---------------------------------------------------------------------------
const mockPermissionManager = {
  loadProjectRules: vi.fn(),
  checkPermission: vi.fn().mockReturnValue({ action: 'prompt' }),
  recordUserDecision: vi.fn(),
};

vi.mock('../../security/permission-manager', () => ({
  getPermissionManager: vi.fn(() => mockPermissionManager),
}));

vi.mock('../../../shared/utils/permission-mapper', () => ({
  getDisallowedTools: vi.fn().mockReturnValue([]),
}));

// ---------------------------------------------------------------------------
// Orchestration protocol mock
// ---------------------------------------------------------------------------
vi.mock('../../orchestration/orchestration-protocol', () => ({
  generateChildPrompt: vi.fn().mockReturnValue('child prompt'),
  generateOrchestrationPrompt: vi.fn().mockReturnValue('[ORCHESTRATION SYSTEM PROMPT]'),
  formatCommandResponse: vi.fn((action: string, success: boolean, data: unknown) =>
    `[Orchestrator Response]\nAction: ${action}\nStatus: ${success ? 'SUCCESS' : 'FAILED'}\n${JSON.stringify(data)}\n[/Orchestrator Response]`
  ),
  detectsSchedulingIntent: vi.fn().mockReturnValue(false),
  SCHEDULING_INTENT_REMINDER: '[SCHEDULING REMINDER]',
}));

// ---------------------------------------------------------------------------
// Command manager / markdown registry mocks
// ---------------------------------------------------------------------------
vi.mock('../../commands/command-manager', () => ({
  getCommandManager: vi.fn(() => ({
    executeCommandString: mockCommandExecuteCommandString,
  })),
}));

vi.mock('../../orchestration/loop-coordinator', () => ({
  getLoopCoordinator: vi.fn(() => mockLoopCoordinator),
}));

vi.mock('../../orchestration/loop-store', () => ({
  getLoopStore: vi.fn(() => mockLoopStore),
}));

vi.mock('../../orchestration/loop-start-config', () => ({
  prepareLoopStartConfig: mockPrepareLoopStartConfig,
}));

vi.mock('../../ipc/handlers/loop-transcript-dispatch', () => ({
  appendLoopStartPrompt: mockAppendLoopStartPrompt,
}));

vi.mock('../../chats', () => ({
  getChatService: vi.fn(() => mockChatService),
}));

vi.mock('../../commands/markdown-command-registry', () => ({
  getMarkdownCommandRegistry: vi.fn(() => ({
    getCommand: vi.fn().mockResolvedValue(null),
  })),
}));

// ---------------------------------------------------------------------------
// Task manager mock
// ---------------------------------------------------------------------------
const mockTaskManager = {
  startTimeoutChecker: vi.fn(),
  stopTimeoutChecker: vi.fn(),
  getTaskByChildId: vi.fn().mockReturnValue(null),
  cleanupChildTasks: vi.fn(),
};

vi.mock('../../orchestration/task-manager', () => ({
  getTaskManager: vi.fn(() => mockTaskManager),
}));

// ---------------------------------------------------------------------------
// Child result storage mock
// ---------------------------------------------------------------------------
const mockChildResultStorage = {
  hasResult: vi.fn().mockReturnValue(false),
  storeFromOutputBuffer: vi.fn().mockResolvedValue(undefined),
  getChildSummary: vi.fn().mockResolvedValue(null),
};

vi.mock('../../orchestration/child-result-storage', () => ({
  getChildResultStorage: vi.fn(() => mockChildResultStorage),
}));

// ---------------------------------------------------------------------------
// Routing mock
// ---------------------------------------------------------------------------
vi.mock('../../routing', () => ({
  getModelRouter: vi.fn(() => ({
    route: vi.fn().mockReturnValue({ model: 'claude-sonnet', provider: 'claude' }),
  })),
}));

// ---------------------------------------------------------------------------
// RLM context manager mock
// Must be defined inline in the factory (vi.mock is hoisted, cannot reference
// variables declared in the module scope at the time of hoisting)
// ---------------------------------------------------------------------------
vi.mock('../../rlm/context-manager', () => {
  const rlmInstance = {
    initSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn(),
    query: vi.fn().mockResolvedValue({ sections: [] }),
    ingest: vi.fn(),
    createStore: vi.fn().mockResolvedValue('store-id'),
    deleteStore: vi.fn().mockResolvedValue(undefined),
  };
  const RLMContextManagerMock = vi.fn().mockImplementation(() => rlmInstance);
  Object.assign(RLMContextManagerMock, {
    getInstance: vi.fn().mockReturnValue(rlmInstance),
  });
  return { RLMContextManager: RLMContextManagerMock };
});

// ---------------------------------------------------------------------------
// Memory mocks
// ---------------------------------------------------------------------------
vi.mock('../../memory', () => ({
  getUnifiedMemory: vi.fn(() => ({
    retrieve: vi.fn().mockResolvedValue({ results: [] }),
    processInput: vi.fn().mockResolvedValue(undefined),
    ingest: vi.fn(),
  })),
  getMemoryMonitor: vi.fn(() => ({
    on: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    getStats: vi.fn().mockReturnValue({ heapUsedMB: 100 }),
    getPressureLevel: vi.fn().mockReturnValue('normal'),
  })),
  getOutputStorageManager: vi.fn(() => ({
    appendMessages: vi.fn().mockResolvedValue(undefined),
    loadMessages: vi.fn().mockResolvedValue([]),
    getInstanceStats: vi.fn().mockReturnValue({ totalMessages: 0 }),
    getTotalStats: vi.fn().mockReturnValue({ totalMessages: 0, totalSizeMB: 0 }),
    deleteInstance: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ---------------------------------------------------------------------------
// History manager mock
// ---------------------------------------------------------------------------
vi.mock('../../history', () => ({
  getHistoryManager: vi.fn(() => ({
    archiveInstance: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ---------------------------------------------------------------------------
// Policy adapter mock
// ---------------------------------------------------------------------------
vi.mock('../../observation/policy-adapter', () => ({
  getPolicyAdapter: vi.fn(() => ({
    buildObservationContext: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock('../../memory/wake-context-builder', () => ({
  getWakeContextBuilder: vi.fn(() => ({
    getWakeUpText: vi.fn(() => ''),
  })),
}));

vi.mock('../../memory/project-memory-brief', () => ({
  getProjectMemoryBriefService: vi.fn(() => ({
    buildBrief: mockProjectMemoryBuildBrief,
  })),
}));

vi.mock('../context-worker-client', () => ({
  getContextWorkerClient: vi.fn(() => ({
    buildProjectMemoryBrief: mockContextWorkerBuildProjectMemoryBrief,
  })),
}));

vi.mock('../../prompt-history/prompt-history-service', () => ({
  getPromptHistoryService: vi.fn(() => ({
    record: mockPromptHistoryRecord,
    clearForInstance: mockPromptHistoryClearForInstance,
  })),
}));

vi.mock('../../session/session-continuity', () => ({
  getSessionContinuityManager: vi.fn(() => mockSessionContinuity),
  getSessionContinuityManagerIfInitialized: vi.fn(() => mockSessionContinuity),
}));

vi.mock('../../memory/project-knowledge-coordinator', () => ({
  getProjectKnowledgeCoordinator: vi.fn(() => ({
    ensureProjectKnown: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ---------------------------------------------------------------------------
// JIT loader mock
// ---------------------------------------------------------------------------
vi.mock('../../context/jit-loader', () => {
  const jitInstance = {
    load: vi.fn().mockResolvedValue(null),
    registerLoader: vi.fn(),
    unregisterLoader: vi.fn(),
    registerResource: vi.fn(),
    unregisterResource: vi.fn(),
    clearResources: vi.fn(),
    loadAll: vi.fn().mockResolvedValue([]),
  };
  return {
    JITContextLoader: vi.fn().mockImplementation(() => jitInstance),
    getJITLoader: vi.fn(() => jitInstance),
    FileSystemLoader: vi.fn().mockImplementation(() => ({
      load: vi.fn().mockResolvedValue(null),
    })),
    MemoryStoreLoader: vi.fn().mockImplementation(() => ({
      load: vi.fn().mockResolvedValue(null),
    })),
  };
});

// ---------------------------------------------------------------------------
// Hook manager mock
// ---------------------------------------------------------------------------
vi.mock('../../hooks/hook-manager', () => ({
  getHookManager: vi.fn(() => ({
    executeHook: vi.fn().mockResolvedValue(undefined),
    triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }),
  })),
}));

// ---------------------------------------------------------------------------
// Error recovery mock
// ---------------------------------------------------------------------------
vi.mock('../../core/error-recovery', () => ({
  getErrorRecoveryManager: vi.fn(() => ({
    handleError: vi.fn(),
  })),
}));

vi.mock('../../../shared/types/error-recovery.types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/types/error-recovery.types')>();
  return {
    ...actual,
    ErrorCategory: {
      ...actual.ErrorCategory,
      PROCESS: 'process',
      TIMEOUT: 'timeout',
    },
  };
});

// ---------------------------------------------------------------------------
// Provider types mock
// ---------------------------------------------------------------------------
vi.mock('../../../shared/types/provider.types', async (importOriginal) => ({
  // Spread the real module first. Module-eval-time consumers read constants we
  // don't stub here (settings-defaults.ts reads CLAUDE_MODELS/OPENAI_MODELS at
  // module scope), and a bare factory drops them, blowing up the whole suite
  // before a single test runs. The explicit stubs below still override.
  ...(await importOriginal<typeof import('../../../shared/types/provider.types')>()),
  COPILOT_MODELS: {
    AUTO: 'auto',
    CLAUDE_SONNET_46: 'claude-sonnet-4.6',
    CLAUDE_SONNET_45: 'claude-sonnet-4.5',
    CLAUDE_HAIKU_45: 'claude-haiku-4.5',
    CLAUDE_OPUS_47: 'claude-opus-4.7',
    CLAUDE_OPUS_46: 'claude-opus-4.6',
    CLAUDE_SONNET_4: 'claude-sonnet-4',
    GPT55: 'gpt-5.5',
    GPT53_CODEX: 'gpt-5.3-codex',
    GPT52_CODEX: 'gpt-5.2-codex',
    GPT52: 'gpt-5.2',
    GPT55_MINI: 'gpt-5.5-mini',
    GPT5_MINI: 'gpt-5-mini',
    GPT41: 'gpt-4.1',
    GEMINI_3_1_PRO: 'gemini-3.1-pro-preview',
    GEMINI_3_PRO: 'gemini-3-pro-preview',
    GEMINI_3_FLASH: 'gemini-3-flash-preview',
    GEMINI_25_PRO: 'gemini-2.5-pro',
    GEMINI_25_FLASH: 'gemini-2.5-flash',
  },
  CLAUDE_LEGACY_PRICING_ALIASES: {
    SONNET_35: 'claude-3-5-sonnet',
    HAIKU_35: 'claude-3-5-haiku',
    OPUS_3: 'claude-3-opus',
    SONNET_3: 'claude-3-sonnet',
    HAIKU_3: 'claude-3-haiku',
  },
  MAX_MODEL_ID_LENGTH: 512,
  getModelsForProvider: mockGetModelsForProvider,
  getKnownCatalogModelIdsForProvider: mockGetKnownCatalogModelIdsForProvider,
  getDefaultModelForCli: mockGetDefaultModelForCli,
  // Read at module-load time by cursor-cli-adapter.models.ts
  // (`PROVIDER_MODEL_LIST['cursor'] ?? []`), which is now pulled in via
  // create-validation-helpers' dynamic Cursor model lookup. Empty is fine —
  // this spec doesn't exercise the Cursor model catalog.
  PROVIDER_MODEL_LIST: {},
  getProviderModelContextWindow: mockGetProviderModelContextWindow,
  isModelTier: mockIsModelTier,
  looksLikeCodexModelId: mockLooksLikeCodexModelId,
  resolveModelForTier: mockResolveModelForTier,
  // Consumed at module load time by src/main/rlm/token-counter.ts via Object.entries().
  // This spec does not exercise cost/pricing paths, so an empty table is sufficient.
  MODEL_PRICING: {},
}));

// ---------------------------------------------------------------------------
// Supervision types mock
// ---------------------------------------------------------------------------
vi.mock('../../../shared/types/supervision.types', () => ({
  createDefaultContextInheritance: vi.fn().mockReturnValue({
    inheritWorkingDirectory: true,
    inheritYoloMode: false,
    inheritAgentSettings: false,
  }),
}));

// ---------------------------------------------------------------------------
// Constants mock
// ---------------------------------------------------------------------------
vi.mock('../../../shared/constants/limits', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../shared/constants/limits')>();
  return {
    ...actual,
    LIMITS: {
      ...actual.LIMITS,
      OUTPUT_BATCH_INTERVAL_MS: 100,
      OUTPUT_BUFFER_MAX_SIZE: 500,
      DEFAULT_MAX_CONTEXT_TOKENS: 1000000,
    },
  };
});

// ---------------------------------------------------------------------------
// ID generator mock
// ---------------------------------------------------------------------------
let idCounter = 0;
vi.mock('../../../shared/utils/id-generator', () => ({
  generateId: vi.fn(() => `test-id-${++idCounter}`),
  generateInstanceId: vi.fn(() => `test-id-${++idCounter}`),
  generatePrefixedId: vi.fn((prefix: string) => `${prefix}-test-${++idCounter}`),
  generateShortId: vi.fn(() => `short-${++idCounter}`),
  generateToken: vi.fn(() => `token-${++idCounter}`),
  generateTimestampedId: vi.fn(() => `ts-${++idCounter}`),
  generateOrchestrationId: vi.fn((type: string) => `${type}-${++idCounter}`),
  INSTANCE_ID_PREFIXES: { claude: 'c', gemini: 'g', codex: 'x', copilot: 'p', generic: 'i' },
  ORCHESTRATION_ID_PREFIXES: { debate: 'd', consensus: 'n', verification: 'v', worktree: 'w' },
}));

// ---------------------------------------------------------------------------
// fs/promises mock (used by lifecycle for CLAUDE.md loading)
// ---------------------------------------------------------------------------
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    writeFile: vi.fn().mockResolvedValue(undefined),
    mkdir: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
  };
});

// ---------------------------------------------------------------------------
// fs mock (sync, used by settings manager migration + MCP config check)
// ---------------------------------------------------------------------------
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    copyFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
  };
});

// ---------------------------------------------------------------------------
// Learning module mocks
// ---------------------------------------------------------------------------
vi.mock('../../learning/outcome-tracker', () => ({
  OutcomeTracker: {
    getInstance: vi.fn().mockReturnValue({
      recordOutcome: vi.fn(),
      initialize: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock('../../learning/strategy-learner', () => ({
  StrategyLearner: {
    getInstance: vi.fn().mockReturnValue({
      getRecommendation: vi.fn(() => null),
      learnFromOutcome: vi.fn(),
      initialize: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

// ---------------------------------------------------------------------------
// Command types mock
// ---------------------------------------------------------------------------
vi.mock('../../../shared/types/command.types', () => ({
  parseCommandString: vi.fn().mockReturnValue(null),
  resolveTemplate: vi.fn((template: string) => template),
}));

// ---------------------------------------------------------------------------
// RLM database mock (avoid SQLite binary issues)
// ---------------------------------------------------------------------------
vi.mock('../../persistence/rlm-database', () => ({
  RLMDatabase: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockReturnValue([]),
    insert: vi.fn(),
    close: vi.fn(),
  })),
  getRLMDatabase: vi.fn(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockReturnValue([]),
    insert: vi.fn(),
    close: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Codemem mock — CodememService's field initializer calls `new Database()`
// from better-sqlite3, whose .node binary is compiled for Electron's ABI
// (postinstall rebuilds for Electron). Under plain Node.js (Vitest runtime),
// that ABI mismatch throws ERR_DLOPEN_FAILED on class instantiation, which
// cascades into spawn failure → `failed` state → InvalidTransitionError during
// teardown. Mocking the module prevents any CodememService construction.
// The test surface we need: getCodemem() must return an object with
// isEnabled() (used by warmCodememWithTimeout to short-circuit).
// ---------------------------------------------------------------------------
vi.mock('../../codemem', () => {
  const stub = {
    isEnabled: vi.fn(() => false),
    isLspEnabled: vi.fn(() => false),
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    warmWorkspace: vi.fn().mockResolvedValue({ ready: false, filePath: null }),
    store: {},
    indexManager: {},
    periodicScan: {},
    gateway: {},
    facade: {},
  };
  return {
    CodememService: vi.fn(() => stub),
    getCodemem: vi.fn(() => stub),
    initializeCodemem: vi.fn().mockResolvedValue(stub),
    resetCodememForTesting: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Now import the class under test (after all mocks are defined)
// ---------------------------------------------------------------------------

import { InstanceManager } from '../instance-manager';
import { generateChildPrompt } from '../../orchestration/orchestration-protocol';
import { getWorkerNodeRegistry, WorkerNodeRegistry } from '../../remote-node/worker-node-registry';
import type { RoutingDecision } from '../../routing';
import type { SpawnChildCommand } from '../../orchestration/orchestration-protocol';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_WORKING_DIR = '/tmp/test-project';

function createManager(): InstanceManager {
  return new InstanceManager();
}

function registerWindowsWorkerNode(): void {
  getWorkerNodeRegistry().registerNode({
    id: 'node-win', name: 'windows-pc', address: '127.0.0.1', status: 'connected', activeInstances: 0,
    capabilities: {
      platform: 'win32', arch: 'x64', cpuCores: 16, totalMemoryMB: 32768, availableMemoryMB: 24000, supportedClis: ['claude'],
      hasBrowserRuntime: false, hasBrowserMcp: false, hasAndroidMcp: false, hasDocker: false, maxConcurrentInstances: 4,
      workingDirectories: [TEST_WORKING_DIR], browsableRoots: [TEST_WORKING_DIR], discoveredProjects: [],
    },
  });
}

function seedThisDeviceLocalModel(modelId = 'qwen'): void {
  mockLocalModelInventory.length = 0;
  mockLocalModelInventory.push({
    selectorId: `lm://this-device/ollama/ollama/${modelId}`,
    source: 'this-device',
    endpointProvider: 'ollama',
    endpointId: 'ollama',
    modelId,
    healthy: true,
  });
  mockLocalModelRefresh.mockResolvedValue(mockLocalModelInventory);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InstanceManager', () => {
  let manager: InstanceManager;
  let originalHome: string | undefined;
  let originalUserProfile: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    idCounter = 0;
    originalHome = process.env['HOME'];
    originalUserProfile = process.env['USERPROFILE'];
    process.env['HOME'] = '/tmp/test-empty-home';
    process.env['USERPROFILE'] = '/tmp/test-empty-home';

    // Restore default mocks after clearAllMocks wipes them
    mockAdapterSpawn.mockResolvedValue(12345);
    mockAdapterSendInput.mockResolvedValue(undefined);
    mockAdapterInterrupt.mockImplementation(acceptedInterruptResult);
    mockAdapterTerminate.mockResolvedValue(undefined);
    mockCreateCliAdapter.mockImplementation(() => makeMockAdapter());
    mockCommandExecuteCommandString.mockReset();
    mockCommandExecuteCommandString.mockResolvedValue(null);
    mockIndexedBuildContext.mockReset();
    mockIndexedBuildContext.mockResolvedValue(null);
    mockIndexedFormatContextBlock.mockReset();
    mockIndexedFormatContextBlock.mockReturnValue(null);
    mockIndexedBuildFastPathResult.mockReset();
    mockIndexedBuildFastPathResult.mockResolvedValue(null);
    mockAutoTitleMaybeGenerate.mockResolvedValue(undefined);
    mockAutoTitleClearInstance.mockReset();
    mockContextWorkerBuildProjectMemoryBrief.mockReset();
    mockContextWorkerBuildProjectMemoryBrief.mockResolvedValue(null);
    mockProjectMemoryBuildBrief.mockResolvedValue({
      text: '',
      sections: [],
      sources: [],
      stats: {
        projectKey: TEST_WORKING_DIR,
        candidatesScanned: 0,
        candidatesIncluded: 0,
        truncated: false,
      },
    });
    mockPromptHistoryRecord.mockReset();
    mockPromptHistoryClearForInstance.mockReset();
    mockSessionContinuity.startTracking.mockResolvedValue(undefined);
    mockSessionContinuity.stopTracking.mockResolvedValue(undefined);
    mockSessionContinuity.resumeSession.mockResolvedValue(null);
    mockSessionContinuity.updateState.mockResolvedValue(undefined);
    mockSessionContinuity.markNativeResumeFailed.mockResolvedValue(undefined);
    mockSessionContinuity.writeThroughIdentityLocked.mockResolvedValue(undefined);
    mockSessionContinuity.createSnapshot.mockResolvedValue({ id: 'snapshot-1' });
    mockAdapterName = 'claude-cli';
    mockLoopCoordinator.startLoop.mockImplementation(async (chatId: string, config: unknown) => ({
      id: 'loop-goal-1',
      chatId,
      config,
      status: 'running',
      startedAt: 1,
      endedAt: null,
      currentStage: 'IMPLEMENT',
      totalIterations: 0,
      totalTokens: 0,
      totalCostCents: 0,
      lastIteration: null,
      pendingInterventions: [],
      errors: [],
      filesChanged: [],
      convergenceNote: null,
      manualReviewOnly: true,
    }));
    mockLoopCoordinator.getActiveLoops.mockReturnValue([]);
    mockLoopCoordinator.pauseLoop.mockReturnValue(true);
    mockLoopCoordinator.resumeLoop.mockReturnValue(true);
    mockLoopCoordinator.cancelLoop.mockResolvedValue(true);
    mockLoopCoordinator.getLoop.mockReturnValue(undefined);
    mockLoopStore.upsertRun.mockReset();
    mockPrepareLoopStartConfig.mockImplementation(async (config: unknown) => config);
    mockAppendLoopStartPrompt.mockReset();
    mockChatService.tryGetChat.mockReturnValue(null);

    mockResolveAgent.mockResolvedValue({
      id: 'build',
      name: 'Build Agent',
      mode: 'build',
      systemPrompt: 'You are a helpful build agent.',
      permissions: { allowFileRead: true, allowFileWrite: true, allowShellExec: true },
      modelOverride: undefined,
    });

    mockSupervisorTree.registerInstance.mockReturnValue({
      supervisorNodeId: 'supervisor-node-1',
      workerNodeId: 'worker-node-1',
    });

    mockTaskManager.startTimeoutChecker.mockImplementation(() => undefined);
    mockSettingsGetAll.mockReturnValue({ ...mockSettingsData });
    mockGetModelsForProvider.mockReset();
    mockGetModelsForProvider.mockReturnValue([]);
    mockGetKnownCatalogModelIdsForProvider.mockReset();
    mockGetKnownCatalogModelIdsForProvider.mockReturnValue([]);
    mockGetDefaultModelForCli.mockReset();
    mockGetDefaultModelForCli.mockImplementation((provider: string) => {
      if (provider === 'claude') return 'opus';
      if (provider === 'codex') return 'gpt-5.3-codex';
      if (provider === 'gemini') return 'gemini-3.1-pro-preview';
      return 'auto';
    });
    mockGetProviderModelContextWindow.mockReset();
    mockGetProviderModelContextWindow.mockImplementation((provider: string, model?: string) => {
      if (provider === 'claude' && model?.endsWith('[1m]')) return 1000000;
      if (provider === 'claude' && model?.includes('opus')) return 1000000;
      if (provider === 'claude') return 1000000;
      return 200000;
    });
    mockIsModelTier.mockReset();
    mockIsModelTier.mockReturnValue(false);
    mockLooksLikeCodexModelId.mockReset();
    mockLooksLikeCodexModelId.mockReturnValue(false);
    mockResolveModelForTier.mockReset();
    mockResolveModelForTier.mockReturnValue(undefined);
    mockResourceGovernorGetCreationBlockReason.mockReturnValue(null);
    mockLocalModelInventory.length = 0;
    mockLocalModelRefresh.mockReset();
    mockLocalModelRefresh.mockResolvedValue(mockLocalModelInventory);
    WorkerNodeRegistry._resetForTesting();

    manager = createManager();
  });

  afterEach(async () => {
    try {
      manager.destroy();
    } catch {
      // Ignore errors on destroy in cleanup
    }

    // Drain async adapter.terminate leftovers from terminateInstance /
    // destroy so the next test's mockAdapterTerminate assertions stay clean.
    await new Promise((resolve) => setTimeout(resolve, 0));

    if (originalHome === undefined) {
      delete process.env['HOME'];
    } else {
      process.env['HOME'] = originalHome;
    }

    if (originalUserProfile === undefined) {
      delete process.env['USERPROFILE'];
    } else {
      process.env['USERPROFILE'] = originalUserProfile;
    }
  });

  describe('changeModel', () => {
    it('reseeds context totals when switching to a 1M Claude model', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        modelOverride: 'sonnet',
      });
      await instance.readyPromise;

      expect(instance.contextUsage.total).toBe(1000000);

      const updated = await manager.changeModel(instance.id, 'sonnet[1m]');

      expect(updated.currentModel).toBe('sonnet[1m]');
      expect(updated.contextUsage.total).toBe(1000000);
    });

    it('passes reasoning effort through model respawn options', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        modelOverride: 'sonnet',
      });
      await instance.readyPromise;
      mockCreateCliAdapter.mockClear();

      const updated = await (manager as InstanceManager & {
        changeModel: (instanceId: string, newModel: string, reasoningEffort?: 'high') => Promise<typeof instance>;
      }).changeModel(instance.id, 'sonnet[1m]', 'high');

      expect(updated.reasoningEffort).toBe('high');
      expect(mockCreateCliAdapter).toHaveBeenCalledWith(
        'claude',
        expect.objectContaining({
          model: 'sonnet[1m]',
          reasoningEffort: 'high',
        }),
        expect.anything(),
      );
    });

    it('respawns with a local-model runtime target when changing to a local model', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        modelOverride: 'sonnet',
      });
      await instance.readyPromise;
      mockCreateCliAdapter.mockClear();

      const modelRuntimeTarget = {
        kind: 'local-model' as const,
        source: 'this-device' as const,
        selectorId: 'lm://this-device/ollama/ollama/qwen',
        endpointProvider: 'ollama' as const,
        endpointId: 'ollama',
        modelId: 'qwen',
      };
      seedThisDeviceLocalModel(modelRuntimeTarget.modelId);
      const updated = await (manager as InstanceManager & {
        changeModel: (
          instanceId: string,
          newModel: string,
          reasoningEffort: undefined,
          modelRuntimeTargetArg: typeof modelRuntimeTarget,
        ) => Promise<typeof instance>;
      }).changeModel(instance.id, modelRuntimeTarget.modelId, undefined, modelRuntimeTarget);

      expect(updated.currentModel).toBe('qwen');
      expect(updated.runtimeSummary).toEqual({
        kind: 'local-model',
        label: 'qwen on this device',
        source: 'this-device',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        modelId: 'qwen',
        selectorId: modelRuntimeTarget.selectorId,
      });
      expect(mockCreateCliAdapter).toHaveBeenCalledWith(
        'claude',
        expect.objectContaining({
          model: 'qwen',
          modelRuntimeTarget,
        }),
        expect.anything(),
      );
    });

    it('starts a fresh Claude session when changing models so native resume cannot retain the old model', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        modelOverride: 'opus[1m]',
      });
      await instance.readyPromise;
      instance.outputBuffer.push(
        {
          id: 'user-before-model-change',
          timestamp: Date.now() - 1000,
          type: 'user',
          content: 'Please double check where we are.',
        },
        {
          id: 'assistant-before-model-change',
          timestamp: Date.now(),
          type: 'assistant',
          content: 'We are midway through the task.',
        },
      );
      mockCreateCliAdapter.mockClear();

      await manager.changeModel(instance.id, 'claude-opus-4-8');

      expect(mockCreateCliAdapter).toHaveBeenCalledWith(
        'claude',
        expect.objectContaining({
          model: 'claude-opus-4-8',
          resume: false,
          forkSession: false,
        }),
        expect.anything(),
      );
      expect(instance.currentModel).toBe('claude-opus-4-8');
      expect(mockAdapterSendInput).toHaveBeenCalledWith(
        expect.stringContaining('replay fallback (model-change)'),
      );
    });

    it('swaps provider with a fresh session (never native resume) and clears the resume cursor', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        modelOverride: 'sonnet',
      });
      await instance.readyPromise;
      expect(instance.provider).toBe('claude');
      instance.outputBuffer.push(
        {
          id: 'user-before-swap',
          timestamp: Date.now() - 1000,
          type: 'user',
          content: 'Please double check where we are.',
        },
        {
          id: 'assistant-before-swap',
          timestamp: Date.now(),
          type: 'assistant',
          content: 'We are midway through the task.',
        },
      );
      mockCreateCliAdapter.mockClear();
      mockSessionContinuity.writeThroughIdentityLocked.mockClear();

      const updated = await manager.changeModel(instance.id, 'gpt-5.5', undefined, undefined, 'codex');

      expect(updated.provider).toBe('codex');
      expect(updated.currentModel).toBe('gpt-5.5');
      expect(mockCreateCliAdapter).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({
          model: 'gpt-5.5',
          resume: false,
          forkSession: false,
        }),
        expect.anything(),
      );
      // Replay continuity carries the context; the old provider's session and
      // resume cursor are gone for good.
      expect(mockAdapterSendInput).toHaveBeenCalledWith(
        expect.stringContaining('provider-change'),
      );
      expect(mockAdapterSendInput).toHaveBeenCalledWith(
        expect.stringContaining('Provider changed from claude'),
      );
      expect(mockSessionContinuity.writeThroughIdentityLocked).toHaveBeenCalledWith(
        instance.id,
        expect.objectContaining({ resumeCursor: null }),
      );
      // The tracked session snapshot must adopt the new provider so a later
      // history restore spawns the swapped CLI, not the pre-swap one.
      expect(mockSessionContinuity.updateState).toHaveBeenCalledWith(
        instance.id,
        expect.objectContaining({ provider: 'codex', modelId: 'gpt-5.5' }),
      );
    });

    it('falls back to the remembered per-provider model when the swap has no explicit model', async () => {
      mockSettingsGetAll.mockReturnValue({
        ...mockSettingsData,
        defaultModelByProvider: { codex: 'gpt-5.5' },
      } as ReturnType<typeof mockSettingsGetAll>);
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        modelOverride: 'sonnet',
      });
      await instance.readyPromise;
      mockCreateCliAdapter.mockClear();

      const updated = await manager.changeModel(instance.id, undefined, undefined, undefined, 'codex');

      expect(updated.provider).toBe('codex');
      expect(updated.currentModel).toBe('gpt-5.5');
      expect(mockCreateCliAdapter).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({ model: 'gpt-5.5' }),
        expect.anything(),
      );
    });

    it('rejects a provider swap when the target CLI is not available', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        modelOverride: 'sonnet',
      });
      await instance.readyPromise;
      mockAdapterTerminate.mockClear();
      const { resolveCliType } = await import('../../cli/adapters/adapter-factory');
      vi.mocked(resolveCliType).mockResolvedValueOnce('claude'); // codex missing → silent fallback

      await expect(
        manager.changeModel(instance.id, 'gpt-5.5', undefined, undefined, 'codex'),
      ).rejects.toThrow('CLI is not installed or not available');

      expect(instance.provider).toBe('claude');
      expect(instance.currentModel).toBe('sonnet');
      // The old adapter must be untouched — availability fails before teardown.
      expect(mockAdapterTerminate).not.toHaveBeenCalled();
    });

    it('swapping A→B→A never attempts a native resume against a stale session', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        modelOverride: 'sonnet',
      });
      await instance.readyPromise;
      instance.outputBuffer.push({
        id: 'user-1', timestamp: Date.now(), type: 'user', content: 'hello',
      });

      await manager.changeModel(instance.id, 'gpt-5.5', undefined, undefined, 'codex');
      mockCreateCliAdapter.mockClear();
      await manager.changeModel(instance.id, 'claude-opus-4-8', undefined, undefined, 'claude');

      expect(instance.provider).toBe('claude');
      expect(mockCreateCliAdapter).toHaveBeenCalledWith(
        'claude',
        expect.objectContaining({ resume: false, forkSession: false }),
        expect.anything(),
      );
    });

    it('maps the reasoning effort onto the target provider during a swap', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        modelOverride: 'sonnet',
      });
      await instance.readyPromise;
      instance.reasoningEffort = 'max'; // Claude-only tier
      mockCreateCliAdapter.mockClear();

      const updated = await manager.changeModel(instance.id, 'gpt-5.5', undefined, undefined, 'codex');

      expect(updated.reasoningEffort).toBe('xhigh');
      expect(mockCreateCliAdapter).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({ reasoningEffort: 'xhigh' }),
        expect.anything(),
      );
    });
  });

  describe('requestModelChange (queue-aware)', () => {
    it('queues the change while busy instead of throwing, then applies on settle', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        modelOverride: 'sonnet',
      });
      await instance.readyPromise;
      manager.updateInstanceStatus(instance.id, 'ready');
      manager.updateInstanceStatus(instance.id, 'busy');
      mockCreateCliAdapter.mockClear();

      const queued = await manager.requestModelChange(instance.id, {
        provider: 'codex',
        model: 'gpt-5.5',
      });

      expect(queued.desiredRuntime).toEqual({ provider: 'codex', model: 'gpt-5.5' });
      expect(queued.provider).toBe('claude');
      expect(mockCreateCliAdapter).not.toHaveBeenCalled();

      // Settling into an input-waiting status auto-applies the parked change.
      manager.updateInstanceStatus(instance.id, 'idle');
      await new Promise<void>((resolve) => setImmediate(resolve));
      // The apply respawns asynchronously; give the mutex + spawn a beat.
      await vi.waitFor(() => {
        expect(instance.provider).toBe('codex');
      });
      expect(instance.desiredRuntime).toBeUndefined();
      expect(mockCreateCliAdapter).toHaveBeenCalledWith(
        'codex',
        expect.objectContaining({ model: 'gpt-5.5' }),
        expect.anything(),
      );
    });

    it('cancels a queued change when the live config is re-selected', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        modelOverride: 'sonnet',
      });
      await instance.readyPromise;
      manager.updateInstanceStatus(instance.id, 'ready');
      manager.updateInstanceStatus(instance.id, 'busy');
      mockCreateCliAdapter.mockClear();

      await manager.requestModelChange(instance.id, { provider: 'codex', model: 'gpt-5.5' });
      expect(instance.desiredRuntime).toBeDefined();

      await manager.requestModelChange(instance.id, {
        provider: 'claude',
        model: instance.currentModel,
      });
      expect(instance.desiredRuntime).toBeUndefined();
      expect(mockCreateCliAdapter).not.toHaveBeenCalled();
    });
  });

  describe('changeModel status gate', () => {
    it.each([
      'processing',
      'thinking_deeply',
      'waiting_for_permission',
      'respawning',
    ] as const)('rejects model changes while the instance status is %s', async (status) => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        modelOverride: 'sonnet',
      });
      await instance.readyPromise;
      instance.status = status;
      mockAdapterTerminate.mockClear();

      await expect(manager.changeModel(instance.id, 'sonnet[1m]')).rejects.toThrow(
        'Model changes are only available while the instance is waiting for user input.'
      );

      expect(instance.status).toBe(status);
      expect(instance.currentModel).toBe('sonnet');
      expect(mockAdapterTerminate).not.toHaveBeenCalled();
    });
  });

  describe('orchestration child prompts', () => {
    it('passes Windows worker runtime hints into generated child prompts', async () => {
      registerWindowsWorkerNode();
      const parent = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Parent',
      });
      await parent.readyPromise;
      vi.mocked(generateChildPrompt).mockClear();

      const command: SpawnChildCommand = {
        action: 'spawn_child',
        task: 'Capture diagnostics on the Windows worker',
        node: 'windows-pc',
      };
      const routingDecision: RoutingDecision = {
        model: 'claude-sonnet',
        complexity: 'moderate',
        tier: 'balanced',
        confidence: 0.9,
        reason: 'test routing',
      };

      await (manager as unknown as {
        createChildInstance: (
          parentId: string,
          command: SpawnChildCommand,
          routingDecision: RoutingDecision,
        ) => Promise<unknown>;
      }).createChildInstance(parent.id, command, routingDecision);

      expect(generateChildPrompt).toHaveBeenCalledWith(
        expect.any(String),
        parent.id,
        'Capture diagnostics on the Windows worker',
        undefined,
        undefined,
        { executionPlatform: 'win32', workerName: 'windows-pc' },
      );
    });
  });

  describe('event forwarding', () => {
    it('forwards instance:created from the lifecycle manager', async () => {
      const handler = vi.fn();
      manager.on('instance:created', handler);

      await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Event Forward Test',
      });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('does not double-emit instance:created for the same create call', async () => {
      const handler = vi.fn();
      manager.on('instance:created', handler);

      await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Single Emit Test',
      });

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('forwards stuck-process warnings as normalized output events', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Stuck Warning Test',
      });
      await instance.readyPromise;

      const handler = vi.fn();
      manager.on('provider:normalized-event', handler);

      const stuckDetector = (manager as unknown as { stuckDetector: EventEmitter }).stuckDetector;
      stuckDetector.emit('process:suspect-stuck', {
        instanceId: instance.id,
        elapsedMs: 300_000,
      });

      expect(handler).toHaveBeenCalledWith(expect.objectContaining({
        instanceId: instance.id,
        event: expect.objectContaining({
          kind: 'output',
          messageType: 'system',
          content: 'Instance may be stuck — no output for 300s. Will auto-restart if unresponsive.',
          metadata: expect.objectContaining({
            watchdogWarning: true,
            elapsedMs: 300_000,
          }),
        }),
      }));
    });
  });

});
