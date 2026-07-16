/**
 * InstanceManager createInstance Tests
 *
 * Split from instance-manager.spec.ts. Full mock preamble duplicated
 * (same pattern as instance-manager.normalized-event.spec.ts) so Vitest
 * mock hoisting stays reliable.
 *
 * Note: vi.mock() paths are resolved relative to THIS test file location:
 *   src/main/instance/__tests__/instance-manager.create.spec.ts
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
  defaultModelByProvider: {} as Record<string, string>,
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
  resolveCliType: vi.fn().mockResolvedValue('claude'),
  getCliDisplayName: vi.fn(() => 'Claude Code'),
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

  describe('createInstance', () => {
    it('creates instance with valid config', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'My Instance',
      });

      expect(instance).toBeDefined();
      expect(instance.workingDirectory).toBe(TEST_WORKING_DIR);
      expect(instance.displayName).toBe('My Instance');
    });

    it('refuses new instances while the resource governor reports an explicit creation limit', async () => {
      mockResourceGovernorGetCreationBlockReason.mockReturnValue('instance-limit');
      mockAdapterSpawn.mockClear();

      await expect(manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Blocked Instance',
      })).rejects.toThrow(/resource governor \(instance-limit\)/);

      expect(mockAdapterSpawn).not.toHaveBeenCalled();
    });

    it('rolls back create-time registrations when adapter spawn fails', async () => {
      const spawnFailure = new Error('spawn token=sk-test-1234567890abcdef failed');
      mockCreateCliAdapter.mockImplementation((_cliType, options) => {
        const adapter = makeMockAdapter();
        if ((options as { instanceId?: string } | undefined)?.instanceId) {
          adapter.spawn = vi.fn().mockRejectedValue(spawnFailure);
        }
        return adapter;
      });
      const removedPayloads: string[] = [];
      manager.on('instance:removed', (instanceId) => removedPayloads.push(instanceId));

      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Rollback Me',
      });
      const readyPromise = instance.readyPromise;

      expect(readyPromise).toBeDefined();
      await expect(readyPromise).rejects.toThrow('spawn token=sk-test-1234567890abcdef failed');

      expect(manager.getInstance(instance.id)).toBeUndefined();
      expect(manager.getAllInstances()).toHaveLength(0);
      expect(mockSupervisorTree.unregisterInstance).toHaveBeenCalledWith(instance.id);
      expect(mockAdapterTerminate).toHaveBeenCalled();
      expect(removedPayloads).toContain(instance.id);
    });

    it('assigns a unique ID to each instance', async () => {
      const a = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Instance A',
      });
      const b = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Instance B',
      });

      expect(a.id).toBeDefined();
      expect(b.id).toBeDefined();
      expect(a.id).not.toBe(b.id);
    });

    it('emits instance:created event', async () => {
      const createdPayloads: unknown[] = [];
      manager.on('instance:created', (payload) => createdPayloads.push(payload));

      await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Event Test Instance',
      });

      expect(createdPayloads).toHaveLength(1);
    });

    it('emits instance:created with serialized instance data', async () => {
      let createdPayload: unknown;
      manager.on('instance:created', (payload) => { createdPayload = payload; });

      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Serialized Test',
      });

      expect(createdPayload).toBeDefined();
      expect((createdPayload as { id: string }).id).toBe(instance.id);
    });

    it('sets parentId when parentId is provided in config', async () => {
      const parent = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Parent',
      });

      const child = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Child',
        parentId: parent.id,
      });

      expect(child.parentId).toBe(parent.id);
      expect(child.depth).toBe(1);
    });

    it('adds child to parent childrenIds list', async () => {
      const parent = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Parent',
      });

      const child = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Child',
        parentId: parent.id,
      });

      const updatedParent = manager.getInstance(parent.id);
      expect(updatedParent?.childrenIds).toContain(child.id);
    });

    it('stores instance so it can be retrieved afterwards', async () => {
      expect(manager.getAllInstances()).toHaveLength(0);

      await manager.createInstance({ workingDirectory: TEST_WORKING_DIR });

      expect(manager.getAllInstances()).toHaveLength(1);
    });

    it('creates instance with depth 0 for root instances', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
      });

      expect(instance.depth).toBe(0);
      expect(instance.parentId).toBeNull();
    });

    it('seeds a 1M context total for explicit Claude 1M models', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        modelOverride: 'sonnet[1m]',
      });

      // Phase 2 (background init) sets currentModel and contextUsage.
      // Await readyPromise so assertions see the fully-initialized state.
      await instance.readyPromise;

      expect(instance.currentModel).toBe('sonnet[1m]');
      expect(instance.contextUsage.total).toBe(1000000);
    });

    it('degrades a stale remembered model to the provider default and surfaces a note', async () => {
      mockSettingsGetAll.mockReturnValue({
        ...mockSettingsData,
        defaultModelByProvider: { claude: 'claude-retired-model' },
      });
      mockGetModelsForProvider.mockReturnValue([
        { id: 'opus', name: 'Opus', tier: 'powerful' },
      ]);

      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        provider: 'claude',
      });
      await instance.readyPromise;

      expect(instance.currentModel).toBe('opus');
      expect(mockCreateCliAdapter).toHaveBeenCalledWith(
        'claude',
        expect.objectContaining({ model: 'opus' }),
        expect.anything(),
      );
      expect(instance.outputBuffer).toContainEqual(expect.objectContaining({
        type: 'system',
        content: expect.stringContaining('claude-retired-model'),
        metadata: expect.objectContaining({
          kind: 'model-selection-degraded',
          provider: 'claude',
          requestedModel: 'claude-retired-model',
          fallbackModel: 'opus',
          reason: 'model-unavailable',
        }),
      }));
    });

    it('triggers auto-title for the initial prompt before Codex sendInput resolves', async () => {
      mockAdapterSendInput.mockImplementation(() => new Promise<void>((resolve) => { void resolve; }));

      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        provider: 'codex',
        initialPrompt: 'Investigate the failed deployment and summarize the root cause.',
      });

      await vi.waitFor(() => {
        expect(mockAutoTitleMaybeGenerate).toHaveBeenCalledWith(
          instance.id,
          'Investigate the failed deployment and summarize the root cause.',
          expect.any(Function),
          undefined,
          undefined, // no attachments on this initial prompt
        );
      });
      await vi.waitFor(() => {
        expect(mockAdapterSendInput).toHaveBeenCalledWith(
          'Investigate the failed deployment and summarize the root cause.',
          undefined,
        );
      });
    });

    it('prepends initial context only to the runtime send and keeps the visible prompt clean', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        initialOutputBuffer: [
          {
            id: 'prior-user',
            timestamp: Date.now(),
            type: 'user',
            content: 'context before the edit',
          },
        ],
        initialPrompt: 'edited question',
        initialContextBlock: '<conversation_history>context before the edit</conversation_history>',
      } as Parameters<InstanceManager['createInstance']>[0] & { initialContextBlock: string });
      await instance.readyPromise;

      expect(mockAdapterSendInput).toHaveBeenCalledWith(
        '<conversation_history>context before the edit</conversation_history>\n\nedited question',
        undefined,
      );

      const visibleUserMessages = instance.outputBuffer.filter((message) => message.type === 'user');
      expect(visibleUserMessages.map((message) => message.content)).toEqual([
        'context before the edit',
        'edited question',
      ]);
    });

    it('drops unsupported initial attachments and retries without failing the instance', async () => {
      const attachments = [
        { name: 'screenshot.png', type: 'image/png', size: 3, data: 'abc' },
      ];
      mockAdapterName = 'copilot-cli';
      mockAdapterSendInput
        .mockRejectedValueOnce(new Error('Copilot adapter does not currently support attachments in orchestrator mode.'))
        .mockResolvedValueOnce(undefined);

      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        initialPrompt: 'Inspect this screenshot.',
        attachments,
      });

      const readyPromise = instance.readyPromise;
      expect(readyPromise).toBeDefined();
      await expect(readyPromise).resolves.toBeUndefined();

      expect(mockAdapterSendInput).toHaveBeenNthCalledWith(1, 'Inspect this screenshot.', attachments);
      expect(mockAdapterSendInput).toHaveBeenNthCalledWith(2, 'Inspect this screenshot.', undefined);
      expect(
        instance.outputBuffer.some(
          (message) =>
            message.type === 'system'
            && /copilot-cli does not support image attachments in orchestrator mode/i.test(message.content),
        ),
      ).toBe(true);
      expect(instance.outputBuffer.some((message) => message.type === 'error')).toBe(false);
      expect(instance.status).toBe('idle');
    });

    it('injects the project memory brief into fresh root system prompts', async () => {
      mockContextWorkerBuildProjectMemoryBrief.mockResolvedValue({
        text: '## Project Memory Brief\n\nRelevant prior chat excerpts:\n- [2026-04-28 Claude] auth middleware fix',
        sections: [],
        sources: [{ id: 'history:1', type: 'history-transcript', projectPath: TEST_WORKING_DIR }],
        stats: {
          projectKey: TEST_WORKING_DIR,
          candidatesScanned: 1,
          candidatesIncluded: 1,
          truncated: false,
        },
      });

      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        initialPrompt: 'Check auth middleware',
      });
      await instance.readyPromise;

      const spawnCall = mockCreateCliAdapter.mock.calls.find((call) => {
        const options = call[1] as { systemPrompt?: string } | undefined;
        return typeof options?.systemPrompt === 'string';
      });
      const spawnOptions = spawnCall?.[1] as { systemPrompt?: string } | undefined;
      expect(spawnOptions?.systemPrompt).toContain('## Project Memory Brief');
      expect(spawnOptions?.systemPrompt).toContain('auth middleware fix');
      expect(mockContextWorkerBuildProjectMemoryBrief).toHaveBeenCalledWith(expect.objectContaining({
        projectPath: TEST_WORKING_DIR,
        instanceId: instance.id,
        initialPrompt: 'Check auth middleware',
      }));
      expect(mockProjectMemoryBuildBrief).not.toHaveBeenCalled();
      expect(mockAdapterSendInput).toHaveBeenCalledWith('Check auth middleware', undefined);
    });

    it('skips project memory brief for child instances, resumed sessions, and restore continuity', async () => {
      const parent = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Parent',
      });
      await parent.readyPromise;
      mockProjectMemoryBuildBrief.mockClear();
      mockContextWorkerBuildProjectMemoryBrief.mockClear();

      const child = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Child',
        parentId: parent.id,
        initialPrompt: 'child task',
      });
      await child.readyPromise;
      expect(mockContextWorkerBuildProjectMemoryBrief).not.toHaveBeenCalled();
      expect(mockProjectMemoryBuildBrief).not.toHaveBeenCalled();

      const resumed = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        resume: true,
        sessionId: 'session-resume',
      });
      await resumed.readyPromise;
      expect(mockContextWorkerBuildProjectMemoryBrief).not.toHaveBeenCalled();
      expect(mockProjectMemoryBuildBrief).not.toHaveBeenCalled();

      const restored = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        initialOutputBuffer: [
          { id: 'restored-user', timestamp: 1, type: 'user', content: 'old message' },
        ],
      });
      await restored.readyPromise;
      expect(mockContextWorkerBuildProjectMemoryBrief).not.toHaveBeenCalled();
      expect(mockProjectMemoryBuildBrief).not.toHaveBeenCalled();
    });

    it('falls back to the in-process project memory brief service when the worker has no result', async () => {
      mockContextWorkerBuildProjectMemoryBrief.mockResolvedValueOnce(null);
      mockProjectMemoryBuildBrief.mockResolvedValueOnce({
        text: '## Project Memory Brief\n\nFallback service memory',
        sections: [],
        sources: [],
        stats: {
          projectKey: TEST_WORKING_DIR,
          candidatesScanned: 1,
          candidatesIncluded: 1,
          truncated: false,
        },
      });

      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        initialPrompt: 'Use fallback memory',
      });
      await instance.readyPromise;

      const spawnCall = mockCreateCliAdapter.mock.calls.find((call) => {
        const options = call[1] as { systemPrompt?: string } | undefined;
        return typeof options?.systemPrompt === 'string';
      });
      const spawnOptions = spawnCall?.[1] as { systemPrompt?: string } | undefined;
      expect(spawnOptions?.systemPrompt).toContain('Fallback service memory');
      expect(mockContextWorkerBuildProjectMemoryBrief).toHaveBeenCalled();
      expect(mockProjectMemoryBuildBrief).toHaveBeenCalledWith(expect.objectContaining({
        projectPath: TEST_WORKING_DIR,
        instanceId: instance.id,
        initialPrompt: 'Use fallback memory',
      }));
    });

    it('continues spawning when project memory brief retrieval fails', async () => {
      mockProjectMemoryBuildBrief.mockRejectedValueOnce(new Error('memory unavailable'));

      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        initialPrompt: 'Start even if memory is unavailable',
      });
      await instance.readyPromise;

      const spawnCall = mockCreateCliAdapter.mock.calls.find((call) => {
        const options = call[1] as { systemPrompt?: string } | undefined;
        return typeof options?.systemPrompt === 'string';
      });
      const spawnOptions = spawnCall?.[1] as { systemPrompt?: string } | undefined;
      expect(spawnOptions?.systemPrompt).not.toContain('## Project Memory Brief');
      expect(mockAdapterSendInput).toHaveBeenCalledWith('Start even if memory is unavailable', undefined);
      expect(instance.status).toBe('idle');
    });

    it('records initial prompts in main-process prompt history', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        initialPrompt: 'Remember this startup prompt',
        provider: 'claude',
        modelOverride: 'opus',
      });
      await instance.readyPromise;

      expect(mockPromptHistoryRecord).toHaveBeenCalledWith(expect.objectContaining({
        instanceId: instance.id,
        text: 'Remember this startup prompt',
        projectPath: TEST_WORKING_DIR,
        provider: 'claude',
        model: 'opus',
        wasSlashCommand: false,
      }));
    });

    it('prepends indexed codebase context to fresh root initial prompts', async () => {
      mockIndexedBuildContext.mockResolvedValueOnce({
        context: '- src/auth/middleware.ts:10\n```typescript\nrequireAuth();\n```',
        tokens: 16,
        storeId: 'ctx-codebase',
        workspacePath: TEST_WORKING_DIR,
        results: [
          {
            sectionId: 'sec-1',
            filePath: `${TEST_WORKING_DIR}/src/auth/middleware.ts`,
            relativePath: 'src/auth/middleware.ts',
            content: 'requireAuth();',
            startLine: 10,
            endLine: 10,
            score: 0.4,
            matchType: 'hybrid' as const,
          },
        ],
        durationMs: 7,
      });
      mockIndexedFormatContextBlock.mockReturnValueOnce(
        '[Indexed Codebase Context]\nsrc/auth/middleware.ts:10\nrequireAuth();\n[End Indexed Codebase Context]',
      );

      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        initialPrompt: 'where is auth middleware handled?',
      });
      await instance.readyPromise;

      expect(mockIndexedBuildContext).toHaveBeenCalledWith(expect.objectContaining({
        workspacePath: TEST_WORKING_DIR,
        query: 'where is auth middleware handled?',
      }));
      const sentMessage = mockAdapterSendInput.mock.calls.at(-1)?.[0] as string;
      expect(sentMessage).toContain('[Indexed Codebase Context]');
      expect(sentMessage).toContain('src/auth/middleware.ts:10');
      expect(sentMessage).toContain('where is auth middleware handled?');
    });
  });

});
