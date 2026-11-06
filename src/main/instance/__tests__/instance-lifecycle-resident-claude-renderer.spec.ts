/**
 * `residentClaude` reaches the renderer for a session created in this run.
 *
 * Plan 14d item 5: the pre-click switch note is computed in the renderer from
 * `instance.residentClaude`. The lifecycle sets that flag in the background
 * init, AFTER the early `created` event, so the created payload cannot carry
 * it. It therefore has to travel on the state updates that follow, the same
 * way `selfManagesAutoCompaction` does.
 *
 * Runs the REAL `InstanceLifecycleManager.createInstance()` against the REAL
 * `InstanceStateManager` and reads what the renderer would actually receive
 * (the `created` payload, then the `batch-update` payloads). Mock preamble is
 * the one in instance-lifecycle-spawn-rollback.spec.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, InstanceCreateConfig } from '../../../shared/types/instance.types';
import type { ExecutionLocation } from '../../../shared/types/worker-node.types';
import type { SessionState } from '../../session/session-continuity.types';
import type { LifecycleDependencies } from '../instance-lifecycle.types';

const mocks = vi.hoisted(() => ({
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

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    error: mocks.loggerError,
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
  }),
}));

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

// Pass-through spies: the real account routing runs, and its requests are visible.
const accountRouteCalls = vi.hoisted(() => [] as { origin: unknown; options: Record<string, unknown> }[]);
vi.mock('../lifecycle/account-route-preflight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lifecycle/account-route-preflight')>();
  return {
    ...actual,
    attachAccountRoute: (...args: Parameters<typeof actual.attachAccountRoute>) => {
      accountRouteCalls.push({ origin: args[2], options: { ...args[3] } });
      return actual.attachAccountRoute(...args);
    },
  };
});

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
import { InstanceStateManager } from '../instance-state';
import { getDefaultAgent } from '../../../shared/types/agent.types';
import { InstanceBatchUpdateEventPayloadSchema } from '@contracts/schemas/instance';
import type { BatchUpdatePayload } from '../../../shared/types/ipc.types';

function makeFakeAdapter() {
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
      selfManagedAutoCompaction: true,
    }),
    on: vi.fn(),
  };
}

/** Lifecycle wired to the real state manager: what it queues is what the renderer gets. */
function makeHarness() {
  const state = new InstanceStateManager();
  const deps = {
    getInstance: (id: string) => state.getRuntimeInstance(id),
    setInstance: (instance: Instance) => state.setInstance(instance),
    setPendingInstance: (instance: Instance) => state.setPendingInstance(instance),
    publishPendingInstance: (id: string) => state.publishPendingInstance(id),
    deleteInstance: (id: string) => state.deleteInstance(id),
    deleteRuntimeInstance: (id: string) => state.deleteRuntimeInstance(id),
    isInstancePublished: (id: string) => state.isInstancePublished(id),
    getAdapter: (id: string) => state.getAdapter(id),
    setAdapter: (id: string, adapter: unknown) => state.setAdapter(id, adapter as never),
    deleteAdapter: (id: string) => state.deleteAdapter(id),
    getInstanceCount: () => state.getInstanceCount(),
    forEachInstance: (cb: (instance: Instance, id: string) => void) => state.forEachInstance(cb),
    queueUpdate: (...args: Parameters<InstanceStateManager['queueUpdate']>) => state.queueUpdate(...args),
    serializeForIpc: (instance: Instance) => state.serializeForIpc(instance),
    setupAdapterEvents: vi.fn(),
    initializeRlm: vi.fn().mockResolvedValue(undefined),
    endRlmSession: vi.fn(),
    ingestInitialOutputToRlm: vi.fn().mockResolvedValue(undefined),
    buildObservationContext: vi.fn().mockResolvedValue(''),
    buildWakeContextText: vi.fn().mockResolvedValue(null),
    buildMcpRuntimeToolContextSelection: vi.fn().mockResolvedValue(null),
    registerOrchestration: vi.fn(),
    unregisterOrchestration: vi.fn(),
    markInterrupted: vi.fn(),
    clearInterrupted: vi.fn(),
    addToOutputBuffer: (instance: Instance, message: { id: string }) => {
      instance.outputBuffer.push(message as Instance['outputBuffer'][number]);
    },
    clearFirstMessageTracking: vi.fn(),
    markFirstMessageReceived: vi.fn(),
    deleteDiffTracker: (id: string) => state.deleteDiffTracker(id),
    getStateMachine: (id: string) => state.getStateMachine(id),
    setStateMachine: (id: string, machine: never) => state.setStateMachine(id, machine),
    deleteStateMachine: (id: string) => state.deleteStateMachine(id),
  } as unknown as LifecycleDependencies;

  const manager = new InstanceLifecycleManager(deps);
  const created: Record<string, unknown>[] = [];
  const batches: BatchUpdatePayload[] = [];
  const stateUpdates: Record<string, unknown>[] = [];
  manager.on('created', (payload: Record<string, unknown>) => created.push(payload));
  manager.on('state-update', (payload: Record<string, unknown>) => stateUpdates.push(payload));
  state.on('batch-update', (payload: BatchUpdatePayload) => batches.push(payload));
  return { manager, state, created, batches, stateUpdates };
}

describe('createInstance carries residentClaude to the renderer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAdapter.mockReset();
    mocks.resolveCliType.mockResolvedValue('claude');
    mocks.resolveAgent.mockResolvedValue(getDefaultAgent());
    mocks.supervisorRegister.mockReturnValue({ supervisorNodeId: 'sup-1', workerNodeId: 'worker-1' });
    mocks.maybeGenerateTitle.mockResolvedValue(undefined);
    mocks.localModelInventory.length = 0;
    mocks.getProviderCapabilities.mockReturnValue({
      supportsResume: false,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
      selfManagedAutoCompaction: false,
    });
    mocks.continuityResumeSession.mockResolvedValue(null);
    mocks.evaluateResumeHealth.mockResolvedValue('healthy');
    mocks.resolveExecutionLocation.mockReturnValue({ type: 'local' });
    mocks.getKnownModelsForCli.mockResolvedValue([]);
    mocks.settings.residentClaudeSession = true;
    mocks.settings.defaultModel = undefined;
    mocks.settings.defaultModelByProvider = {};
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is absent from the created event (it is only resolved in background init) but present on the batch updates that follow', async () => {
    const harness = makeHarness();
    try {
      mocks.createAdapter.mockReturnValue(makeFakeAdapter());

      const instance = await harness.manager.createInstance({
        workingDirectory: '/tmp/project',
        provider: 'claude',
        initialPrompt: 'hello world',
      });
      await instance.readyPromise;
      harness.state.destroy(); // flushes anything still queued for the renderer

      // The created event precedes background init: it cannot know the flag.
      expect(harness.created).toHaveLength(1);
      expect(harness.created[0]['id']).toBe(instance.id);
      expect(harness.created[0]['residentClaude']).toBeUndefined();
      // Main-side the flag is resolved by the time the session is ready.
      expect(instance.residentClaude).toBe(true);

      // What the renderer receives after creation (validated like the real IPC bus does).
      const received = harness.batches
        .map((batch) => InstanceBatchUpdateEventPayloadSchema.parse(batch))
        .flatMap((batch) => batch.updates)
        .filter((update) => update.instanceId === instance.id);
      expect(received.length).toBeGreaterThan(0);
      const carried = received.filter((update) => (update as Record<string, unknown>)['residentClaude'] === true);
      expect(
        carried.length,
        'a batch update after creation must tell the renderer residentClaude is true',
      ).toBeGreaterThan(0);
    } finally {
      harness.state.destroy();
      harness.manager.destroy();
    }
  });

  it('puts the resolved flag on the direct state update emitted when the model is resolved', async () => {
    const harness = makeHarness();
    try {
      mocks.createAdapter.mockReturnValue(makeFakeAdapter());

      const instance = await harness.manager.createInstance({
        workingDirectory: '/tmp/project',
        provider: 'claude',
      });
      await instance.readyPromise;

      const modelResolved = harness.stateUpdates.find(
        (update) => update['instanceId'] === instance.id && update['contextEvidence'] !== undefined,
      );
      expect(modelResolved, 'the model-resolved state update must exist').toBeDefined();
      expect(modelResolved?.['residentClaude']).toBe(true);
    } finally {
      harness.state.destroy();
      harness.manager.destroy();
    }
  });
});
