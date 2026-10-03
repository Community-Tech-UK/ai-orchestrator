/**
 * Spawn-as-transaction rollback integration tests (pi-borrowed-capabilities Task 8).
 *
 * Exercises the REAL InstanceLifecycleManager.createInstance() against a mocked
 * environment and injects failures at each resource-acquisition point:
 *
 *   1. RLM init failure          → published session KEPT in `error` with a
 *      notice (instance store, output storage, state machine, parent-child
 *      link, supervisor tree, orchestration registry all retained so the
 *      session does not vanish; termination cleans them up later)
 *   2. adapter.spawn() failure   → same record retention, while runtime
 *      resources roll back: RLM session and adapter registration (listeners
 *      removed, adapter deleted, process terminated). Unpublished recovery
 *      creations still roll back completely.
 *   3. initial-prompt send fail  → session PRESERVED after a successful spawn
 *      (the CLI is already live; a failed first turn must not delete the
 *       session — it settles to idle with a notice so the user can resend)
 *   4. success                   → commit; nothing is torn down
 */
import { vi } from 'vitest';
import type { Instance, InstanceCreateConfig } from '../../../shared/types/instance.types';
import type { ExecutionLocation } from '../../../shared/types/worker-node.types';
import type { SessionState } from '../../session/session-continuity.types';
import type { LifecycleDependencies } from '../instance-lifecycle.types';
import type { InstanceStateMachine } from '../instance-state-machine';

const mocks = vi.hoisted(() => ({
  logManager: null as import('../../logging/logger').LogManager | null,
  resolveAgent: vi.fn(),
  loadProjectRules: vi.fn(),
  supervisorRegister: vi.fn(() => ({ supervisorNodeId: 'sup-1', workerNodeId: 'worker-1' })),
  supervisorUnregister: vi.fn(),
  outputStorageDelete: vi.fn().mockResolvedValue(undefined),
  createAdapter: vi.fn(),
  resolveCliType: vi.fn().mockResolvedValue('claude'),
  promptHistoryRecord: vi.fn(),
  promptHistoryClear: vi.fn(),
  maybeGenerateTitle: vi.fn().mockResolvedValue(undefined),
  clearAutoTitleInstance: vi.fn(),
  localModelInventory: [] as unknown[],
  localModelRefresh: vi.fn(),
  getProviderCapabilities: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  archiveInstance: vi.fn(),
  continuityStartTracking: vi.fn().mockResolvedValue(undefined),
  continuityStopTracking: vi.fn().mockResolvedValue(undefined),
  continuityResumeSession: vi.fn<() => Promise<SessionState | null>>().mockResolvedValue(null),
  continuityMarkNativeResumeFailed: vi.fn().mockResolvedValue(undefined),
  continuityUpdateState: vi.fn().mockResolvedValue(undefined),
  evaluateResumeHealth: vi.fn().mockResolvedValue('healthy'),
  resolveExecutionLocation: vi.fn<(config: InstanceCreateConfig) => ExecutionLocation>(
    () => ({ type: 'local' }),
  ),
  getKnownModelsForCli: vi.fn().mockResolvedValue([]),
  settings: {
    defaultYoloMode: false,
    defaultCli: 'claude',
    outputStyle: 'default',
    injectRepoMap: false,
    residentClaudeSession: true,
    defaultModel: undefined as string | undefined,
    defaultModelByProvider: {} as Record<string, string>,
  },
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/aio-test', isPackaged: false },
}));

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({ get: vi.fn(), set: vi.fn(), store: {} })),
}));

vi.mock('../../logging/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../logging/logger')>();
  const manager = new actual.LogManager({ enableConsole: false, enableFile: false, globalLevel: 'debug' });
  mocks.logManager = manager;
  return { ...actual, getLogger: (subsystem: string) => manager.getLogger(subsystem) };
});

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({ ...mocks.settings }),
    get: vi.fn(),
    on: vi.fn(),
  }),
}));

vi.mock('../../memory', () => ({
  getOutputStorageManager: () => ({
    deleteInstance: mocks.outputStorageDelete,
    loadMessages: vi.fn().mockResolvedValue([]),
    getTotalStats: vi.fn(() => ({})),
  }),
  getMemoryMonitor: () => ({ on: vi.fn(), start: vi.fn(), stop: vi.fn() }),
  getUnifiedMemory: () => ({}),
}));

vi.mock('../../memory/output-storage', () => ({
  getOutputStorageManager: () => ({
    deleteInstance: mocks.outputStorageDelete,
    loadMessages: vi.fn().mockResolvedValue([]),
    getTotalStats: vi.fn(() => ({})),
  }),
}));

vi.mock('../../process', () => ({
  getSupervisorTree: () => ({
    registerInstance: mocks.supervisorRegister,
    unregisterInstance: mocks.supervisorUnregister,
  }),
}));

vi.mock('../../process/hibernation-manager', () => ({
  getHibernationManager: () => ({ markHibernated: vi.fn(), markAwoken: vi.fn() }),
}));

vi.mock('../../history', () => ({
  getHistoryManager: () => ({ archiveInstance: mocks.archiveInstance }),
}));

vi.mock('../../agents/agent-registry', () => ({
  getAgentRegistry: () => ({ resolveAgent: mocks.resolveAgent }),
}));

vi.mock('../../security/permission-manager', () => ({
  getPermissionManager: () => ({ loadProjectRules: mocks.loadProjectRules }),
}));

vi.mock('../../core/config/instruction-resolver', () => ({
  resolveInstructionStack: vi.fn().mockResolvedValue({ sources: [], mergedContent: null }),
}));

vi.mock('../context-worker-client', () => ({
  getContextWorkerClient: () => ({
    buildProjectMemoryBrief: vi.fn().mockResolvedValue({
      text: '',
      stats: { projectKey: 'test', candidatesScanned: 0, candidatesIncluded: 0, truncated: false },
      sources: [],
    }),
  }),
}));

vi.mock('../../memory/project-memory-brief', () => ({
  getProjectMemoryBriefService: () => ({ buildBrief: vi.fn() }),
}));

vi.mock('../../memory/project-story-convention', () => ({
  extractAuthoredLessons: vi.fn(() => null),
}));

vi.mock('../../memory/project-knowledge-coordinator', () => ({
  getProjectKnowledgeCoordinator: () => ({
    ensureProjectKnown: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../memory/conversation-miner', () => ({
  getConversationMiner: () => ({ importFromString: vi.fn() }),
}));

vi.mock('../../mcp/mcp-manager', () => ({
  getMcpManager: () => ({
    exportRuntimeToolContextSnapshot: vi.fn(() => ({ servers: [], tools: [] })),
    hydrateRuntimeToolContextSelection: vi.fn(),
    formatRuntimeToolContext: vi.fn(),
  }),
}));

vi.mock('../../indexing/indexed-codebase-context', () => ({
  getIndexedCodebaseContextService: () => ({
    buildContext: vi.fn().mockResolvedValue(null),
    formatContextBlock: vi.fn(() => null),
  }),
}));

vi.mock('../../cli/adapters/adapter-factory', () => ({
  resolveCliType: mocks.resolveCliType,
  getCliDisplayName: vi.fn(() => 'Claude'),
}));

vi.mock('../lifecycle/create-validation-helpers', () => ({
  getKnownModelsForCli: mocks.getKnownModelsForCli,
  isRestoreOrReplayContinuity: vi.fn(() => false),
  requiresFreshConfiguredModelSpawn: vi.fn(() => false),
}));

vi.mock('../lifecycle/execution-location-resolver', () => ({
  resolveExecutionLocation: mocks.resolveExecutionLocation,
}));

vi.mock('../../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: () => ({
    createAdapter: mocks.createAdapter,
    getCapabilities: mocks.getProviderCapabilities,
    getRuntimeSnapshot: () => undefined,
  }),
}));

vi.mock('../../providers/activity-state-detector', () => ({
  ActivityStateDetector: class {
    setPid(): void { /* stub */ }
  },
}));

vi.mock('../../prompt-history/prompt-history-service', () => ({
  getPromptHistoryService: () => ({
    record: mocks.promptHistoryRecord,
    clearForInstance: mocks.promptHistoryClear,
  }),
}));

vi.mock('../auto-title-service', () => ({
  getAutoTitleService: () => ({
    maybeGenerateTitle: mocks.maybeGenerateTitle,
    clearInstance: mocks.clearAutoTitleInstance,
  }),
}));

vi.mock('../../observability/lifecycle-trace', () => ({
  recordLifecycleTrace: vi.fn(),
}));

vi.mock('../../local-models/local-model-inventory-service', () => ({
  getLocalModelInventoryService: () => ({
    list: () => mocks.localModelInventory,
    refresh: mocks.localModelRefresh,
  }),
}));

vi.mock('../warm-codemem', () => ({
  warmCodememWithTimeout: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../codemem', () => ({
  getCodemem: () => ({}),
}));

vi.mock('../../session/session-mutex', () => ({
  getSessionMutex: () => ({
    acquire: vi.fn().mockResolvedValue(() => undefined),
    forceRelease: vi.fn(),
  }),
}));

vi.mock('../../session/session-continuity', () => ({
  getSessionContinuityManager: () => ({
    startTracking: mocks.continuityStartTracking,
    stopTracking: mocks.continuityStopTracking,
    updateState: mocks.continuityUpdateState,
    resumeSession: mocks.continuityResumeSession,
    markNativeResumeFailed: mocks.continuityMarkNativeResumeFailed,
    writeThroughIdentityLocked: vi.fn(),
  }),
}));

vi.mock('../../session/checkpoint-manager', () => ({
  getCheckpointManager: () => ({}),
}));

vi.mock('../../cli/hooks/defer-decision-store', () => ({
  getDeferDecisionStore: () => ({
    writeDecision: vi.fn(),
    getDecisionDir: () => '/tmp/aio-test/decisions',
  }),
}));

vi.mock('../../context/compaction-coordinator', () => ({
  getCompactionCoordinator: () => ({ resetBudgetTracker: vi.fn() }),
}));

vi.mock('../lifecycle/spawn-config-builder', () => ({
  SpawnConfigBuilder: class {
    getMcpConfig(): string[] { return []; }
    getChromeDevtoolsMcpOptions(): null { return null; }
    getBrowserGatewayMcpOptions(): null { return null; }
    getHarnessCliEnv(): undefined { return undefined; }
    getPermissionHookPath(): undefined { return undefined; }
    getRtkSpawnConfig(): undefined { return undefined; }
  },
}));

vi.mock('../lifecycle/runtime-readiness', () => ({
  RuntimeReadinessCoordinator: class {
    getAdapterRuntimeCapabilities(): { supportsResume: boolean; supportsForkSession: boolean } {
      return { supportsResume: false, supportsForkSession: false };
    }
    waitForResumeHealth(): Promise<boolean> { return Promise.resolve(true); }
    evaluateResumeHealth(): Promise<'healthy' | 'unrecoverable'> {
      return mocks.evaluateResumeHealth();
    }
    waitForAdapterWritable(): Promise<boolean> { return Promise.resolve(true); }
    waitForInputReadinessBoundary(): Promise<void> { return Promise.resolve(); }
  },
}));

vi.mock('../lifecycle/idle-monitor', () => ({
  IdleMonitor: class {
    start(): void { /* stub */ }
    stop(): void { /* stub */ }
    terminateIdleHalf(): Promise<void> { return Promise.resolve(); }
  },
}));

vi.mock('../lifecycle/memory-pressure-monitor', () => ({
  LifecycleMemoryPressureMonitor: class {
    start(): void { /* stub */ }
    stop(): void { /* stub */ }
    getStats(): Record<string, unknown> { return {}; }
  },
}));

import { InstanceLifecycleManager } from '../instance-lifecycle';

interface FakeAdapter {
  spawn: ReturnType<typeof vi.fn>;
  sendInput: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  getName: () => string;
  getRuntimeCapabilities: () => {
    supportsResume: boolean;
    supportsForkSession: boolean;
    supportsNativeCompaction: boolean;
    supportsPermissionPrompts: boolean;
    supportsDeferPermission: boolean;
    selfManagedAutoCompaction: boolean;
  };
  on: ReturnType<typeof vi.fn>;
}

export function makeFakeAdapter(): FakeAdapter {
  return {
    spawn: vi.fn().mockResolvedValue(4242),
    sendInput: vi.fn().mockResolvedValue(undefined),
    terminate: vi.fn().mockResolvedValue(undefined),
    removeAllListeners: vi.fn(),
    getName: () => 'claude',
    getRuntimeCapabilities: () => ({
      supportsResume: true,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
      selfManagedAutoCompaction: false,
    }),
    on: vi.fn(),
  };
}

interface Harness {
  manager: InstanceLifecycleManager;
  deps: LifecycleDependencies;
  instances: Map<string, Instance>;
  pendingInstances: Map<string, Instance>;
  adapters: Map<string, unknown>;
  stateMachines: Map<string, InstanceStateMachine>;
  removedEvents: string[];
  initializeRlm: ReturnType<typeof vi.fn>;
  endRlmSession: ReturnType<typeof vi.fn>;
  unregisterOrchestration: ReturnType<typeof vi.fn>;
  setupAdapterEvents: ReturnType<typeof vi.fn>;
  deleteDiffTracker: ReturnType<typeof vi.fn>;
}

export function makeHarness(): Harness {
  const instances = new Map<string, Instance>();
  const pendingInstances = new Map<string, Instance>();
  const adapters = new Map<string, unknown>();
  const stateMachines = new Map<string, InstanceStateMachine>();

  const initializeRlm = vi.fn().mockResolvedValue(undefined);
  const endRlmSession = vi.fn();
  const unregisterOrchestration = vi.fn();
  const setupAdapterEvents = vi.fn();
  const deleteDiffTracker = vi.fn();

  const deps = {
    getInstance: (id: string) => instances.get(id) ?? pendingInstances.get(id),
    setInstance: (instance: Instance) => { instances.set(instance.id, instance); },
    setPendingInstance: (instance: Instance) => { pendingInstances.set(instance.id, instance); },
    publishPendingInstance: (id: string) => {
      const instance = pendingInstances.get(id);
      if (!instance) throw new Error('fixture pending instance missing');
      pendingInstances.delete(id);
      instances.set(id, instance);
      return instance;
    },
    deleteInstance: (id: string) => instances.delete(id) || pendingInstances.delete(id),
    deleteRuntimeInstance: (id: string) => instances.delete(id) || pendingInstances.delete(id),
    isInstancePublished: (id: string) => instances.has(id),
    getAdapter: (id: string) => adapters.get(id),
    setAdapter: (id: string, adapter: unknown) => { adapters.set(id, adapter); },
    deleteAdapter: (id: string) => adapters.delete(id),
    getInstanceCount: () => instances.size,
    forEachInstance: (cb: (instance: Instance, id: string) => void) => {
      instances.forEach(cb);
    },
    queueUpdate: vi.fn(),
    serializeForIpc: (instance: Instance) => ({ id: instance.id }),
    setupAdapterEvents,
    initializeRlm,
    endRlmSession,
    ingestInitialOutputToRlm: vi.fn().mockResolvedValue(undefined),
    buildObservationContext: vi.fn().mockResolvedValue(''),
    buildWakeContextText: vi.fn().mockResolvedValue(null),
    buildMcpRuntimeToolContextSelection: vi.fn().mockResolvedValue(null),
    registerOrchestration: vi.fn(),
    unregisterOrchestration,
    markInterrupted: vi.fn(),
    clearInterrupted: vi.fn(),
    addToOutputBuffer: (instance: Instance, message: { id: string }) => {
      instance.outputBuffer.push(message as Instance['outputBuffer'][number]);
    },
    clearFirstMessageTracking: vi.fn(),
    markFirstMessageReceived: vi.fn(),
    deleteDiffTracker,
    getStateMachine: (id: string) => stateMachines.get(id),
    setStateMachine: (id: string, machine: InstanceStateMachine) => {
      stateMachines.set(id, machine);
    },
    deleteStateMachine: (id: string) => { stateMachines.delete(id); },
  } as unknown as LifecycleDependencies;

  const manager = new InstanceLifecycleManager(deps);
  const removedEvents: string[] = [];
  manager.on('removed', (id: string) => removedEvents.push(id));

  return {
    manager,
    deps,
    instances,
    pendingInstances,
    adapters,
    stateMachines,
    removedEvents,
    initializeRlm,
    endRlmSession,
    unregisterOrchestration,
    setupAdapterEvents,
    deleteDiffTracker,
  };
}


export function getMocks(): typeof mocks { return mocks; }
