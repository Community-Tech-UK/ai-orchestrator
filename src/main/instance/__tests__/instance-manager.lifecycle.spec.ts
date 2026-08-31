/**
 * InstanceManager lifecycle Tests
 *
 * Split from instance-manager.spec.ts. Full mock preamble duplicated
 * (same pattern as instance-manager.normalized-event.spec.ts) so Vitest
 * mock hoisting stays reliable.
 *
 * Note: vi.mock() paths are resolved relative to THIS test file location:
 *   src/main/instance/__tests__/instance-manager.lifecycle.spec.ts
 * So paths like '../../cli/...' resolve to src/main/cli/...
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { Instance } from '../../../shared/types/instance.types';

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
  mockCleanupAdjudicatorBreakerForInstance,
  mockRecoveryCandidateInvalidate,
  mockTriggerLifecycleHooks,
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
    discardTracking: vi.fn().mockResolvedValue(undefined),
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
  mockCleanupAdjudicatorBreakerForInstance: vi.fn(),
  mockRecoveryCandidateInvalidate: vi.fn(),
  mockTriggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }),
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

vi.mock('../../security/approval-adjudicator', () => ({
  maybeAdjudicateDeferredPermission: vi.fn().mockResolvedValue(null),
  resetAdjudicatorBreaker: vi.fn(),
  cleanupAdjudicatorBreakerForInstance: mockCleanupAdjudicatorBreakerForInstance,
  isAdjudicatorBreakerTripped: vi.fn().mockReturnValue(false),
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

vi.mock('../../session/session-recovery-candidate-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../session/session-recovery-candidate-service')>();
  return {
    ...actual,
    getSessionRecoveryCandidateServiceIfInitialized: vi.fn(() => ({
      invalidate: mockRecoveryCandidateInvalidate,
    })),
  };
});

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
    triggerLifecycleHooks: mockTriggerLifecycleHooks,
  })),
}));

// ---------------------------------------------------------------------------
// Error recovery mock
// ---------------------------------------------------------------------------
vi.mock('../../core/error-recovery', () => ({
  getErrorRecoveryManager: vi.fn(() => ({
    classifyError: vi.fn(() => ({ category: 'unknown', technicalDetails: '' })),
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
vi.mock('../../persistence/rlm-database', () => {
  const rawDb = {
    prepareCached: vi.fn(() => ({
      run: vi.fn(() => ({ changes: 0, lastInsertRowid: 0 })),
      get: vi.fn(() => undefined),
      all: vi.fn(() => []),
    })),
  };
  const rlmDatabase = {
    initialize: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockReturnValue([]),
    insert: vi.fn(),
    close: vi.fn(),
    getRawDb: vi.fn(() => rawDb),
  };
  return {
    RLMDatabase: vi.fn().mockImplementation(() => rlmDatabase),
    getRLMDatabase: vi.fn(() => rlmDatabase),
  };
});

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
import {
  SessionRecoveryCandidateService,
  wireSessionRecoveryCandidateInvalidation,
  type ResolvedRecoveryCandidate,
} from '../../session/session-recovery-candidate-service';
import { getRecoverySensitiveValues } from '../instance-recovery-redaction';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_WORKING_DIR = '/tmp/test-project';

function createManager(): InstanceManager {
  return new InstanceManager();
}

function makeResolvedRecoveryCandidate(): ResolvedRecoveryCandidate {
  const now = Date.now();
  return {
    candidate: {
      recoveryKey: 'history:claude:history-thread-recovery',
      sourceInstanceId: 'crashed-instance',
      historyThreadId: 'history-thread-recovery',
      provider: 'claude',
      modelId: 'opus',
      displayName: 'Recovered task',
      workingDirectory: TEST_WORKING_DIR,
      lastActivityAt: now - 1_000,
      historyCoveredThrough: now - 5_000,
      recoveredMessageCount: 1,
      reason: 'newer-than-history',
      nativeResumeAvailable: true,
    },
    continuityState: {
      instanceId: 'crashed-instance',
      historyThreadId: 'history-thread-recovery',
      displayName: 'Recovered task',
      agentId: 'build',
      modelId: 'opus',
      provider: 'claude',
      workingDirectory: TEST_WORKING_DIR,
      conversationHistory: [
        {
          id: 'continuity-duplicate',
          role: 'user',
          content: 'Recovered fixture request',
          timestamp: now - 8_000,
        },
        {
          id: 'continuity-suffix',
          role: 'assistant',
          content: 'Recovered fixture suffix',
          timestamp: now - 2_000,
        },
      ],
      contextUsage: { used: 5, total: 1_000 },
      pendingTasks: [],
      environmentVariables: {},
      activeFiles: [],
      skillsLoaded: [],
      hooksActive: [],
      resumeCursor: {
        provider: 'claude',
        threadId: 'native-thread-recovery',
        workspacePath: TEST_WORKING_DIR,
        capturedAt: now - 500,
        scanSource: 'native',
      },
    },
    historyConversation: {
      entry: {
        id: 'history-entry-recovery',
        displayName: 'Recovered task',
        historyThreadId: 'history-thread-recovery',
        createdAt: now - 20_000,
        endedAt: now - 10_000,
        workingDirectory: TEST_WORKING_DIR,
        messageCount: 1,
        firstUserMessage: 'Recovered fixture request',
        lastUserMessage: 'Recovered fixture request',
        status: 'terminated',
        originalInstanceId: 'crashed-instance',
        parentId: null,
        sessionId: 'archived-session-recovery',
        provider: 'claude',
      },
      messages: [{
        id: 'archived-user-recovery',
        timestamp: now - 8_000,
        type: 'user',
        content: 'Recovered fixture request',
      }],
    },
  };
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
    mockSessionContinuity.discardTracking.mockResolvedValue(undefined);
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
    // (In the monolithic spec, createInstance sat between getInstance and
    // forkInstance and absorbed this pollution.)
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

  describe('getInstance', () => {
    it('returns undefined for non-existent instance', () => {
      const result = manager.getInstance('non-existent-id');
      expect(result).toBeUndefined();
    });

    it('returns instance by ID after creation', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Test Instance',
      });

      const retrieved = manager.getInstance(instance.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(instance.id);
      expect(retrieved?.displayName).toBe('Test Instance');
    });

    it('returns undefined after instance is terminated and removed from state', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Temporary Instance',
      });

      await manager.terminateInstance(instance.id);

      // terminateInstance deletes the instance from state after cleanup
      const retrieved = manager.getInstance(instance.id);
      expect(retrieved).toBeUndefined();
    });
  });

  describe('reviveFromContinuity', () => {
    it('creates a restored continuation seeded with the durable review feedback', async () => {
      mockSessionContinuity.resumeSession.mockResolvedValueOnce({
        instanceId: 'old-instance',
        sessionId: 'provider-session-1',
        historyThreadId: 'thread-1',
        displayName: 'Architecture plan',
        isRenamed: true,
        agentId: 'build',
        modelId: 'opus',
        provider: 'claude',
        workingDirectory: TEST_WORKING_DIR,
        conversationHistory: [
          { id: 'u1', role: 'user', content: 'Please make a plan.', timestamp: 1 },
          { id: 'a1', role: 'assistant', content: 'Here is the plan.', timestamp: 2 },
        ],
        contextUsage: { used: 12, total: 1000 },
        pendingTasks: [],
        environmentVariables: {},
        activeFiles: [],
        skillsLoaded: [],
        hooksActive: [],
      });

      const revived = await manager.reviveFromContinuity({
        sourceInstanceId: 'old-instance',
        initialPrompt: 'review feedback',
        reason: 'doc-review-submission',
      });
      const revivedInstance = manager.getInstance(revived.instanceId)!;

      expect(revived.instanceId).not.toBe('old-instance');
      expect(revived.restoreMode).toBe('native');
      expect(revivedInstance.displayName).toBe('Architecture plan');
      expect(revivedInstance.historyThreadId).toBe('thread-1');
      expect(revivedInstance.outputBuffer.map((message) => message.content)).toContain('Please make a plan.');
      expect(mockAdapterSendInput).toHaveBeenCalledWith(
        expect.stringContaining('review feedback'),
        undefined,
      );
    });
  });

  describe('recoverFromContinuity', () => {
    it('returns the new runtime and invalidates discovery only after successful readiness', async () => {
      const resolved = makeResolvedRecoveryCandidate();
      const original = structuredClone(resolved);
      let finishSpawn: (() => void) | undefined;
      mockAdapterSpawn.mockImplementationOnce(() => new Promise<number>((resolve) => {
        finishSpawn = () => resolve(12345);
      }));
      const created: string[] = [];
      const removed: string[] = [];
      const publicLifecycleEvents: string[] = [];
      const inputRequiredEvents: unknown[] = [];
      const normalizedEvents: ProviderRuntimeEventEnvelope[] = [];
      const stateBatches: unknown[] = [];
      manager.on('instance:created', (instance: { id: string }) => {
        created.push(instance.id);
        publicLifecycleEvents.push('created');
      });
      manager.on('instance:state-update', () => publicLifecycleEvents.push('state-update'));
      manager.on('instance:state-changed', () => publicLifecycleEvents.push('state-changed'));
      manager.on('instance:idle', () => publicLifecycleEvents.push('idle'));
      manager.on('instance:input-required', (payload) => inputRequiredEvents.push(payload));
      manager.on('instance:removed', (instanceId: string) => {
        removed.push(instanceId);
        void mockSessionContinuity.stopTracking(instanceId, true);
      });
      manager.on('provider:normalized-event', (event: ProviderRuntimeEventEnvelope) => {
        normalizedEvents.push(event);
      });
      manager.on('instance:batch-update', (batch) => stateBatches.push(batch));

      const pending = manager.recoverFromContinuity(resolved);
      await vi.waitFor(() => expect(mockAdapterSpawn).toHaveBeenCalledOnce());
      const state = manager as unknown as {
        state: {
          pendingInstances: Map<string, unknown>;
          pendingAdapters: Map<string, EventEmitter & {
            getRuntimeCapabilities(): ReturnType<ReturnType<typeof makeMockAdapter>['getRuntimeCapabilities']>;
          }>;
          queueUpdate(instanceId: string, status: 'busy' | 'error', ...args: unknown[]): void;
          flushUpdates(): void;
        };
      };
      const pendingInstanceId = Array.from(state.state.pendingInstances.keys())[0];
      expect(pendingInstanceId).toBeDefined();
      manager.emitProviderRuntimeEvent(pendingInstanceId!, {
        kind: 'output', content: 'private output fixture', messageType: 'assistant',
      });
      const pendingAdapter = state.state.pendingAdapters.get(pendingInstanceId!);
      expect(pendingAdapter).toBeDefined();
      pendingAdapter!.getRuntimeCapabilities = () => ({
        supportsResume: true,
        supportsForkSession: false,
        supportsNativeCompaction: false,
        supportsPermissionPrompts: true,
        supportsDeferPermission: false,
        selfManagedAutoCompaction: false,
      });
      pendingAdapter!.emit('input_required', {
        id: 'private-request-placeholder',
        prompt: 'private prompt placeholder',
        timestamp: 1,
      });
      state.state.queueUpdate(pendingInstanceId!, 'busy');
      state.state.flushUpdates();
      expect(manager.getAllInstances()).toEqual([]);
      expect(created).toEqual([]);
      expect(normalizedEvents).toEqual([]);
      expect(inputRequiredEvents).toEqual([]);
      expect(stateBatches).toEqual([]);
      expect(manager.getLiveRecoveryKeys()).not.toContain(resolved.candidate.recoveryKey);
      expect(mockSessionContinuity.startTracking).not.toHaveBeenCalled();
      expect(mockRecoveryCandidateInvalidate).not.toHaveBeenCalled();
      finishSpawn?.();
      const recovered = await pending;
      const replacement = manager.getInstance(recovered.instanceId);

      expect(typeof recovered.instanceId).toBe('string');
      expect(recovered).toMatchObject({
        recoveredMessageCount: 1,
        usedNativeResume: true,
      });
      expect(recovered.instanceId).not.toBe('crashed-instance');
      expect(replacement).toMatchObject({
        historyThreadId: 'history-thread-recovery',
        sessionId: 'native-thread-recovery',
      });
      expect(replacement?.outputBuffer.map((message) => message.id)).toEqual([
        'archived-user-recovery',
        'continuity-suffix',
      ]);
      expect(created).toEqual([recovered.instanceId]);
      expect(removed).toEqual([]);
      expect(mockSessionContinuity.startTracking).toHaveBeenCalledOnce();
      expect(mockSessionContinuity.stopTracking).not.toHaveBeenCalled();
      expect(mockRecoveryCandidateInvalidate).toHaveBeenCalled();
      expect(publicLifecycleEvents).toEqual(['created']);
      state.state.flushUpdates();
      expect(stateBatches).toHaveLength(1);
      const replacementAlias = 'native-thread-recovery';
      const sourceInstanceAlias = 'crashed-instance';
      const archivedSessionAlias = 'archived-session-recovery';
      const sensitiveValues = getRecoverySensitiveValues(replacement!);
      expect(sensitiveValues).toContain(sourceInstanceAlias);
      expect(sensitiveValues).toContain(archivedSessionAlias);
      expect(JSON.stringify(replacement?.metadata)).not.toContain(sourceInstanceAlias);
      expect(JSON.stringify(replacement?.metadata)).not.toContain(archivedSessionAlias);

      normalizedEvents.length = 0;
      stateBatches.length = 0;
      mockTriggerLifecycleHooks.mockClear();
      const adapterError = Object.assign(
        new Error(`adapter failed for ${archivedSessionAlias}`),
        {
          code: `PROVIDER_${replacementAlias}`,
          cause: new Error(`nested failure for ${sourceInstanceAlias}`),
          metadata: { sourceInstanceId: sourceInstanceAlias },
        },
      );
      adapterError.name = `Provider_${sourceInstanceAlias}`;
      const recoveredAdapter = manager.getAdapter(recovered.instanceId) as unknown as EventEmitter;
      recoveredAdapter.emit('error', adapterError);
      await vi.waitFor(() => expect(mockTriggerLifecycleHooks).toHaveBeenCalledWith(
        'StopFailure', expect.any(Object),
      ));
      state.state.queueUpdate(
        recovered.instanceId,
        'error',
        undefined, undefined, undefined,
        {
          code: `QUEUE_${archivedSessionAlias}`,
          message: `queue failure for ${sourceInstanceAlias}`,
          stack: `queue stack for ${replacementAlias}`,
          timestamp: 1,
        },
      );
      state.state.flushUpdates();
      const recoveryObservables = JSON.stringify({
        outputBuffer: replacement?.outputBuffer,
        normalizedEvents,
        hooks: mockTriggerLifecycleHooks.mock.calls,
        stateBatches,
        ipc: (manager as unknown as { state: { serializeForIpc(instance: Instance): unknown } })
          .state.serializeForIpc(replacement!),
      });
      expect(recoveryObservables).not.toContain(replacementAlias);
      expect(recoveryObservables).not.toContain(sourceInstanceAlias);
      expect(recoveryObservables).not.toContain(archivedSessionAlias);
      expect(resolved).toEqual(original);
    });

    it('fails and rolls back the private transaction when its pending adapter exits', async () => {
      const resolved = makeResolvedRecoveryCandidate();
      const original = structuredClone(resolved);
      let releaseTracking!: () => void;
      const trackingBarrier = new Promise<void>((resolve) => { releaseTracking = resolve; });
      mockSessionContinuity.startTracking.mockImplementationOnce(() => trackingBarrier);
      const internals = manager as unknown as {
        state: {
          pendingInstances: Map<string, Instance>;
          pendingAdapters: Map<string, EventEmitter>;
        };
        lifecycle: { respawnAfterUnexpectedExit(instanceId: string): Promise<void> };
      };
      const unexpectedRespawn = vi.spyOn(internals.lifecycle, 'respawnAfterUnexpectedExit')
        .mockResolvedValue(undefined);
      const created = vi.fn();
      const removed = vi.fn();
      manager.on('instance:created', created);
      manager.on('instance:removed', removed);

      const pendingRecovery = manager.recoverFromContinuity(resolved);
      await vi.waitFor(() => expect(mockSessionContinuity.startTracking).toHaveBeenCalledOnce());
      const pendingInstanceId = Array.from(internals.state.pendingInstances.keys())[0];
      const pendingInstance = internals.state.pendingInstances.get(pendingInstanceId!);
      const pendingAdapter = internals.state.pendingAdapters.get(pendingInstanceId!);
      expect(pendingInstance?.status).toBe('idle');
      expect(pendingAdapter).toBeDefined();

      pendingAdapter!.emit('exit', 1, null);
      await Promise.resolve();

      expect(unexpectedRespawn).not.toHaveBeenCalled();
      expect(pendingInstance?.status).toBe('idle');
      expect(internals.state.pendingAdapters.get(pendingInstanceId!)).toBe(pendingAdapter);

      releaseTracking();
      await expect(pendingRecovery).rejects.toThrow('Recovery replacement failed to start');

      expect(unexpectedRespawn).not.toHaveBeenCalled();
      expect(mockAdapterSpawn).toHaveBeenCalledTimes(1);
      expect(mockAdapterTerminate).toHaveBeenCalledTimes(1);
      expect(created).not.toHaveBeenCalled();
      expect(removed).not.toHaveBeenCalled();
      expect(mockRecoveryCandidateInvalidate).not.toHaveBeenCalled();
      expect(mockSessionContinuity.discardTracking).toHaveBeenCalledTimes(1);
      expect(internals.state.pendingInstances).toHaveLength(0);
      expect(internals.state.pendingAdapters).toHaveLength(0);
      expect(manager.getAdapter(pendingInstanceId!)).toBeUndefined();
      expect(manager.getAllInstances()).toEqual([]);
      expect(resolved).toEqual(original);
    });

    it('redacts native recovery identities from normalized and raw provider events', async () => {
      const rawCursor = 'native-thread-recovery';
      const normalizedEvents: ProviderRuntimeEventEnvelope[] = [];
      const rawEvents: ProviderRuntimeEventEnvelope[] = [];
      manager.on('provider:normalized-event', (event: ProviderRuntimeEventEnvelope) => {
        normalizedEvents.push(event);
      });
      manager.on('provider:raw-event', (event: ProviderRuntimeEventEnvelope) => {
        rawEvents.push(event);
      });
      const recovered = await manager.recoverFromContinuity(makeResolvedRecoveryCandidate());

      manager.emitProviderRuntimeEvent(recovered.instanceId, {
        kind: 'error',
        message: `provider failure for ${rawCursor}`,
        details: {
          sessionId: rawCursor,
          nested: { thread_id: rawCursor },
        },
      }, {
        sessionId: rawCursor,
        raw: {
          source: 'fixture',
          payload: { session_id: rawCursor },
        },
      });

      expect(normalizedEvents).toHaveLength(1);
      expect(rawEvents).toHaveLength(0);
      expect(JSON.stringify(normalizedEvents)).not.toContain(rawCursor);
      expect(normalizedEvents[0]?.sessionId).toBeUndefined();
      expect(normalizedEvents[0]).not.toHaveProperty('raw');
    });

    it('does not invalidate discovery or mutate the source when replacement startup fails', async () => {
      const resolved = makeResolvedRecoveryCandidate();
      const original = structuredClone(resolved);
      mockAdapterSpawn.mockRejectedValueOnce(new Error('fixture spawn failure'));
      const created = vi.fn();
      const removed = vi.fn();
      manager.on('instance:created', created);
      manager.on('instance:removed', removed);

      await expect(manager.recoverFromContinuity(resolved))
        .rejects.toThrow('Recovery replacement failed to start');

      expect(mockRecoveryCandidateInvalidate).not.toHaveBeenCalled();
      expect(created).not.toHaveBeenCalled();
      expect(removed).not.toHaveBeenCalled();
      expect(mockSessionContinuity.startTracking).not.toHaveBeenCalled();
      expect(mockSessionContinuity.stopTracking).not.toHaveBeenCalled();
      expect(manager.getAllInstances()).toEqual([]);
      expect(resolved).toEqual(original);
    });

    it('uses rollback-only teardown when replay queuing fails after transcript seeding', async () => {
      const resolved = makeResolvedRecoveryCandidate();
      resolved.continuityState.resumeCursor = null;
      resolved.candidate.nativeResumeAvailable = false;
      const original = structuredClone(resolved);
      const queueFailure = new Error('fixture replay queue failure');
      const queueContinuityPreamble = manager.queueContinuityPreamble.bind(manager);
      let partialReplacementId: string | undefined;
      vi.spyOn(manager, 'queueContinuityPreamble').mockImplementation((instanceId, preamble) => {
        partialReplacementId = instanceId;
        queueContinuityPreamble(instanceId, preamble);
        throw queueFailure;
      });
      const created = vi.fn();
      const removed = vi.fn();
      manager.on('instance:created', created);
      manager.on('instance:removed', removed);

      await expect(manager.recoverFromContinuity(resolved))
        .rejects.toThrow('Recovery replacement failed to start');

      expect(manager.getAllInstances()).toEqual([]);
      expect(created).not.toHaveBeenCalled();
      expect(removed).not.toHaveBeenCalled();
      expect(mockSessionContinuity.startTracking).not.toHaveBeenCalled();
      expect(mockSessionContinuity.stopTracking).not.toHaveBeenCalled();
      expect(mockSessionContinuity.discardTracking).not.toHaveBeenCalled();
      expect(mockRecoveryCandidateInvalidate).not.toHaveBeenCalled();
      const communication = manager as unknown as {
        communication: {
          continuityInputQueue: { consume(instanceId: string): string | null | undefined };
        };
      };
      expect(partialReplacementId).toBeDefined();
      expect(communication.communication.continuityInputQueue.consume(partialReplacementId!))
        .toBeUndefined();
      expect(resolved).toEqual(original);
    });

    it.each([
      ['cursor', 'cursor:claude:cursor-thread-1', {
        sessionId: undefined,
        resumeCursor: {
          provider: 'claude', threadId: 'cursor-thread-1',
          workspacePath: TEST_WORKING_DIR, capturedAt: Date.now(), scanSource: 'native' as const,
        },
      }],
      ['session', 'session:claude:persisted-session-1', {
        sessionId: 'persisted-session-1',
        resumeCursor: null,
      }],
      ['instance', 'instance:crashed-instance', {
        sessionId: undefined,
        resumeCursor: null,
      }],
    ])('hides a no-history %s-key candidate while its replacement is live', async (
      _kind,
      recoveryKey,
      identity,
    ) => {
      const resolved = makeResolvedRecoveryCandidate();
      resolved.candidate = {
        ...resolved.candidate,
        recoveryKey,
        historyThreadId: undefined,
        nativeResumeAvailable: identity.resumeCursor !== null,
      };
      resolved.continuityState = {
        ...resolved.continuityState,
        historyThreadId: undefined,
        sessionId: identity.sessionId,
        resumeCursor: identity.resumeCursor,
      };
      resolved.historyConversation = null;
      const service = new SessionRecoveryCandidateService({
        getSnapshot: () => null,
        waitForContinuityReady: async () => undefined,
        listContinuityMetadata: async () => [{
          recoveryKey,
          sourceInstanceId: 'crashed-instance',
          provider: 'claude',
          workingDirectory: TEST_WORKING_DIR,
          lastActivityAt: Date.now(),
          modifiedAt: Date.now(),
          messageCount: 2,
          hasUserPrompt: true,
          hasAssistantOutput: true,
          nativeResumeAvailable: resolved.candidate.nativeResumeAvailable,
        }],
        loadContinuityState: async () => resolved.continuityState,
        waitForHistoryReady: async () => undefined,
        getHistoryCoverage: async () => new Map(),
        loadHistoryConversation: async () => null,
        getLiveRecoveryKeys: () => manager.getLiveRecoveryKeys(),
        now: () => Date.now(),
      });
      const unwire = wireSessionRecoveryCandidateInvalidation(service, manager);

      expect((await service.listCandidates()).map((candidate) => candidate.recoveryKey))
        .toEqual([recoveryKey]);
      const recovered = await manager.recoverFromContinuity(resolved);

      expect(manager.getLiveRecoveryKeys()).toContain(recoveryKey);
      expect(await service.listCandidates()).toEqual([]);
      expect(manager.getInstance(recovered.instanceId)).toBeDefined();
      await manager.terminateInstance(recovered.instanceId, false);
      expect(manager.getLiveRecoveryKeys()).not.toContain(recoveryKey);
      expect((await service.listCandidates()).map((candidate) => candidate.recoveryKey))
        .toEqual([recoveryKey]);
      unwire();
    });

    it('runs essential recovery publication despite a throwing created observer', async () => {
      const observed = vi.fn();
      manager.on('instance:created', () => {
        throw new Error('fixture optional observer failure');
      });
      manager.on('instance:created', observed);

      const recovered = await manager.recoverFromContinuity(makeResolvedRecoveryCandidate());

      expect(observed).toHaveBeenCalledOnce();
      expect(mockSessionContinuity.startTracking).toHaveBeenCalledOnce();
      expect(mockRecoveryCandidateInvalidate).toHaveBeenCalled();
      expect(manager.getInstance(recovered.instanceId)).toBeDefined();
    });

    it('owns and discards continuity tracking even when startTracking rejects partway through', async () => {
      let replacementId: string | undefined;
      mockSessionContinuity.startTracking.mockImplementationOnce(async (instance: Instance) => {
        replacementId = instance.id;
        throw new Error('fixture partial tracking failure');
      });

      await expect(manager.recoverFromContinuity(makeResolvedRecoveryCandidate()))
        .rejects.toThrow('Recovery replacement failed to start');

      expect(replacementId).toBeDefined();
      expect(mockSessionContinuity.discardTracking).toHaveBeenCalledWith(replacementId);
      expect(manager.getAllInstances()).toEqual([]);
      expect(mockRecoveryCandidateInvalidate).not.toHaveBeenCalled();
    });

    it('runs every private rollback owner when publication and continuity cleanup fail', async () => {
      const resolved = makeResolvedRecoveryCandidate();
      resolved.continuityState.resumeCursor = null;
      resolved.candidate.nativeResumeAvailable = false;
      const internals = manager as unknown as {
        state: {
          pendingInstances: Map<string, unknown>;
          pendingAdapters: Map<string, unknown>;
          publishPendingInstance(instanceId: string): unknown;
          clearPendingInstanceState(instanceId: string): void;
        };
        communication: {
          cleanupCircuitBreaker(instanceId: string): void;
          continuityInputQueue: { consume(instanceId: string): string | null | undefined };
        };
        providerEventBus: { removeInstance(instanceId: string): void };
        settledTracker: { clear(instanceId: string): void };
        continuityRecovery: {
          getRecoveryIdentityKeysForInstance(instanceId: string): ReadonlySet<string>;
        };
      };
      let replacementId: string | undefined;
      vi.spyOn(internals.state, 'publishPendingInstance').mockImplementation((instanceId) => {
        replacementId = instanceId;
        throw new Error('fixture publication failure');
      });
      mockSessionContinuity.discardTracking.mockRejectedValue(
        new Error('fixture discard failure for cursor-fixture-placeholder'),
      );
      const cleanupCircuitBreaker = internals.communication.cleanupCircuitBreaker
        .bind(internals.communication);
      vi.spyOn(internals.communication, 'cleanupCircuitBreaker').mockImplementation((instanceId) => {
        cleanupCircuitBreaker(instanceId);
        throw new Error('fixture communication cleanup failure');
      });
      const clearPendingState = vi.spyOn(internals.state, 'clearPendingInstanceState');
      const removeProviderState = vi.spyOn(internals.providerEventBus, 'removeInstance');
      const clearSettledState = vi.spyOn(internals.settledTracker, 'clear');

      await expect(manager.recoverFromContinuity(resolved))
        .rejects.toThrow('Recovery replacement failed to start');

      expect(replacementId).toBeDefined();
      expect(manager.getAllInstances()).toEqual([]);
      expect(internals.state.pendingInstances).toHaveLength(0);
      expect(internals.state.pendingAdapters).toHaveLength(0);
      expect(internals.communication.continuityInputQueue.consume(replacementId!)).toBeUndefined();
      expect(internals.continuityRecovery.getRecoveryIdentityKeysForInstance(replacementId!))
        .toHaveLength(0);
      expect(clearPendingState).toHaveBeenCalledWith(replacementId);
      expect(removeProviderState).toHaveBeenCalledWith(replacementId);
      expect(clearSettledState).toHaveBeenCalledWith(replacementId);
      expect(mockRecoveryCandidateInvalidate).not.toHaveBeenCalled();
    });
  });

  describe('forkInstance', () => {
    it('keeps the source alive for prompted forks unless supersession is explicit', async () => {
      const source = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
      });
      await source.readyPromise;
      mockAdapterTerminate.mockClear();
      source.outputBuffer.push({
        id: 'user-1',
        timestamp: Date.now(),
        type: 'user',
        content: 'original question',
      });

      const forked = await manager.forkInstance({
        instanceId: source.id,
        atMessageIndex: 1,
        initialPrompt: 'follow-up prompt',
      });
      await forked.readyPromise;

      expect(source.status).toBe('idle');
      expect(source.supersededBy).toBeUndefined();
      expect(source.cancelledForEdit).not.toBe(true);
      expect(mockAdapterTerminate).not.toHaveBeenCalled();
    });

    it('supersedes and terminates the source when an edit-resend fork requests it', async () => {
      const source = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
      });
      await source.readyPromise;
      source.outputBuffer.push({
        id: 'user-1',
        timestamp: Date.now(),
        type: 'user',
        content: 'original question',
      });

      const forked = await manager.forkInstance({
        instanceId: source.id,
        atMessageIndex: 0,
        sourceMessageId: 'user-1',
        initialPrompt: 'edited question',
        supersedeSource: true,
      });
      await forked.readyPromise;

      expect(source.status).toBe('superseded');
      expect(source.supersededBy).toBe(forked.id);
      expect(source.cancelledForEdit).toBe(true);
      expect(source.lastTurnOutcome).toBe('cancelled');
      expect(mockAdapterTerminate).toHaveBeenCalledWith(false);
    });
  });

  describe('terminateInstance', () => {
    it('removes a running instance from state after termination', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Running Instance',
      });

      await manager.terminateInstance(instance.id);

      // terminateInstance deletes the instance from state after cleanup
      const retrieved = manager.getInstance(instance.id);
      expect(retrieved).toBeUndefined();
    });

    it('handles terminating an already-terminated instance gracefully', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Termination Test',
      });

      await manager.terminateInstance(instance.id);

      // Second call should not throw even though adapter is already removed
      await expect(manager.terminateInstance(instance.id)).resolves.toBeUndefined();
    });

    it('handles terminating a non-existent instance gracefully', async () => {
      await expect(
        manager.terminateInstance('non-existent-id')
      ).resolves.toBeUndefined();
    });

    it('removes the instance from getAllInstances after termination', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'PID Clear Test',
      });

      expect(manager.getAllInstances()).toHaveLength(1);
      await manager.terminateInstance(instance.id);
      expect(manager.getAllInstances()).toHaveLength(0);
    });

    it('cleans up the adjudicator denial-breaker state (WS-B3 fresh-eyes fix)', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Adjudicator Breaker Cleanup Test',
      });

      await manager.terminateInstance(instance.id);

      expect(mockCleanupAdjudicatorBreakerForInstance).toHaveBeenCalledWith(instance.id);
    });
  });

  describe('wakeInstance', () => {
    it('rolls back the newly registered adapter when wake spawn fails', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Wake Rollback',
      });
      await instance.readyPromise;
      await manager.hibernateInstance(instance.id);

      const spawnFailure = new Error('wake spawn failed');
      mockCreateCliAdapter.mockImplementation((_cliType, options) => {
        const adapter = makeMockAdapter();
        if ((options as { instanceId?: string } | undefined)?.instanceId === instance.id) {
          adapter.spawn = vi.fn().mockRejectedValue(spawnFailure);
        }
        return adapter;
      });

      await expect(manager.wakeInstance(instance.id)).rejects.toThrow('wake spawn failed');

      expect(manager.getInstance(instance.id)).toBe(instance);
      expect(manager.getAdapter(instance.id)).toBeUndefined();
      expect(instance.status).toBe('failed');
      expect(mockAdapterTerminate).toHaveBeenCalled();
    });

    it('coalesces concurrent wake requests into a single respawn', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Concurrent Wake',
      });
      await instance.readyPromise;
      await manager.hibernateInstance(instance.id);
      mockCreateCliAdapter.mockClear();

      await Promise.all([
        manager.wakeInstance(instance.id),
        manager.wakeInstance(instance.id),
      ]);

      expect(mockCreateCliAdapter).toHaveBeenCalledTimes(1);
      expect(instance.status).toBe('ready');
    });

    it('wakes an adapter that reports idle from spawn (stateless exec adapters)', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Spawn Emits Idle',
      });
      await instance.readyPromise;
      await manager.hibernateInstance(instance.id);

      // Codex app-server, Gemini, Copilot, Cursor and Antigravity all end
      // spawn() with `emit('status', 'idle')`, which lands while the instance
      // is still 'waking'.
      mockCreateCliAdapter.mockImplementation(() => {
        const adapter = makeMockAdapter();
        adapter.spawn = vi.fn(async () => {
          const pid = await mockAdapterSpawn();
          adapter.emit('status', 'idle');
          return pid;
        });
        return adapter;
      });

      await expect(manager.wakeInstance(instance.id)).resolves.toBeUndefined();
      expect(instance.status).toBe('ready');
      expect(manager.getAdapter(instance.id)).toBeDefined();
    });

    it('coalesces concurrent wakes even when spawn reports idle mid-wake', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Concurrent Wake Idle Spawn',
      });
      await instance.readyPromise;
      await manager.hibernateInstance(instance.id);

      mockCreateCliAdapter.mockImplementation(() => {
        const adapter = makeMockAdapter();
        adapter.spawn = vi.fn(async () => {
          const pid = await mockAdapterSpawn();
          adapter.emit('status', 'idle');
          return pid;
        });
        return adapter;
      });
      mockCreateCliAdapter.mockClear();

      await Promise.all([
        manager.wakeInstance(instance.id),
        manager.wakeInstance(instance.id),
      ]);

      expect(mockCreateCliAdapter).toHaveBeenCalledTimes(1);
      expect(instance.status).toBe('ready');
    });

    it('is a no-op for an instance that is already awake', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Already Awake',
      });
      await instance.readyPromise;
      const adapterBefore = manager.getAdapter(instance.id);

      await expect(manager.wakeInstance(instance.id)).resolves.toBeUndefined();

      expect(manager.getAdapter(instance.id)).toBe(adapterBefore);
    });
  });

  describe('hibernated sessions', () => {
    it('wakes the session and delivers the message when the user sends into it', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Send Wakes Hibernated',
      });
      await instance.readyPromise;
      await manager.hibernateInstance(instance.id);
      expect(instance.status).toBe('hibernated');
      expect(manager.getAdapter(instance.id)).toBeUndefined();
      mockAdapterSendInput.mockClear();

      await manager.sendInput(instance.id, 'are you there?');

      expect(instance.status).not.toBe('hibernated');
      expect(manager.getAdapter(instance.id)).toBeDefined();
      expect(mockAdapterSendInput).toHaveBeenCalledWith(
        expect.stringContaining('are you there?'),
        undefined,
      );
    });

    it('does not treat the adapter exit from a deliberate hibernation as a crash', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Hibernation Exit',
      });
      await instance.readyPromise;
      const adapter = manager.getAdapter(instance.id) as unknown as EventEmitter;

      // Reproduces the live failure: the CLI process exit lands while the
      // instance is mid-hibernation. 'hibernating' -> 'error' is an illegal
      // transition, so an unguarded handler threw out of this synchronous
      // emit and surfaced as an uncaught main-process exception.
      manager.updateInstanceStatus(instance.id, 'hibernating');
      expect(() => adapter.emit('exit', 1, null)).not.toThrow();

      expect(instance.status).toBe('hibernating');
    });
  });

  describe('restartFreshInstance', () => {
    beforeEach(async () => {
      const { _resetAllContextManifestsForTesting } = await import('../../context/context-manifest-store');
      _resetAllContextManifestsForTesting();
    });

    it('records a restart-compact context manifest epoch on successful fresh restart (WS-C6)', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Fresh Restart Manifest',
      });
      await instance.readyPromise;

      await manager.restartFreshInstance(instance.id);

      const { getContextManifestHistory } = await import('../../context/context-manifest-store');
      const history = getContextManifestHistory(instance.id);
      const spawnEpoch = history.find((snapshot) => snapshot.trigger === 'spawn');
      const restartEpoch = history.find((snapshot) => snapshot.trigger === 'restart-compact');

      expect(spawnEpoch).toBeDefined();
      expect(restartEpoch).toBeDefined();
      expect(restartEpoch?.entries).toEqual([]);
      expect(restartEpoch?.note).toMatch(/no AIO system-prompt blocks were re-injected/i);
    });

    it('rolls back the replacement adapter when fresh restart spawn fails', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Fresh Restart Rollback',
      });
      await instance.readyPromise;

      const spawnFailure = new Error('fresh restart spawn failed');
      mockCreateCliAdapter.mockImplementation((_cliType, options) => {
        const adapter = makeMockAdapter();
        if ((options as { instanceId?: string } | undefined)?.instanceId === instance.id) {
          adapter.spawn = vi.fn().mockRejectedValue(spawnFailure);
        }
        return adapter;
      });

      await manager.restartFreshInstance(instance.id);

      expect(manager.getInstance(instance.id)).toBe(instance);
      expect(manager.getAdapter(instance.id)).toBeUndefined();
      expect(instance.status).toBe('error');
      expect(mockAdapterTerminate).toHaveBeenCalled();
    });
  });

  describe('getAllInstances', () => {
    it('returns empty array when no instances exist', () => {
      expect(manager.getAllInstances()).toEqual([]);
    });

    it('returns all created instances', async () => {
      await manager.createInstance({ workingDirectory: TEST_WORKING_DIR, displayName: 'A' });
      await manager.createInstance({ workingDirectory: TEST_WORKING_DIR, displayName: 'B' });

      const all = manager.getAllInstances();
      expect(all).toHaveLength(2);
      const names = all.map((i) => i.displayName);
      expect(names).toContain('A');
      expect(names).toContain('B');
    });

    it('removes terminated instances from the list', async () => {
      await manager.createInstance({ workingDirectory: TEST_WORKING_DIR, displayName: 'A' });
      const toTerminate = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'To Terminate',
      });

      expect(manager.getAllInstances()).toHaveLength(2);
      await manager.terminateInstance(toTerminate.id);

      // Terminated instance is removed from state; only 'A' remains
      const all = manager.getAllInstances();
      expect(all).toHaveLength(1);
      expect(all[0].displayName).toBe('A');
    });
  });

  describe('destroy', () => {
    it('calls stopTimeoutChecker on the task manager', () => {
      manager.destroy();
      expect(mockTaskManager.stopTimeoutChecker).toHaveBeenCalled();
    });
  });
});
