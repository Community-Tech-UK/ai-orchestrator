/**
 * InstanceManager Tests
 *
 * Tests the thin coordinator that delegates to specialized sub-managers.
 * All external dependencies (electron, CLI adapters, singletons) are mocked
 * at the module level so no real processes are spawned.
 *
 * Note: vi.mock() paths are resolved relative to THIS test file location:
 *   src/main/instance/__tests__/instance-manager.spec.ts
 * So paths like '../../cli/...' resolve to src/main/cli/...
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const {
  mockCreateCliAdapter,
  mockProjectMemoryBuildBrief,
  mockPromptHistoryRecord,
  mockResourceGovernorGetCreationBlockReason,
} = vi.hoisted(() => ({
  mockCreateCliAdapter: vi.fn(),
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
  mockResourceGovernorGetCreationBlockReason: vi.fn<() => string | null>(() => null),
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
const mockAdapterTerminate = vi.fn().mockResolvedValue(undefined);
const mockAutoTitleMaybeGenerate = vi.fn().mockResolvedValue(undefined);
const mockAutoTitleClearInstance = vi.fn();
let mockAdapterName = 'claude-cli';

// Build a per-test adapter factory so we can get fresh adapters
function makeMockAdapter() {
  const adapter = new EventEmitter() as EventEmitter & {
    spawn: () => Promise<number>;
    sendInput: (msg: string, attachments?: unknown[]) => Promise<void>;
    terminate: (graceful: boolean) => Promise<void>;
    getName: () => string;
  };
  adapter.spawn = mockAdapterSpawn;
  adapter.sendInput = mockAdapterSendInput;
  adapter.terminate = mockAdapterTerminate;
  adapter.getName = () => mockAdapterName;
  return adapter;
}

vi.mock('../../cli/adapters/adapter-factory', () => ({
  createCliAdapter: mockCreateCliAdapter,
  resolveCliType: vi.fn().mockResolvedValue('claude'),
  getCliDisplayName: vi.fn(() => 'Claude Code'),
}));

vi.mock('../../cli/claude-cli-adapter', () => ({
  ClaudeCliAdapter: vi.fn().mockImplementation(() => makeMockAdapter()),
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
}));

// ---------------------------------------------------------------------------
// Command manager / markdown registry mocks
// ---------------------------------------------------------------------------
vi.mock('../../commands/command-manager', () => ({
  getCommandManager: vi.fn(() => ({
    executeCommandString: vi.fn().mockResolvedValue(null),
  })),
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

vi.mock('../../prompt-history/prompt-history-service', () => ({
  getPromptHistoryService: vi.fn(() => ({
    record: mockPromptHistoryRecord,
  })),
}));

vi.mock('../../memory/codebase-miner', () => ({
  getCodebaseMiner: vi.fn(() => ({
    mineDirectory: vi.fn().mockResolvedValue(undefined),
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
vi.mock('../../../shared/types/provider.types', () => ({
  getModelsForProvider: vi.fn().mockReturnValue([]),
  getProviderModelContextWindow: vi.fn((provider: string, model?: string) => {
    if (provider === 'claude' && model?.endsWith('[1m]')) return 1000000;
    if (provider === 'claude' && model?.includes('opus')) return 1000000;
    if (provider === 'claude') return 1000000;
    return 200000;
  }),
  isModelTier: vi.fn().mockReturnValue(false),
  looksLikeCodexModelId: vi.fn().mockReturnValue(false),
  resolveModelForTier: vi.fn().mockReturnValue(undefined),
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
vi.mock('../../../shared/constants/limits', () => ({
  LIMITS: {
    OUTPUT_BATCH_INTERVAL_MS: 100,
    OUTPUT_BUFFER_MAX_SIZE: 500,
    DEFAULT_MAX_CONTEXT_TOKENS: 1000000,
  },
}));

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
    shutdownCodemem: vi.fn().mockResolvedValue(undefined),
    resetCodememForTesting: vi.fn(),
  };
});

// ---------------------------------------------------------------------------
// Now import the class under test (after all mocks are defined)
// ---------------------------------------------------------------------------

import { InstanceManager } from '../instance-manager';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_WORKING_DIR = '/tmp/test-project';

function createManager(): InstanceManager {
  return new InstanceManager();
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
    mockAdapterTerminate.mockResolvedValue(undefined);
    mockCreateCliAdapter.mockImplementation(() => makeMockAdapter());
    mockAutoTitleMaybeGenerate.mockResolvedValue(undefined);
    mockAutoTitleClearInstance.mockReset();
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
    mockAdapterName = 'claude-cli';

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
    mockResourceGovernorGetCreationBlockReason.mockReturnValue(null);

    manager = createManager();
  });

  afterEach(() => {
    try {
      manager.destroy();
    } catch {
      // Ignore errors on destroy in cleanup
    }

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

  // =========================================================================
  // getInstance
  // =========================================================================

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

  // =========================================================================
  // createInstance
  // =========================================================================

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
        );
      });
      await vi.waitFor(() => {
        expect(mockAdapterSendInput).toHaveBeenCalledWith(
          'Investigate the failed deployment and summarize the root cause.',
          undefined,
        );
      });
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
      mockProjectMemoryBuildBrief.mockResolvedValue({
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
      expect(mockAdapterSendInput).toHaveBeenCalledWith('Check auth middleware', undefined);
    });

    it('skips project memory brief for child instances, resumed sessions, and restore continuity', async () => {
      const parent = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Parent',
      });
      await parent.readyPromise;
      mockProjectMemoryBuildBrief.mockClear();

      const child = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Child',
        parentId: parent.id,
        initialPrompt: 'child task',
      });
      await child.readyPromise;
      expect(mockProjectMemoryBuildBrief).not.toHaveBeenCalled();

      const resumed = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        resume: true,
        sessionId: 'session-resume',
      });
      await resumed.readyPromise;
      expect(mockProjectMemoryBuildBrief).not.toHaveBeenCalled();

      const restored = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        initialOutputBuffer: [
          { id: 'restored-user', timestamp: 1, type: 'user', content: 'old message' },
        ],
      });
      await restored.readyPromise;
      expect(mockProjectMemoryBuildBrief).not.toHaveBeenCalled();
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
  });

  // =========================================================================
  // forkInstance
  // =========================================================================

  describe('forkInstance', () => {
    it('keeps the source alive for prompted forks unless supersession is explicit', async () => {
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

  // =========================================================================
  // terminateInstance
  // =========================================================================

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
  });

  // =========================================================================
  // sendInput (sendMessage)
  // =========================================================================

  describe('sendInput', () => {
    it('throws for non-existent instance', async () => {
      await expect(
        manager.sendInput('non-existent-id', 'hello')
      ).rejects.toThrow('Instance non-existent-id not found');
    });

    it('increments requestCount on the instance', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Message Test',
      });

      expect(instance.requestCount).toBe(0);

      await manager.sendInput(instance.id, 'hello world');

      const updated = manager.getInstance(instance.id);
      expect(updated?.requestCount).toBe(1);
    });

    it('updates lastActivity timestamp', async () => {
      const before = Date.now();

      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Activity Test',
      });

      await manager.sendInput(instance.id, 'test message');

      const updated = manager.getInstance(instance.id);
      expect(updated?.lastActivity).toBeGreaterThanOrEqual(before);
    });

    it('records sent prompts in main-process prompt history', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Prompt History Test',
      });

      await manager.sendInput(instance.id, 'remember this normal prompt');

      expect(mockPromptHistoryRecord).toHaveBeenCalledWith(expect.objectContaining({
        instanceId: instance.id,
        text: 'remember this normal prompt',
        projectPath: TEST_WORKING_DIR,
        provider: 'claude',
        model: 'opus',
        wasSlashCommand: false,
      }));
    });

    it('emits provider:normalized-event for the user message', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Output Event Test',
      });

      const outputEvents: unknown[] = [];
      manager.on('provider:normalized-event', (payload) => outputEvents.push(payload));

      await manager.sendInput(instance.id, 'user message text');

      const userOutputs = (
        outputEvents as {
          instanceId: string;
          event: { kind: string; messageType?: string; content?: string };
        }[]
      ).filter(
        (event) =>
          event.instanceId === instance.id &&
          event.event.kind === 'output' &&
          event.event.messageType === 'user' &&
          event.event.content === 'user message text',
      );
      expect(userOutputs.length).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // getAllInstances
  // =========================================================================

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

  // =========================================================================
  // Event forwarding
  // =========================================================================

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

  // =========================================================================
  // destroy
  // =========================================================================

  describe('destroy', () => {
    it('calls stopTimeoutChecker on the task manager', () => {
      manager.destroy();
      expect(mockTaskManager.stopTimeoutChecker).toHaveBeenCalled();
    });
  });

  describe('changeModel', () => {
    it('reseeds context totals when switching to a 1M Claude model', async () => {
      const instance = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        modelOverride: 'sonnet',
      });

      expect(instance.contextUsage.total).toBe(1000000);

      const updated = await manager.changeModel(instance.id, 'sonnet[1m]');

      expect(updated.currentModel).toBe('sonnet[1m]');
      expect(updated.contextUsage.total).toBe(1000000);
    });
  });

  // =========================================================================
  // handleChildExit auto-capture (Bug fix: echo-back from seeded parent context)
  // =========================================================================

  describe('handleChildExit auto-capture', () => {
    /**
     * Regression test for the "echo-back" bug:
     *
     * When a child instance is spawned, its outputBuffer is pre-seeded with a
     * slice of the parent's recent messages so the child has context. If the
     * child terminates without producing any output, the auto-capture logic in
     * handleChildExit would previously pick up the LAST assistant message from
     * the buffer — which would be one of the PARENT's messages we copied in —
     * and store it as the child's "result". That manifested in the UI as the
     * child appearing to succeed while echoing back the parent's prior text.
     *
     * Fix: seeded messages are tagged `metadata.seededFromParent = true`, and
     * the auto-capture code skips them when finding the child's last assistant
     * message.
     */
    it('skips seeded parent messages and stores a "no output" summary instead of echoing them back', async () => {
      const parent = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Parent (echo-back regression)',
      });

      const child = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Child (echo-back regression)',
        parentId: parent.id,
      });

      // Replace child's outputBuffer with seeded parent messages ONLY — i.e.
      // the child never produced any of its own output before exiting.
      const seededParentText = 'PARENT_PRIOR_TEXT_THAT_MUST_NOT_ECHO_BACK';
      child.outputBuffer.length = 0;
      child.outputBuffer.push({
        id: 'seeded-1',
        timestamp: Date.now() - 1000,
        type: 'assistant',
        content: seededParentText,
        metadata: { seededFromParent: true },
      });

      mockChildResultStorage.hasResult.mockReturnValueOnce(false);
      mockChildResultStorage.storeFromOutputBuffer.mockClear();

      // Invoke the private handler directly. Cast to access private method.
      await (manager as unknown as {
        handleChildExit: (id: string, c: typeof child, code: number | null) => Promise<void>;
      }).handleChildExit(child.id, child, 0);

      expect(mockChildResultStorage.storeFromOutputBuffer).toHaveBeenCalledTimes(1);

      const callArgs = mockChildResultStorage.storeFromOutputBuffer.mock.calls[0];
      // storeFromOutputBuffer signature:
      //   (childId, parentId, taskDescription, summary, success, outputBuffer, createdAt)
      const [storedChildId, storedParentId, , storedSummary, storedSuccess] = callArgs;

      expect(storedChildId).toBe(child.id);
      expect(storedParentId).toBe(parent.id);

      // The summary MUST NOT be the seeded parent text (no echo-back).
      expect(storedSummary).not.toContain(seededParentText);

      // The summary should describe that the child produced no output.
      expect(storedSummary).toBe('Child exited without producing any output.');

      // success must be false because the child produced no output of its own,
      // even though exitCode === 0 (terminate(graceful) emits exit 0).
      expect(storedSuccess).toBe(false);
    });

    it('captures the child\'s own last assistant message when one exists', async () => {
      const parent = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Parent (real result)',
      });

      const child = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Child (real result)',
        parentId: parent.id,
      });

      const childOwnResult = 'CHILD_ACTUAL_REPORTED_RESULT';
      child.outputBuffer.length = 0;
      child.outputBuffer.push(
        {
          id: 'seeded-1',
          timestamp: Date.now() - 2000,
          type: 'assistant',
          content: 'PARENT_PRIOR_TEXT_FROM_SEED',
          metadata: { seededFromParent: true },
        },
        {
          id: 'child-own-1',
          timestamp: Date.now(),
          type: 'assistant',
          content: childOwnResult,
        },
      );

      mockChildResultStorage.hasResult.mockReturnValueOnce(false);
      mockChildResultStorage.storeFromOutputBuffer.mockClear();

      await (manager as unknown as {
        handleChildExit: (id: string, c: typeof child, code: number | null) => Promise<void>;
      }).handleChildExit(child.id, child, 0);

      expect(mockChildResultStorage.storeFromOutputBuffer).toHaveBeenCalledTimes(1);

      const callArgs = mockChildResultStorage.storeFromOutputBuffer.mock.calls[0];
      const [, , , storedSummary, storedSuccess] = callArgs;

      expect(storedSummary).toBe(childOwnResult);
      expect(storedSuccess).toBe(true);
    });

    it('still persists a summary when the child exits with an empty buffer (no "No summary available" later)', async () => {
      const parent = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Parent (empty buffer)',
      });

      const child = await manager.createInstance({
        workingDirectory: TEST_WORKING_DIR,
        displayName: 'Child (empty buffer)',
        parentId: parent.id,
      });

      // Force the child's buffer to be empty (simulates the case where remote
      // node failed to propagate any output messages to the orchestrator).
      child.outputBuffer.length = 0;

      mockChildResultStorage.hasResult.mockReturnValueOnce(false);
      mockChildResultStorage.storeFromOutputBuffer.mockClear();

      await (manager as unknown as {
        handleChildExit: (id: string, c: typeof child, code: number | null) => Promise<void>;
      }).handleChildExit(child.id, child, 0);

      // Previously gated by `child.outputBuffer.length > 0` — now always called.
      expect(mockChildResultStorage.storeFromOutputBuffer).toHaveBeenCalledTimes(1);

      const callArgs = mockChildResultStorage.storeFromOutputBuffer.mock.calls[0];
      const [, , , storedSummary, storedSuccess] = callArgs;

      expect(storedSummary).toBe('Child exited without producing any output.');
      expect(storedSuccess).toBe(false);
    });
  });
});
