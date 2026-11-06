import { CodexCliAdapter } from '../../cli/adapters/codex-cli-adapter';
import type { AppServerClient } from '../../cli/adapters/codex/app-server-client';
import type { AppServerNotification } from '../../cli/adapters/codex/app-server-types';
vi.mock('../../cli/adapters/codex/app-server-client', async (importOriginal) => ({ ...await importOriginal<object>(), terminateProcessTree: vi.fn() }));
vi.mock('../../cli/adapters/codex/child-rollout-usage', () => ({ readChildRolloutUsage: vi.fn(async () => []) }));
import type { Instance } from '../../../shared/types/instance.types';
const probeHooks = vi.hoisted(() => ({ trigger: vi.fn(async (..._args: unknown[]) => ({ blocked: false })) }));

const preparationBarrier = vi.hoisted(() => ({ wait: undefined as Promise<void> | undefined, enter: undefined as (() => void) | undefined }));
vi.mock('../../context/restart-compaction', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../context/restart-compaction')>();
  return { ...actual, prepareRestartCompaction: async (...args: Parameters<typeof actual.prepareRestartCompaction>) => {
    preparationBarrier.enter?.();
    if (preparationBarrier.wait) await preparationBarrier.wait;
    return actual.prepareRestartCompaction(...args);
  } };
});
import { getSessionMutex } from '../../session/session-mutex';
import { RuntimeReadinessCoordinator } from '../lifecycle/runtime-readiness';
import { InstanceContinuationDispatch } from '../instance-continuation-dispatch';
import { InstanceAsyncWorkRegistry } from '../instance-async-work-registry';
import { captureInstanceRecoveryEpoch, isInstanceRecoveryEpochCurrent } from '../instance-turn-ending-state';
import { _resetMainEventBusForTesting } from '../../event-bus/main-event-bus';
const ownedProbePaths = await vi.hoisted(async () => {
  const { mkdtempSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'aio-compaction-receipt-'));
  for (const directory of ['project', 'userData', 'operator-profile', 'other', 'hooks']) {
    mkdirSync(join(root, directory));
  }
  return { root };
});
import { rmSync } from 'node:fs';
afterAll(() => rmSync(ownedProbePaths.root, { recursive: true, force: true }));

vi.mock('../../history/history-manager', () => ({
  getHistoryManager: () => ({archiveInstance: async () => undefined}), HistoryManager: class {},
}));
import { setupCompactionCoordinator, setCompactionMarkerRecorderForTesting } from '../../app/compaction-runtime';
import { CompactionCoordinator } from '../../context/compaction-coordinator';
import { _resetContextEngineForTesting } from '../../context/context-engine';
import { createSqliteWasmDatabase } from '../../db/sqlite-wasm-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { ProviderLimitLedger, createProviderLimitLedgerSchema } from '../../core/system/provider-limit-ledger';
import { SessionAdmissionStore } from '../../session/session-admission-store';
import { _resetSessionAdmissionServiceForTesting } from '../../session/session-admission-service';
import { WindowManager } from '../../window-manager';
vi.mock('../../rlm/llm-service', () => ({getLLMService: () => ({isAvailable: async () => false})}));
vi.mock('../../conversation-ledger', () => ({getConversationLedgerService: () => ({listEvidence: async () => []})}));
let boundaryDb: SqliteDriver | undefined;
function getBoundaryDb(): SqliteDriver { if (!boundaryDb) throw new Error('Boundary DB not initialized'); return boundaryDb; }
beforeEach(() => { _resetMainEventBusForTesting(); ProviderLimitLedger._resetForTesting(); boundaryDb=createSqliteWasmDatabase(':memory:'); createProviderLimitLedgerSchema(boundaryDb); CompactionCoordinator._resetForTesting(); _resetContextEngineForTesting(); SessionAdmissionStore._resetForTesting(); _resetSessionAdmissionServiceForTesting(); setCompactionMarkerRecorderForTesting(() => null); });
afterEach(() => { getInstanceProviderLimitHandler()._resetForTesting(); CompactionCoordinator._resetForTesting(); _resetContextEngineForTesting(); SessionAdmissionStore._resetForTesting(); _resetSessionAdmissionServiceForTesting(); ProviderLimitLedger._resetForTesting(); boundaryDb?.close(); boundaryDb=undefined; setCompactionMarkerRecorderForTesting(null); });
/**
 * Actual manager/communication overflow owner integration
 *
 * Split from instance-manager.spec.ts. Full mock preamble duplicated
 * (same pattern as instance-manager.normalized-event.spec.ts) so Vitest
 * mock hoisting stays reliable.
 *
 * Note: vi.mock() paths are resolved relative to THIS test file location:
 *   src/main/instance/__tests__/instance-manager.overflow-owner.spec.ts
 * So paths like '../../cli/...' resolve to src/main/cli/...
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
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
      projectKey: ownedProbePaths.root + '/project',
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
      if (name === 'home') return ownedProbePaths.root + '/operator-profile';
      if (name === 'userData') return ownedProbePaths.root + '/userData';
      return ownedProbePaths.root + '/other';
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
      path: ownedProbePaths.root + '/userData/settings.json',
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
let mockProviderCompacting = false;

// Build a per-test adapter factory so we can get fresh adapters
function makeMockAdapter() {
  const adapter = new EventEmitter() as EventEmitter & {
    spawn: () => Promise<number>;
    sendInput: (msg: string, attachments?: unknown[]) => Promise<void>;
    interrupt: () => ReturnType<typeof acceptedInterruptResult>;
    terminate: (graceful: boolean) => Promise<void>;
    getName: () => string;
    isProviderCompacting: () => boolean;
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
  adapter.isProviderCompacting = () => mockProviderCompacting;
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
  ensureHookScript: vi.fn(() => ownedProbePaths.root + '/hooks/defer-permission-hook.mjs'),
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
  formatCommandResponse: vi.fn((action: string, success: boolean, data: unknown) =>
    `[Orchestrator Response]\nAction: ${action}\nStatus: ${success ? 'SUCCESS' : 'FAILED'}\n${JSON.stringify(data)}\n[/Orchestrator Response]`
  ),
  detectsConsensusIntent: vi.fn().mockReturnValue(false),
  detectsSchedulingIntent: vi.fn().mockReturnValue(false),
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

vi.mock('../../orchestration/loop-start-config', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../orchestration/loop-start-config')>(),
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
    initializeRlm: vi.fn().mockResolvedValue(undefined),
    endRlmSession: vi.fn(),
    ingestInitialOutputToRlm: vi.fn().mockResolvedValue(undefined),
    ingestToRLM: vi.fn(),
    ingestToUnifiedMemory: vi.fn(),
    recordTaskOutcome: vi.fn(),
    calculateContextBudget: vi.fn(() => ({ totalTokens: 0, rlmMaxTokens: 0, unifiedMaxTokens: 0, rlmTopK: 0 })),
    buildRlmContext: vi.fn().mockResolvedValue(null),
    buildUnifiedMemoryContext: vi.fn().mockResolvedValue(null),
    buildObservationContext: vi.fn().mockResolvedValue(null),
    buildWakeContextText: vi.fn().mockResolvedValue(null),
    buildMcpRuntimeToolContextSelection: vi.fn().mockResolvedValue(null),
    formatRlmContextBlock: vi.fn(() => null),
    formatUnifiedMemoryContextBlock: vi.fn(() => null),
    compactContext: vi.fn().mockResolvedValue(undefined),
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
    triggerLifecycleHooks: (...args: unknown[]) => probeHooks.trigger(...args),
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
    access: vi.fn().mockRejectedValue(Object.assign(new Error('inert instructions absent'), { code: 'ENOENT' })),
    readFile: vi.fn((filename: unknown) => Promise.reject(Object.assign(new Error('inert unavailable path: ' + String(filename)), { code: 'ENOENT' }))),
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
vi.mock('../../../shared/types/command.types', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../shared/types/command.types')>(),
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
    getRawDb: () => getBoundaryDb(),
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
import { getInstanceProviderLimitHandler } from '../instance-provider-limit-handler';
import { WorkerNodeRegistry } from '../../remote-node/worker-node-registry';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_WORKING_DIR = ownedProbePaths.root + '/project';

function createManager(): InstanceManager {
  return new InstanceManager();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InstanceManager', () => {
  let manager: InstanceManager;

  beforeEach(() => {
    vi.clearAllMocks();
    probeHooks.trigger.mockImplementation(async () => ({ blocked: false }));
    idCounter = 0;

    // Restore default mocks after clearAllMocks wipes them
    mockAdapterSpawn.mockResolvedValue(12345);
    mockAdapterSendInput.mockResolvedValue(undefined);
    mockAdapterInterrupt.mockImplementation(acceptedInterruptResult);
    mockAdapterTerminate.mockResolvedValue(undefined);
    mockProviderCompacting = false;
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


  });

  it.each(['current', 'stop', 'new-user-input'] as const)('fresh owner barrier: %s', async cause => {
    mockAdapterName = 'gemini-cli';
    const instance = await manager.createInstance({ workingDirectory: TEST_WORKING_DIR });
    await instance.readyPromise;
    instance.provider = 'gemini';
    instance.currentModel = 'inert-model';
    const owner = new InstanceContinuationDispatch(new InstanceAsyncWorkRegistry(), manager);
    owner.start();
    setupCompactionCoordinator(manager, new WindowManager());
    const restart = vi.spyOn(manager, 'restartFreshInstance');
    let release!: () => void;
    let entered!: () => void;
    const atPreparation = new Promise<void>(resolve => { entered = resolve; });
    preparationBarrier.wait = new Promise<void>(resolve => { release = resolve; });
    preparationBarrier.enter = entered;
    const writes: string[] = [];
    mockAdapterSendInput.mockImplementation(async (text: string) => {
      writes.push(text);
      if (writes.length === 1) throw new Error('The input token count (201,000) exceeds the maximum number of tokens allowed (200,000).');
    });
    const delivered = vi.fn();
    const original = manager.sendInput(instance.id, 'ORIGINAL INERT REQUEST', undefined, { onProviderInputDelivered: delivered });
    try {
      await atPreparation;
      const epoch = captureInstanceRecoveryEpoch(instance.id);
      if (cause === 'stop') manager.interruptInstance(instance.id, 'renderer-ipc');
      if (cause === 'new-user-input') await manager.sendInput(instance.id, 'NEWER INERT REQUEST');
      const currentAfterAction = isInstanceRecoveryEpochCurrent(instance.id, epoch);
      release();
      await original;

      expect(currentAfterAction).toBe(cause === 'current');
      expect(restart).toHaveBeenCalledTimes(cause === 'current' ? 1 : 0);
      expect(writes.filter(text => text.includes('Continuity Package'))).toHaveLength(cause === 'current' ? 1 : 0);
      expect(delivered).toHaveBeenCalledTimes(cause === 'current' ? 1 : 0);
    } finally {
      release();
      await original.catch(() => undefined);
      preparationBarrier.wait = undefined;
      preparationBarrier.enter = undefined;
      owner.stop();
    }
  });

  it.each((['mutex', 'cli-resolution', 'readiness', 'final-admission'] as const).flatMap(boundary =>
    (['current', 'stop', 'new-user-input'] as const).map(cause => ({ boundary, cause }))))(
    'logical owner boundary matrix: $boundary $cause', async ({ boundary, cause }) => {
        mockAdapterName = 'gemini-cli';
        const instance = await manager.createInstance({ workingDirectory: TEST_WORKING_DIR });
        await instance.readyPromise;
        instance.provider = 'gemini';
        const owner = new InstanceContinuationDispatch(new InstanceAsyncWorkRegistry(), manager);
        owner.start();
        CompactionCoordinator._resetForTesting();
        _resetContextEngineForTesting();
        setupCompactionCoordinator(manager, new WindowManager());
        let release!: () => void;
        let entered!: () => void;
        const atBarrier = new Promise<void>(resolve => { entered = resolve; });
        const wait = new Promise<void>(resolve => { release = resolve; });
        const restart = vi.spyOn(manager, 'restartFreshInstance');
        const terminateBefore = mockAdapterTerminate.mock.calls.length;
        const oldAdapter = manager.getAdapter(instance.id);
        let unlock: (() => void) | undefined;
        let restore: (() => void) | undefined;
        if (boundary === 'mutex') {
          unlock = await getSessionMutex().acquire(instance.id, 'owned-probe');
        } else if (boundary === 'cli-resolution') {
          const lifecycle = (manager as unknown as { lifecycle: { resolveCliTypeForInstance: (value: unknown) => Promise<unknown> } }).lifecycle;
          const real = lifecycle.resolveCliTypeForInstance.bind(lifecycle);
          const spy = vi.spyOn(lifecycle, 'resolveCliTypeForInstance').mockImplementation(async value => {
            const result = await real(value); entered(); await wait; return result;
          });
          restore = () => spy.mockRestore();
        } else if (boundary === 'readiness') {
          const real = RuntimeReadinessCoordinator.prototype.waitForInputReadinessBoundary;
          const spy = vi.spyOn(RuntimeReadinessCoordinator.prototype, 'waitForInputReadinessBoundary').mockImplementation(async function (this: RuntimeReadinessCoordinator, ...args) {
            entered(); await wait; return real.apply(this, args);
          });
          restore = () => spy.mockRestore();
        } else {
          probeHooks.trigger.mockImplementation(async (...args) => {
            if (args[0] === 'PreSampling' && JSON.stringify(args).includes('Continuity Package')) {
              entered(); await wait;
            }
            return { blocked: false };
          });
          restore = () => probeHooks.trigger.mockImplementation(async () => ({ blocked: false }));
        }
        const writes: string[] = [];
        mockAdapterSendInput.mockImplementation(async (text: string) => {
          writes.push(text);
          if (writes.length === 1) throw new Error('The input token count (201,000) exceeds the maximum number of tokens allowed (200,000).');
        });
        const delivered = vi.fn();
        const original = manager.sendInput(instance.id, 'ORIGINAL INERT REQUEST', undefined, { onProviderInputDelivered: delivered });
        let newer: Promise<void> | undefined;
        try {
          if (boundary === 'mutex') await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
          else await atBarrier;
          if (cause === 'stop') manager.interruptInstance(instance.id, 'renderer-ipc');
          if (cause === 'new-user-input') newer = manager.sendInput(instance.id, 'NEWER INERT REQUEST');
          
          unlock?.(); unlock = undefined; release();
          await original; await newer;

          expect(writes.filter(text => text.includes('Continuity Package'))).toHaveLength(cause === 'current' ? 1 : 0);
          expect(delivered).toHaveBeenCalledTimes(cause === 'current' ? 1 : 0);
          if (cause !== 'current' && (boundary === 'mutex' || boundary === 'cli-resolution')) {
            expect(mockAdapterTerminate.mock.calls.length).toBe(terminateBefore);
            expect(manager.getAdapter(instance.id)).toBe(oldAdapter);
          }
          if (boundary === 'readiness') expect(manager.getAdapter(instance.id)).not.toBe(oldAdapter);
          if (cause === 'new-user-input') expect(writes).toContain('NEWER INERT REQUEST');
        } finally {
          unlock?.(); release(); await original.catch(() => undefined); await newer?.catch(() => undefined); restore?.(); restart.mockRestore(); owner.stop();
        }
    },
  );
  it('preserves a confirmed restart delivery when Stop follows the write', async () => {
    mockAdapterName = 'gemini-cli';
    const instance = await manager.createInstance({ workingDirectory: TEST_WORKING_DIR });
    await instance.readyPromise;
    const owner = new InstanceContinuationDispatch(new InstanceAsyncWorkRegistry(), manager);
    owner.start();
    setupCompactionCoordinator(manager, new WindowManager());
    let writes = 0;
    mockAdapterSendInput.mockImplementation(async () => {
      if (++writes === 1) throw new Error('The input token count (201,000) exceeds the maximum number of tokens allowed (200,000).');
      manager.interruptInstance(instance.id, 'renderer-ipc');
    });
    const delivered = vi.fn();
    try {
      await manager.sendInput(instance.id, 'ORIGINAL INERT REQUEST', undefined, { onProviderInputDelivered: delivered });
      expect(writes).toBe(2);
      expect(delivered).toHaveBeenCalledOnce();
    } finally { owner.stop(); }
  });

  it.each((['silent', 'adapter-no-resume', 'breaker-hook'] as const).flatMap(kind =>
    (['current', 'stop', 'new-user-input'] as const).map(cause => ({ kind, cause }))))(
    'no-resume owner: $kind $cause', async ({ kind, cause }) => {
      mockAdapterName = 'gemini-cli';
      const instance = await manager.createInstance({ workingDirectory: TEST_WORKING_DIR });
      await instance.readyPromise;
      const owner = new InstanceContinuationDispatch(new InstanceAsyncWorkRegistry(), manager);
      owner.start();
      setupCompactionCoordinator(manager, new WindowManager());
      const restart = vi.spyOn(manager, 'restartFreshInstance');
      let release!: () => void;
      let entered!: () => void;
      const atPreparation = new Promise<void>(resolve => { entered = resolve; });
      preparationBarrier.wait = new Promise<void>(resolve => { release = resolve; });
      preparationBarrier.enter = entered;
      const communication = (manager as unknown as { communication: {
        overflowPolicy: {
          compactSilentEmptyResponse: (input: { instanceId: string; instance: Instance; reason: string }) => Promise<boolean>;
          recoverAdapterErrorOverflow: (input: { instanceId: string; instance: Instance; errorText: string }) => Promise<boolean>;
        };
        deps: { compactContext: (id: string) => Promise<unknown> };
      } }).communication;
      const original = kind === 'silent'
        ? communication.overflowPolicy.compactSilentEmptyResponse({ instanceId: instance.id, instance, reason: 'near-ceiling' })
        : kind === 'adapter-no-resume'
          ? communication.overflowPolicy.recoverAdapterErrorOverflow({ instanceId: instance.id, instance, errorText: 'context overflow' })
          : communication.deps.compactContext(instance.id);
      const settled = original.catch(error => error);
      try {
        await atPreparation;
        if (cause === 'stop') manager.interruptInstance(instance.id, 'renderer-ipc');
        if (cause === 'new-user-input') await manager.sendInput(instance.id, 'NEWER INERT REQUEST');
        release(); await settled;

        expect(restart).toHaveBeenCalledTimes(cause === 'current' ? 1 : 0);
        expect(mockAdapterSendInput.mock.calls.filter(args => String(args[0]).includes('Continuity Package'))).toHaveLength(cause === 'current' ? 1 : 0);
      } finally {
        release(); await settled; preparationBarrier.wait = undefined; preparationBarrier.enter = undefined; owner.stop();
      }
    },
  );


  it.each(['current', 'stop', 'new-user-input'] as const)('committed teardown ownership: %s', async cause => {
    mockAdapterName = 'gemini-cli';
    const instance = await manager.createInstance({ workingDirectory: TEST_WORKING_DIR });
    await instance.readyPromise;
    const owner = new InstanceContinuationDispatch(new InstanceAsyncWorkRegistry(), manager);
    owner.start();
    setupCompactionCoordinator(manager, new WindowManager());
    let release!: () => void;
    let entered!: () => void;
    const atArchive = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const lifecycle = (manager as unknown as { lifecycle: { archiveRestartSnapshot: (...args: unknown[]) => Promise<unknown> } }).lifecycle;
    const real = lifecycle.archiveRestartSnapshot.bind(lifecycle);
    const archive = vi.spyOn(lifecycle, 'archiveRestartSnapshot').mockImplementation(async (...args) => {
      entered(); await wait; return real(...args);
    });
    const oldAdapter = manager.getAdapter(instance.id);
    const writes: { text: string; adapter: unknown }[] = [];
    mockAdapterSendInput.mockImplementation(async function (this: unknown, text: string) {
      writes.push({ text, adapter: this });
      if (text === 'NEWER INERT REQUEST') (this as EventEmitter).emit('status', 'busy');
      if (writes.length === 1) throw new Error('The input token count (201,000) exceeds the maximum number of tokens allowed (200,000).');
    });
    const delivered = vi.fn();
    const original = manager.sendInput(instance.id, 'ORIGINAL INERT REQUEST', undefined, { onProviderInputDelivered: delivered });
    let newer: Promise<void> | undefined;
    try {
      await atArchive;
      const waiting = instance.readyPromise;
      if (cause === 'stop') manager.interruptInstance(instance.id, 'renderer-ipc');
      if (cause === 'new-user-input') newer = manager.sendInput(instance.id, 'NEWER INERT REQUEST');
      await new Promise<void>(resolve => setTimeout(resolve, 25));
      const prematureNewerWrite = writes.some(write => write.text === 'NEWER INERT REQUEST');
      release(); await original; await newer;
      expect(waiting).toBeDefined();
      expect(prematureNewerWrite).toBe(false);
      expect(instance.readyPromise).toBeUndefined();
      expect(writes.filter(write => write.text.includes('Continuity Package'))).toHaveLength(cause === 'current' ? 1 : 0);
      expect(delivered).toHaveBeenCalledTimes(cause === 'current' ? 1 : 0);
      expect(manager.getAdapter(instance.id)).not.toBe(oldAdapter);
      if (cause === 'new-user-input') {
        expect(writes.find(write => write.text === 'NEWER INERT REQUEST')?.adapter).toBe(manager.getAdapter(instance.id));
        expect(instance.status).toBe('busy');
      } else if (cause === 'stop') expect(instance.status).toBe('idle');
    } finally { release(); await original.catch(() => undefined); await newer?.catch(() => undefined); archive.mockRestore(); owner.stop(); }
  });

  it.each(['archive', 'spawn'] as const)('settles owned replacement readiness on %s failure', async boundary => {
    const instance = await manager.createInstance({ workingDirectory: TEST_WORKING_DIR });
    await instance.readyPromise;
    let release!: () => void;
    let entered!: () => void;
    const atBarrier = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const lifecycle = (manager as unknown as { lifecycle: { archiveRestartSnapshot: (...args: unknown[]) => Promise<unknown> } }).lifecycle;
    const failure = async () => { entered(); await wait; throw new Error('inert replacement failure'); };
    const archive = boundary === 'archive' ? vi.spyOn(lifecycle, 'archiveRestartSnapshot').mockImplementation(failure) : undefined;
    const creator = (manager as unknown as { lifecycle: { createRuntimeAdapter: (...args: unknown[]) => Promise<{ spawn: () => Promise<number> }> } }).lifecycle;
    const realCreate = creator.createRuntimeAdapter.bind(creator);
    const spawn = boundary === 'spawn' ? vi.spyOn(creator, 'createRuntimeAdapter').mockImplementation(async (...args) => {
      const adapter = await realCreate(...args); adapter.spawn = failure; return adapter;
    }) : undefined;
    const restarted = manager.restartFreshInstance(instance.id, () => undefined).catch(error => error);
    let newer: Promise<unknown> | undefined;
    try {
      await atBarrier;
      expect(instance.readyPromise).toBeDefined();
      newer = manager.sendInput(instance.id, 'NEWER INERT REQUEST').catch(error => error);
      release();
      expect(await restarted).toBeInstanceOf(Error);
      expect(await newer).toBeInstanceOf(Error);
      expect(instance.status).toBe('error');
      expect(instance.readyPromise).toBeUndefined();
      expect(mockAdapterSendInput).not.toHaveBeenCalled();
    } finally { release(); await restarted; await newer; archive?.mockRestore(); spawn?.mockRestore(); }
  });

  it.each((['preparation', 'final-admission'] as const).flatMap(boundary =>
    (['current', 'signal', 'caller-veto'] as const).map(cause => ({ boundary, cause }))))(
    'retains original caller authority: $boundary $cause', async ({ boundary, cause }) => {
      mockAdapterName = 'gemini-cli';
      const instance = await manager.createInstance({ workingDirectory: TEST_WORKING_DIR });
      await instance.readyPromise;
      setupCompactionCoordinator(manager, new WindowManager());
      const controller = new AbortController();
      let revoked = false;
      let release!: () => void;
      let entered!: () => void;
      const atBarrier = new Promise<void>(resolve => { entered = resolve; });
      const wait = new Promise<void>(resolve => { release = resolve; });
      if (boundary === 'preparation') { preparationBarrier.wait = wait; preparationBarrier.enter = entered; }
      else probeHooks.trigger.mockImplementation(async (...args) => {
        if (args[0] === 'PreSampling' && JSON.stringify(args).includes('Continuity Package')) { entered(); await wait; }
        return { blocked: false };
      });
      let writes = 0;
      mockAdapterSendInput.mockImplementation(async () => {
        if (++writes === 1) throw new Error('The input token count (201,000) exceeds the maximum number of tokens allowed (200,000).');
      });
      const caller = vi.fn(() => { if (revoked) throw Object.assign(new Error('Original caller revoked'), { name: 'AbortError' }); });
      const delivered = vi.fn();
      const restart = vi.spyOn(manager, 'restartFreshInstance');
      const pending = manager.sendInput(instance.id, 'ORIGINAL INERT REQUEST', undefined, {
        signal: controller.signal, assertProviderDispatchCurrent: caller, onProviderInputDelivered: delivered,
      });
      try {
        await atBarrier;
        if (cause === 'signal') controller.abort();
        if (cause === 'caller-veto') revoked = true;
        release(); await pending;
        expect(writes).toBe(cause === 'current' ? 2 : 1);
        expect(delivered).toHaveBeenCalledTimes(cause === 'current' ? 1 : 0);
        if (boundary === 'preparation' && cause !== 'current') expect(restart).not.toHaveBeenCalled();
        if (cause === 'current') expect(caller).toHaveBeenCalledWith('context-overflow');
      } finally {
        release(); await pending.catch(() => undefined); preparationBarrier.wait = undefined; preparationBarrier.enter = undefined;
        probeHooks.trigger.mockImplementation(async () => ({ blocked: false })); restart.mockRestore();
      }
    },
  );
  it('does not clear a newer readiness owner when its replacement finishes', async () => {
    const instance = await manager.createInstance({ workingDirectory: TEST_WORKING_DIR });
    await instance.readyPromise;
    let release!: () => void;
    let entered!: () => void;
    const atArchive = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const lifecycle = (manager as unknown as { lifecycle: { archiveRestartSnapshot: (...args: unknown[]) => Promise<unknown> } }).lifecycle;
    const archive = vi.spyOn(lifecycle, 'archiveRestartSnapshot').mockImplementation(async () => { entered(); await wait; });
    const restart = manager.restartFreshInstance(instance.id, () => undefined);
    let newerRelease!: () => void;
    const newerReady = new Promise<void>(resolve => { newerRelease = resolve; });
    try {
      await atArchive;
      const ownedReady = instance.readyPromise;
      instance.readyPromise = newerReady;
      release(); await restart; await ownedReady;
      expect(instance.readyPromise).toBe(newerReady);
    } finally { release(); newerRelease(); await restart.catch(() => undefined); archive.mockRestore(); }
  });

  it.each(['current', 'caller-veto', 'signal'] as const)('native compaction retains caller authority: %s', async cause => {
    mockAdapterName = 'gemini-cli';
    const instance = await manager.createInstance({ workingDirectory: TEST_WORKING_DIR });
    await instance.readyPromise;
    setupCompactionCoordinator(manager, new WindowManager());
    const controller = new AbortController();
    let revoked = false;
    let release!: () => void;
    let entered!: () => void;
    const atNative = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const adapter = manager.getAdapter(instance.id)!;
    Object.assign(adapter, { compactContext: async () => { entered(); await wait; return true; } });
    let writes = 0;
    mockAdapterSendInput.mockImplementation(async () => {
      adapter.emit('status', 'busy');
      if (++writes === 1) throw new Error('The input token count (201,000) exceeds the maximum number of tokens allowed (200,000).');
    });
    const delivered = vi.fn();
    const pending = manager.sendInput(instance.id, 'ORIGINAL INERT REQUEST', undefined, {
      signal: controller.signal, onProviderInputDelivered: delivered,
      assertProviderDispatchCurrent: () => { if (revoked) throw Object.assign(new Error('Caller revoked'), { name: 'AbortError' }); },
    });
    try {
      await atNative;
      if (cause === 'caller-veto') revoked = true;
      if (cause === 'signal') controller.abort();
      const retryNotices = () => instance.outputBuffer.filter(message => message.metadata?.['retrying']);
      release(); await pending;
      expect(writes).toBe(cause === 'current' ? 2 : 1);
      expect(delivered).toHaveBeenCalledTimes(cause === 'current' ? 1 : 0);
      expect(retryNotices()).toHaveLength(cause === 'current' ? 1 : 0);
    } finally { release(); await pending.catch(() => undefined); }
  });
  it.each(['current', 'stop', 'new-user-input'] as const)('replacement native injection acknowledgement: %s', async cause => {
    mockAdapterName = 'gemini-cli';
    const instance = await manager.createInstance({ workingDirectory: TEST_WORKING_DIR });
    await instance.readyPromise;
    const owner = new InstanceContinuationDispatch(new InstanceAsyncWorkRegistry(), manager);
    owner.start();
    setupCompactionCoordinator(manager, new WindowManager());
    const replacement = new CodexCliAdapter({ timeout: 2000 });
    const subscribers = new Set<(notification: AppServerNotification) => void>();
    const requests: [string, Record<string, unknown>][] = [];
    let entered = false;
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const client = {
      exitPromise: new Promise<void>(() => undefined),
      request: async (method: string, params: Record<string, unknown>) => {
        requests.push([method, params]);
        if (method === 'thread/inject_items') { entered = true; await wait; }
        if (method === 'thread/goal/get') return { goal: null };
        if (method === 'turn/start') return { turn: { id: 'inert-replacement-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'Finished.' }] } };
        return {};
      },
      subscribeNotifications: (callback: (notification: AppServerNotification) => void) => {
        subscribers.add(callback); return () => subscribers.delete(callback);
      },
      isRunning: () => true,
      getPid: () => 4242,
    };
    Object.assign(replacement, { appServerClient: client as unknown as AppServerClient, appServerThreadId: 'inert-replacement-thread', useAppServer: true, isSpawned: true });
    const internal = replacement as unknown as {
      appServerRuntime: { attach: (client: AppServerClient, binding: { threadId: string; resumeCursor: null; resumeProof: null }, callback: (notification: AppServerNotification) => void) => void };
      handleIdleAppServerNotification: (notification: AppServerNotification) => void;
    };
    internal.appServerRuntime.attach(client as unknown as AppServerClient, { threadId: 'inert-replacement-thread', resumeCursor: null, resumeProof: null }, notification => internal.handleIdleAppServerNotification(notification));
    vi.spyOn(replacement, 'spawn').mockResolvedValue(4242);
    const lifecycle = (manager as unknown as { lifecycle: { createRuntimeAdapter: (...args: unknown[]) => Promise<unknown> } }).lifecycle;
    const create = vi.spyOn(lifecycle, 'createRuntimeAdapter').mockResolvedValue(replacement);
    mockAdapterSendInput.mockRejectedValueOnce(new Error('The input token count (201,000) exceeds the maximum number of tokens allowed (200,000).'));
    const delivered = vi.fn();
    const newerDelivered = vi.fn();
    const pending = manager.sendInput(instance.id, 'ORIGINAL INERT REQUEST', undefined, { onProviderInputDelivered: delivered });
    let newer: Promise<void> | undefined;
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      if (cause === 'stop') manager.interruptInstance(instance.id, 'renderer-ipc');
      if (cause === 'new-user-input') newer = manager.sendInput(instance.id, 'NEWER INERT REQUEST', undefined, { onProviderInputDelivered: newerDelivered });
      release(); await pending; await newer;
      const turns = requests.filter(([method]) => method === 'turn/start');
      // Injection began while current. Revocation prevents the following obsolete turn,
      // but cannot retract that already submitted developer context.
      expect(requests.filter(([method]) => method === 'thread/inject_items')).toHaveLength(1);
      expect(turns).toHaveLength(cause === 'stop' ? 0 : 1);
      expect(delivered).toHaveBeenCalledTimes(cause === 'current' ? 1 : 0);
      expect(newerDelivered).toHaveBeenCalledTimes(cause === 'new-user-input' ? 1 : 0);
      if (cause === 'new-user-input') expect(JSON.stringify(turns[0])).toContain('NEWER INERT REQUEST');
      expect(manager.getAdapter(instance.id)).toBe(replacement);
      expect(instance.readyPromise).toBeUndefined();
    } finally {
      release(); await pending.catch(() => undefined); await newer?.catch(() => undefined);
      owner.stop(); create.mockRestore(); await replacement.terminate(false);
    }
  });

  it.each(['current', 'settled-stop', 'newer-delivered', 'newer-preparing'] as const)('late original overflow rejection: %s', async cause => {
    mockAdapterName = 'gemini-cli';
    const instance = await manager.createInstance({ workingDirectory: TEST_WORKING_DIR });
    await instance.readyPromise;
    const owner = new InstanceContinuationDispatch(new InstanceAsyncWorkRegistry(), manager);
    owner.start();
    setupCompactionCoordinator(manager, new WindowManager());
    const oldAdapter = manager.getAdapter(instance.id)!;
    const restart = vi.spyOn(manager, 'restartFreshInstance');
    const terminateBefore = mockAdapterTerminate.mock.calls.length;
    let entered = false;
    let release!: () => void;
    let releaseNewer!: () => void;
    let newerPreparing = false;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const newerWait = new Promise<void>(resolve => { releaseNewer = resolve; });
    const writes: string[] = [];
    mockAdapterSendInput.mockImplementation(async function (this: EventEmitter, text: string) {
      writes.push(text);
      this.emit('status', 'busy');
      if (text === 'ORIGINAL LATE REQUEST') {
        entered = true; await wait;
        throw new Error('The input token count (201,000) exceeds the maximum number of tokens allowed (200,000).');
      }
    });
    probeHooks.trigger.mockImplementation(async (...args) => {
      if (cause === 'newer-preparing' && args[0] === 'UserPromptSubmit' && JSON.stringify(args).includes('NEWER LATE REQUEST')) {
        newerPreparing = true; await newerWait;
      }
      return { blocked: false };
    });
    const delivered = vi.fn();
    const newerDelivered = vi.fn();
    const pending = manager.sendInput(instance.id, 'ORIGINAL LATE REQUEST', undefined, { onProviderInputDelivered: delivered });
    const settled = pending.catch(error => error);
    let newer: Promise<unknown> | undefined;
    try {
      await vi.waitFor(() => expect(entered).toBe(true));
      const originalCount = instance.requestCount;
      const originalEpoch = captureInstanceRecoveryEpoch(instance.id);
      if (cause === 'settled-stop') {
        expect(manager.interruptInstance(instance.id, 'renderer-ipc')).toBe(true);
        await vi.waitFor(() => expect(instance.status).toBe('idle'));
        expect(instance.respawnPromise).toBeUndefined();
      }
      if (cause.startsWith('newer-')) {
        newer = manager.sendInput(instance.id, 'NEWER LATE REQUEST', undefined, { onProviderInputDelivered: newerDelivered }).catch(error => error);
        if (cause === 'newer-preparing') {
          await vi.waitFor(() => expect(newerPreparing).toBe(true));
          expect(instance.requestCount).toBe(originalCount);
          expect(writes).toEqual(['ORIGINAL LATE REQUEST']);
        } else await newer;
      }
      if (cause !== 'current') expect(isInstanceRecoveryEpochCurrent(instance.id, originalEpoch)).toBe(false);
      release(); const outcome = await settled;
      releaseNewer(); const newerOutcome = await newer;
      const observation = { cause, restart: restart.mock.calls.length, terminated: mockAdapterTerminate.mock.calls.length - terminateBefore,
        packageWrites: writes.filter(text => text.includes('Continuity Package')).length,
        originalDelivered: delivered.mock.calls.length, newerDelivered: newerDelivered.mock.calls.length,
        overflowNotices: instance.outputBuffer.filter(message => message.metadata?.['contextOverflow']).length,
        oldAdapterRetained: manager.getAdapter(instance.id) === oldAdapter };
      console.log('LATE_REJECTION_OBSERVATION', JSON.stringify(observation));
      expect(outcome).toBeUndefined();
      expect(newerOutcome).toBeUndefined();
      expect(observation.restart).toBe(cause === 'current' ? 1 : 0);
      expect(observation.terminated).toBe(cause === 'current' ? 1 : 0);
      expect(observation.packageWrites).toBe(cause === 'current' ? 1 : 0);
      expect(observation.originalDelivered).toBe(cause === 'current' ? 1 : 0);
      expect(observation.newerDelivered).toBe(cause.startsWith('newer-') ? 1 : 0);
      if (cause !== 'current') {
        expect(observation.overflowNotices).toBe(0);
        expect(observation.oldAdapterRetained).toBe(true);
      }
    } finally {
      release(); releaseNewer(); await settled; await newer;
      probeHooks.trigger.mockImplementation(async () => ({ blocked: false })); restart.mockRestore(); owner.stop();
    }
  });

});
