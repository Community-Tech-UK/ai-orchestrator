/**
 * Tests that InstanceManager re-emits 'provider:normalized-event' from its
 * internal InstanceCommunicationManager onto itself, so main/index.ts can
 * forward those envelopes to the renderer via IPC (wave2-task19-minimal).
 *
 * Uses the same vi.mock() approach as instance-manager.spec.ts.
 * vi.mock() paths are relative to THIS file:
 *   src/main/instance/__tests__/instance-manager.normalized-event.spec.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';

// ---------------------------------------------------------------------------
// Fake communication manager — returned by the mocked constructor.
// Captured at module scope so tests can emit events on it.
// ---------------------------------------------------------------------------
let fakeCommunication: EventEmitter;
let capturedCommunicationDeps: Record<string, unknown> | undefined;

vi.mock('../instance-communication', () => {
  return {
    InstanceCommunicationManager: vi.fn().mockImplementation((deps: Record<string, unknown>) => {
      capturedCommunicationDeps = deps;
      fakeCommunication = new EventEmitter();
      // Minimal surface expected by InstanceManager
      (fakeCommunication as EventEmitter & Record<string, unknown>).addToOutputBuffer = vi.fn();
      (fakeCommunication as EventEmitter & Record<string, unknown>).setupInputHandling = vi.fn();
      return fakeCommunication;
    }),
  };
});

// ---------------------------------------------------------------------------
// All the other mocks required to get through InstanceManager's constructor.
// Copied / condensed from instance-manager.spec.ts.
// ---------------------------------------------------------------------------

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

vi.mock('electron-store', () => ({
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
    get: vi.fn(),
    set: vi.fn(),
    clear: vi.fn(),
  })),
}));

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: vi.fn(() => ({
    getAll: vi.fn(() => ({
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
    })),
    get: vi.fn(),
    on: vi.fn(),
    emit: vi.fn(),
  })),
  SettingsManager: vi.fn().mockImplementation(() => ({
    getAll: vi.fn(() => ({})),
    get: vi.fn(),
    on: vi.fn(),
  })),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
  getLogManager: vi.fn(() => ({
    getLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  })),
}));

function makeMockAdapter() {
  const adapter = new EventEmitter() as EventEmitter & {
    spawn: () => Promise<number>;
    sendInput: () => Promise<void>;
    terminate: () => Promise<void>;
    isRunning: () => boolean;
  };
  adapter.spawn = vi.fn().mockResolvedValue(12345);
  adapter.sendInput = vi.fn().mockResolvedValue(undefined);
  adapter.terminate = vi.fn().mockResolvedValue(undefined);
  adapter.isRunning = vi.fn().mockReturnValue(true);
  return adapter;
}

vi.mock('../../cli/adapters/adapter-factory', () => ({
  createCliAdapter: vi.fn(() => makeMockAdapter()),
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
    maybeGenerateTitle: vi.fn().mockResolvedValue(undefined),
    clearInstance: vi.fn(),
  })),
}));

vi.mock('../../cli/cli-detection', () => ({
  CliDetectionService: {
    getInstance: vi.fn().mockReturnValue({
      detectAll: vi.fn().mockResolvedValue({ available: [] }),
      detectCli: vi.fn().mockResolvedValue({ name: 'claude', version: '2.0.0' }),
    }),
  },
}));

vi.mock('../../process', () => ({
  getSupervisorTree: vi.fn(() => ({
    registerInstance: vi.fn().mockReturnValue({ supervisorNodeId: 's1', workerNodeId: 'w1' }),
    unregisterInstance: vi.fn(),
    terminate: vi.fn(),
  })),
}));

vi.mock('../../process/supervisor-tree', () => ({
  getSupervisorTree: vi.fn(() => ({
    registerInstance: vi.fn().mockReturnValue({ supervisorNodeId: 's1', workerNodeId: 'w1' }),
    unregisterInstance: vi.fn(),
    terminate: vi.fn(),
  })),
  SupervisorTree: {
    getInstance: vi.fn(() => ({
      registerInstance: vi.fn().mockReturnValue({ supervisorNodeId: 's1', workerNodeId: 'w1' }),
      unregisterInstance: vi.fn(),
    })),
    _resetForTesting: vi.fn(),
  },
}));

vi.mock('../../agents/agent-registry', () => ({
  getAgentRegistry: vi.fn(() => ({ resolveAgent: vi.fn() })),
}));

vi.mock('../../../shared/types/agent.types', () => ({
  getDefaultAgent: vi.fn(() => ({ id: 'build', name: 'Build', mode: 'build' })),
  getAgentById: vi.fn(() => ({ id: 'build', name: 'Build', mode: 'build' })),
}));

vi.mock('../../security/permission-manager', () => ({
  getPermissionManager: vi.fn(() => ({
    loadProjectRules: vi.fn(),
    checkPermission: vi.fn().mockReturnValue({ action: 'prompt' }),
    recordUserDecision: vi.fn(),
  })),
}));

vi.mock('../../../shared/utils/permission-mapper', () => ({
  getDisallowedTools: vi.fn().mockReturnValue([]),
}));

vi.mock('../../orchestration/orchestration-protocol', () => ({
  generateChildPrompt: vi.fn().mockReturnValue('child prompt'),
  generateOrchestrationPrompt: vi.fn().mockReturnValue('[ORCHESTRATION SYSTEM PROMPT]'),
  formatCommandResponse: vi.fn(() => '[Orchestrator Response]'),
}));

vi.mock('../../commands/command-manager', () => ({
  getCommandManager: vi.fn(() => ({ getCommandByName: vi.fn().mockReturnValue(null) })),
}));

vi.mock('../../commands/markdown-command-registry', () => ({
  getMarkdownCommandRegistry: vi.fn(() => ({ getCommand: vi.fn().mockResolvedValue(null) })),
}));

vi.mock('../../orchestration/task-manager', () => ({
  getTaskManager: vi.fn(() => ({
    startTimeoutChecker: vi.fn(),
    stopTimeoutChecker: vi.fn(),
    getTaskByChildId: vi.fn().mockReturnValue(null),
    cleanupChildTasks: vi.fn(),
  })),
}));

vi.mock('../../orchestration/child-result-storage', () => ({
  getChildResultStorage: vi.fn(() => ({
    hasResult: vi.fn().mockReturnValue(false),
    storeFromOutputBuffer: vi.fn().mockResolvedValue(undefined),
    getChildSummary: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock('../../routing', () => ({
  getModelRouter: vi.fn(() => ({
    route: vi.fn().mockReturnValue({ model: 'claude-sonnet', provider: 'claude' }),
  })),
}));

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
  Object.assign(RLMContextManagerMock, { getInstance: vi.fn().mockReturnValue(rlmInstance) });
  return { RLMContextManager: RLMContextManagerMock };
});

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

vi.mock('../../persistence/output-storage', () => ({
  getOutputStorageManager: vi.fn(() => ({
    appendMessages: vi.fn().mockResolvedValue(undefined),
    loadMessages: vi.fn().mockResolvedValue([]),
    getInstanceStats: vi.fn().mockReturnValue({ totalMessages: 0 }),
    getTotalStats: vi.fn().mockReturnValue({ totalMessages: 0, totalSizeMB: 0 }),
    deleteInstance: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../memory/output-storage', () => ({
  getOutputStorageManager: vi.fn(() => ({
    appendMessages: vi.fn().mockResolvedValue(undefined),
    loadMessages: vi.fn().mockResolvedValue([]),
    getInstanceStats: vi.fn().mockReturnValue({ totalMessages: 0 }),
    getTotalStats: vi.fn().mockReturnValue({ totalMessages: 0, totalSizeMB: 0 }),
    deleteInstance: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../history', () => ({
  getHistoryManager: vi.fn(() => ({ archiveInstance: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock('../../observation/policy-adapter', () => ({
  getPolicyAdapter: vi.fn(() => ({
    buildObservationContext: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock('../../memory/wake-context-builder', () => ({
  getWakeContextBuilder: vi.fn(() => ({ getWakeUpText: vi.fn(() => '') })),
}));

vi.mock('../../memory/codebase-miner', () => ({
  getCodebaseMiner: vi.fn(() => ({ mineDirectory: vi.fn().mockResolvedValue(undefined) })),
}));

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
    FileSystemLoader: vi.fn().mockImplementation(() => ({ load: vi.fn().mockResolvedValue(null) })),
    MemoryStoreLoader: vi.fn().mockImplementation(() => ({ load: vi.fn().mockResolvedValue(null) })),
  };
});

vi.mock('../../hooks/hook-manager', () => ({
  getHookManager: vi.fn(() => ({ executeHook: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock('../../core/error-recovery', () => ({
  getErrorRecoveryManager: vi.fn(() => ({ handleError: vi.fn() })),
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

vi.mock('../../../shared/types/provider.types', () => ({
  getModelsForProvider: vi.fn().mockReturnValue([]),
  getProviderModelContextWindow: vi.fn(() => 200000),
  isModelTier: vi.fn().mockReturnValue(false),
  looksLikeCodexModelId: vi.fn().mockReturnValue(false),
  resolveModelForTier: vi.fn().mockReturnValue(undefined),
  MODEL_PRICING: {},
}));

vi.mock('../../../shared/types/supervision.types', () => ({
  createDefaultContextInheritance: vi.fn().mockReturnValue({
    inheritWorkingDirectory: true,
    inheritYoloMode: false,
    inheritAgentSettings: false,
  }),
}));

vi.mock('../../../shared/constants/limits', () => ({
  LIMITS: {
    OUTPUT_BATCH_INTERVAL_MS: 100,
    OUTPUT_BUFFER_MAX_SIZE: 500,
    DEFAULT_MAX_CONTEXT_TOKENS: 1000000,
  },
}));

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

vi.mock('../../../shared/types/command.types', () => ({
  parseCommandString: vi.fn().mockReturnValue(null),
  resolveTemplate: vi.fn((t: string) => t),
}));

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
// Import after all mocks are defined
// ---------------------------------------------------------------------------
import { InstanceManager } from '../instance-manager';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InstanceManager provider:normalized-event emission', () => {
  beforeEach(() => {
    idCounter = 0;
    capturedCommunicationDeps = undefined;
  });

  it('publishes provider runtime envelopes through the manager sequencer', () => {
    const manager = new InstanceManager();

    const envelope: ProviderRuntimeEventEnvelope = {
      eventId: 'a1b2c3d4-e5f6-4890-abcd-ef0123456789',
      seq: 0,
      timestamp: Date.now(),
      provider: 'claude',
      instanceId: 'inst-1',
      event: { kind: 'output', content: 'hello' },
    };

    const received: ProviderRuntimeEventEnvelope[] = [];
    manager.on('provider:normalized-event', (env) => received.push(env));

    const emitProviderRuntimeEvent = capturedCommunicationDeps?.['emitProviderRuntimeEvent'];
    expect(typeof emitProviderRuntimeEvent).toBe('function');
    (emitProviderRuntimeEvent as (
      instanceId: string,
      event: ProviderRuntimeEventEnvelope['event'],
      options?: { provider?: ProviderRuntimeEventEnvelope['provider'] },
    ) => void)('inst-1', envelope.event, { provider: 'claude' });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      provider: 'claude',
      instanceId: 'inst-1',
      event: envelope.event,
      seq: 0,
    });
  });
});
