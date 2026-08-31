/**
 * Spawn-as-transaction rollback integration tests (pi-borrowed-capabilities Task 8).
 *
 * Exercises the REAL InstanceLifecycleManager.createInstance() against a mocked
 * environment and injects failures at each resource-acquisition point:
 *
 *   1. RLM init failure          → Phase-1 registrations rolled back
 *      (instance store, output storage, state machine, parent-child link,
 *       supervisor tree, orchestration registry)
 *   2. adapter.spawn() failure   → all of the above plus prompt-history,
 *      RLM session, and adapter registration (listeners removed, adapter
 *      deleted, process terminated)
 *   3. initial-prompt send fail  → session PRESERVED after a successful spawn
 *      (the CLI is already live; a failed first turn must not delete the
 *       session — it settles to idle with a notice so the user can resend)
 *   4. success                   → commit; nothing is torn down
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../../shared/types/instance.types';
import type { SessionState } from '../../session/session-continuity.types';
import type { LifecycleDependencies } from '../instance-lifecycle.types';
import type { InstanceStateMachine } from '../instance-state-machine';
import {
  getOrCreateTurnSupervisor,
  getTurnSupervisor,
} from '../../session/session-turn-supervisor';

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
    getAll: () => ({
      defaultYoloMode: false,
      defaultCli: 'claude',
      outputStyle: 'default',
      injectRepoMap: false,
      residentClaudeSession: true,
    }),
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
  getKnownModelsForCli: vi.fn().mockResolvedValue([]),
  isRestoreOrReplayContinuity: vi.fn(() => false),
  requiresFreshConfiguredModelSpawn: vi.fn(() => false),
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
  getAutoTitleService: () => ({ maybeGenerateTitle: mocks.maybeGenerateTitle }),
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
import { getDefaultAgent } from '../../../shared/types/agent.types';

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

function makeFakeAdapter(): FakeAdapter {
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

function makeHarness(): Harness {
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

async function createAndAwaitFailure(
  harness: Harness,
  config: Parameters<InstanceLifecycleManager['createInstance']>[0],
): Promise<Instance> {
  const instance = await harness.manager.createInstance(config);
  const ready = instance.readyPromise;
  expect(ready).toBeDefined();
  await expect(ready).rejects.toThrow();
  return instance;
}

describe('createInstance spawn transaction rollback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAdapter.mockReset();
    mocks.resolveCliType.mockResolvedValue('claude');
    mocks.resolveAgent.mockResolvedValue(getDefaultAgent());
    mocks.supervisorRegister.mockReturnValue({ supervisorNodeId: 'sup-1', workerNodeId: 'worker-1' });
    mocks.maybeGenerateTitle.mockResolvedValue(undefined);
    mocks.localModelInventory.length = 0;
    mocks.localModelRefresh.mockResolvedValue(mocks.localModelInventory);
    mocks.getProviderCapabilities.mockReturnValue({
      supportsResume: false,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
      selfManagedAutoCompaction: false,
    });
    mocks.continuityStartTracking.mockResolvedValue(undefined);
    mocks.continuityStopTracking.mockResolvedValue(undefined);
    mocks.continuityResumeSession.mockResolvedValue(null);
    mocks.continuityMarkNativeResumeFailed.mockResolvedValue(undefined);
    mocks.continuityUpdateState.mockResolvedValue(undefined);
    mocks.evaluateResumeHealth.mockResolvedValue('healthy');
  });

  it('rolls back Phase-1 registrations when RLM init fails (before any adapter exists)', async () => {
    const harness = makeHarness();
    harness.initializeRlm.mockRejectedValue(new Error('rlm boom'));

    const instance = await createAndAwaitFailure(harness, {
      workingDirectory: '/tmp/project',
      provider: 'claude',
    });

    // Everything registered in Phase 1 is gone again.
    expect(harness.instances.has(instance.id)).toBe(false);
    expect(harness.stateMachines.has(instance.id)).toBe(false);
    expect(mocks.supervisorUnregister).toHaveBeenCalledWith(instance.id);
    expect(harness.unregisterOrchestration).toHaveBeenCalledWith(instance.id);
    expect(mocks.outputStorageDelete).toHaveBeenCalledWith(instance.id);
    expect(harness.removedEvents).toContain(instance.id);
    // The RLM session was never created, so it must not be torn down.
    expect(harness.endRlmSession).not.toHaveBeenCalled();
    // No adapter was ever created.
    expect(mocks.createAdapter).not.toHaveBeenCalled();
    expect(harness.adapters.size).toBe(0);
  });

  it('unlinks the child from its parent when spawn fails for a child instance', async () => {
    const harness = makeHarness();
    const parent = {
      id: 'parent-1',
      depth: 0,
      childrenIds: [],
      workingDirectory: '/tmp/project',
      outputBuffer: [],
      contextInheritance: { mode: 'none' },
    } as unknown as Instance;
    harness.instances.set(parent.id, parent);
    harness.initializeRlm.mockRejectedValue(new Error('rlm boom'));

    const instance = await createAndAwaitFailure(harness, {
      workingDirectory: '/tmp/project',
      provider: 'claude',
      parentId: parent.id,
    });

    expect(parent.childrenIds).not.toContain(instance.id);
    expect(harness.instances.has(instance.id)).toBe(false);
  });

  it('rolls back adapter registration, RLM session, and prompt history when adapter.spawn() throws', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter();
    adapter.spawn.mockRejectedValue(new Error('spawn ENOENT'));
    mocks.createAdapter.mockReturnValue(adapter);

    const instance = await createAndAwaitFailure(harness, {
      workingDirectory: '/tmp/project',
      provider: 'claude',
      initialPrompt: 'hello world',
    });

    // UI state was partially registered before the spawn — all of it is gone.
    expect(harness.instances.has(instance.id)).toBe(false);
    expect(harness.stateMachines.has(instance.id)).toBe(false);
    expect(mocks.supervisorUnregister).toHaveBeenCalledWith(instance.id);
    expect(harness.unregisterOrchestration).toHaveBeenCalledWith(instance.id);
    expect(mocks.outputStorageDelete).toHaveBeenCalledWith(instance.id);
    expect(harness.removedEvents).toContain(instance.id);
    // Adapter listeners removed, adapter deregistered and terminated.
    expect(adapter.removeAllListeners).toHaveBeenCalled();
    expect(harness.adapters.has(instance.id)).toBe(false);
    expect(adapter.terminate).toHaveBeenCalledWith(false);
    expect(harness.deleteDiffTracker).toHaveBeenCalledWith(instance.id);
    // Later-phase acquisitions rolled back too.
    expect(harness.endRlmSession).toHaveBeenCalledWith(instance.id);
    expect(mocks.promptHistoryRecord).toHaveBeenCalled();
    expect(mocks.promptHistoryClear).toHaveBeenCalledWith(instance.id);
  });

  it('preserves the session when the initial prompt send fails after a successful spawn', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter();
    // Reproduces the real Codex failure that was deleting live sessions: a
    // context-cost recovery pause thrown from the first turn.
    adapter.sendInput.mockRejectedValue(
      new Error(
        'Codex context-cost recovery paused because the active turn did not confirm interruption. The conversation was preserved; retry when ready.',
      ),
    );
    mocks.createAdapter.mockReturnValue(adapter);

    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'codex',
      initialPrompt: 'hello world',
    });
    // The spawn succeeded, so background init RESOLVES — a failed first turn
    // must not reject and trigger the spawn-transaction rollback.
    await expect(instance.readyPromise).resolves.toBeUndefined();

    expect(adapter.spawn).toHaveBeenCalled();
    expect(adapter.sendInput).toHaveBeenCalled();

    // The session is kept, not torn down: still in the store, adapter intact,
    // never terminated, never emitted as 'removed'.
    expect(harness.instances.has(instance.id)).toBe(true);
    expect(harness.adapters.get(instance.id)).toBe(adapter);
    expect(adapter.terminate).not.toHaveBeenCalled();
    expect(adapter.removeAllListeners).not.toHaveBeenCalled();
    expect(mocks.supervisorUnregister).not.toHaveBeenCalledWith(instance.id);
    expect(harness.unregisterOrchestration).not.toHaveBeenCalledWith(instance.id);
    expect(mocks.outputStorageDelete).not.toHaveBeenCalledWith(instance.id);
    expect(harness.endRlmSession).not.toHaveBeenCalledWith(instance.id);
    expect(harness.removedEvents).not.toContain(instance.id);

    // It settles to idle so the user can simply resend...
    expect(instance.status).toBe('idle');
    // ...and a system notice explains that the first message didn't send.
    const notice = instance.outputBuffer.find(
      (m) => (m as { metadata?: { initialPromptFailed?: boolean } }).metadata?.initialPromptFailed,
    );
    expect(notice).toBeDefined();
  });

  it('commits on success and leaves every resource registered', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter();
    mocks.createAdapter.mockReturnValue(adapter);

    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
      initialPrompt: 'hello world',
    });
    await instance.readyPromise;

    expect(harness.instances.has(instance.id)).toBe(true);
    expect(harness.adapters.get(instance.id)).toBe(adapter);
    expect(instance.status).toBe('idle');
    expect(instance.processId).toBe(4242);
    // No rollback side effects on the happy path.
    expect(adapter.terminate).not.toHaveBeenCalled();
    expect(adapter.removeAllListeners).not.toHaveBeenCalled();
    expect(mocks.supervisorUnregister).not.toHaveBeenCalled();
    expect(harness.unregisterOrchestration).not.toHaveBeenCalled();
    expect(mocks.outputStorageDelete).not.toHaveBeenCalled();
    expect(harness.endRlmSession).not.toHaveBeenCalled();
    expect(mocks.promptHistoryClear).not.toHaveBeenCalled();
    expect(harness.removedEvents).toEqual([]);
    // The initial prompt actually reached the adapter.
    expect(adapter.sendInput).toHaveBeenCalledWith('hello world', undefined);
  });

  it('keeps recovery creation private until explicit publication', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter();
    mocks.createAdapter.mockReturnValue(adapter);
    const createdEvents: Array<Record<string, unknown>> = [];
    const stateEvents: Array<Record<string, unknown>> = [];
    harness.manager.on('created', (payload: Record<string, unknown>) => createdEvents.push(payload));
    harness.manager.on('state-update', (payload: Record<string, unknown>) => stateEvents.push(payload));

    const creation = await harness.manager.createUnpublishedInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
      isRestoredSession: true,
      initialOutputBuffer: [{
        id: 'recovered-message-1',
        type: 'assistant',
        content: 'fixture recovered content',
        timestamp: 1,
      }],
      metadata: { continuityRevival: true, reason: 'crash-recovery' },
    });

    expect(createdEvents).toEqual([]);
    expect(harness.instances.has(creation.instance.id)).toBe(false);
    expect(harness.pendingInstances.get(creation.instance.id)).toBe(creation.instance);
    await creation.instance.readyPromise;
    expect(createdEvents).toEqual([]);
    expect(stateEvents).toEqual([]);
    await creation.publish();

    expect(createdEvents).toEqual([{ id: creation.instance.id }]);
    expect(harness.instances.get(creation.instance.id)).toBe(creation.instance);
    expect(harness.pendingInstances.has(creation.instance.id)).toBe(false);
    expect(stateEvents).toEqual([]);
    expect(harness.removedEvents).toEqual([]);
  });

  it('rolls back a ready seeded recovery without public removal or archival', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter();
    mocks.createAdapter.mockReturnValue(adapter);
    const createdEvents: Array<Record<string, unknown>> = [];
    harness.manager.on('created', (payload: Record<string, unknown>) => createdEvents.push(payload));
    const creation = await harness.manager.createUnpublishedInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
      isRestoredSession: true,
      initialOutputBuffer: [{
        id: 'recovered-message-1',
        type: 'assistant',
        content: 'fixture recovered content',
        timestamp: 1,
      }],
      metadata: { continuityRevival: true, reason: 'crash-recovery' },
    });
    await creation.instance.readyPromise;

    await creation.rollback(new Error('fixture replay queue failure'));
    await creation.rollback(new Error('fixture duplicate rollback'));

    expect(harness.instances.has(creation.instance.id)).toBe(false);
    expect(harness.adapters.has(creation.instance.id)).toBe(false);
    expect(adapter.terminate).toHaveBeenCalledWith(false);
    expect(createdEvents).toEqual([]);
    expect(harness.removedEvents).toEqual([]);
    expect(mocks.archiveInstance).not.toHaveBeenCalled();
    expect(harness.pendingInstances.has(creation.instance.id)).toBe(false);
  });

  it('publishes and rolls back idempotently without duplicating observers or cleanup', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter();
    mocks.createAdapter.mockReturnValue(adapter);
    const created = vi.fn();
    harness.manager.on('created', created);
    const creation = await harness.manager.createUnpublishedInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
      metadata: { continuityRevival: true, reason: 'crash-recovery' },
    });
    await creation.instance.readyPromise;

    await Promise.all([creation.publish(), creation.publish()]);
    await creation.rollback(new Error('ignored after publication'));

    expect(created).toHaveBeenCalledOnce();
    expect(harness.instances.get(creation.instance.id)).toBe(creation.instance);
    expect(adapter.terminate).not.toHaveBeenCalled();
  });

  it('serializes a concurrent publication and rollback with publication as the sole winner', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter();
    mocks.createAdapter.mockReturnValue(adapter);
    const created = vi.fn();
    harness.manager.on('created', created);
    const creation = await harness.manager.createUnpublishedInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
      metadata: { continuityRevival: true, reason: 'crash-recovery' },
    });
    await creation.instance.readyPromise;

    const publication = creation.publish();
    const rollback = creation.rollback(new Error('fixture concurrent rollback'));

    await expect(publication).resolves.toBeUndefined();
    await expect(rollback).rejects.toThrow('publication is in progress');
    expect(created).toHaveBeenCalledOnce();
    expect(harness.instances.get(creation.instance.id)).toBe(creation.instance);
    expect(adapter.terminate).not.toHaveBeenCalled();
  });

  it('removes the private turn supervisor during rollback', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter();
    mocks.createAdapter.mockReturnValue(adapter);
    const creation = await harness.manager.createUnpublishedInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
      metadata: { continuityRevival: true, reason: 'crash-recovery' },
    });
    await creation.instance.readyPromise;
    getOrCreateTurnSupervisor(creation.instance.id);

    await creation.rollback(new Error('fixture rollback'));

    expect(getTurnSupervisor(creation.instance.id)).toBeUndefined();
  });

  it('omits a recovery cursor from the real resumed-lifecycle logger path', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter();
    mocks.createAdapter.mockReturnValue(adapter);
    (harness.deps as LifecycleDependencies).warmStartManager = {
      consume: vi.fn(() => null),
      preWarm: vi.fn().mockResolvedValue(undefined),
    } as unknown as LifecycleDependencies['warmStartManager'];
    const cursorPlaceholder = 'native-cursor-fixture-placeholder';

    const creation = await harness.manager.createUnpublishedInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
      sessionId: cursorPlaceholder,
      resume: true,
      metadata: { continuityRevival: true, reason: 'crash-recovery' },
    });
    await creation.instance.readyPromise;

    const serializedLogs = JSON.stringify(mocks.loggerInfo.mock.calls);
    expect(serializedLogs).not.toContain(cursorPlaceholder);
    expect(serializedLogs).toContain('[recovery session omitted]');
    await creation.rollback(new Error('fixture cleanup'));
  });

  it('redacts recovery identity from rollback causes and cleanup failures', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter();
    const cursorPlaceholder = 'rollback-native-cursor-fixture-placeholder';
    harness.endRlmSession.mockImplementationOnce(() => {
      throw new Error(`fixture RLM cleanup failed for ${cursorPlaceholder}`);
    });
    mocks.createAdapter.mockReturnValue(adapter);
    const creation = await harness.manager.createUnpublishedInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
      sessionId: cursorPlaceholder,
      resume: true,
      metadata: { continuityRevival: true, reason: 'crash-recovery' },
    });
    await creation.instance.readyPromise;
    mocks.loggerWarn.mockClear();
    mocks.loggerError.mockClear();

    await creation.rollback(new Error(`fixture recovery failed for ${cursorPlaceholder}`));

    const serializedLogs = JSON.stringify([
      mocks.loggerWarn.mock.calls,
      mocks.loggerError.mock.calls,
    ]);
    expect(serializedLogs).not.toContain(cursorPlaceholder);
    expect(serializedLogs).toContain('recoverySession');
  });

  it('redacts recovery identities from native-resume proof state and diagnostics', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter() as FakeAdapter & {
      getResumeAttemptResult: () => {
        source: 'cli-echo';
        requestedSessionId: string;
        actualSessionId: string;
        confirmed: false;
        reason: string;
      };
    };
    const requestedCursor = 'requested-native-cursor-placeholder';
    const actualCursor = 'actual-native-cursor-placeholder';
    adapter.getResumeAttemptResult = () => ({
      source: 'cli-echo', requestedSessionId: requestedCursor,
      actualSessionId: actualCursor, confirmed: false,
      reason: `mismatch ${requestedCursor} ${actualCursor}`,
    });
    mocks.createAdapter.mockReturnValue(adapter);
    const creation = await harness.manager.createUnpublishedInstance({
      workingDirectory: '/tmp/project', provider: 'claude',
      sessionId: requestedCursor, resume: true,
      metadata: { continuityRevival: true, reason: 'crash-recovery' },
    });
    await creation.instance.readyPromise;
    mocks.loggerInfo.mockClear();
    const evaluateResumeHealth = harness.manager as unknown as {
      evaluateResumeHealth(id: string, timeoutMs: number, pollIntervalMs: number): Promise<string>;
    };

    await expect(evaluateResumeHealth.evaluateResumeHealth(
      creation.instance.id, 1, 1,
    )).resolves.toBe('unrecoverable');

    const diagnostics = JSON.stringify([
      mocks.loggerInfo.mock.calls,
      (harness.deps.queueUpdate as ReturnType<typeof vi.fn>).mock.calls,
    ]);
    expect(diagnostics).not.toContain(requestedCursor);
    expect(diagnostics).not.toContain(actualCursor);
    await creation.rollback(new Error('fixture cleanup'));
  });

  it('creates, becomes ready, and terminates without leaving lifecycle resources behind', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter();
    mocks.createAdapter.mockReturnValue(adapter);

    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
    });
    await instance.readyPromise;

    await harness.manager.terminateInstance(instance.id);

    expect(adapter.terminate).toHaveBeenCalledWith(true);
    expect(harness.instances.has(instance.id)).toBe(false);
    expect(harness.adapters.has(instance.id)).toBe(false);
    expect(harness.stateMachines.has(instance.id)).toBe(false);
    expect(mocks.supervisorUnregister).toHaveBeenCalledWith(instance.id);
    expect(harness.unregisterOrchestration).toHaveBeenCalledWith(instance.id);
    expect(harness.endRlmSession).toHaveBeenCalledWith(instance.id);
    expect(harness.removedEvents).toContain(instance.id);
  });

  it('rolls back an in-flight create when termination wins the race', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter();
    mocks.createAdapter.mockReturnValue(adapter);
    let releaseRlm!: () => void;
    harness.initializeRlm.mockImplementation(
      () => new Promise<void>((resolve) => { releaseRlm = resolve; }),
    );

    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
    });
    const readyPromise = instance.readyPromise;

    const termination = harness.manager.terminateInstance(instance.id);
    releaseRlm();
    await termination;
    await readyPromise?.catch(() => undefined);

    expect(harness.instances.has(instance.id)).toBe(false);
    expect(harness.adapters.has(instance.id)).toBe(false);
    expect(harness.stateMachines.has(instance.id)).toBe(false);
    expect(adapter.spawn).not.toHaveBeenCalled();
    expect(harness.removedEvents).toContain(instance.id);
  });

  it('creates root Codex adapters with durable provider sessions', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter();
    mocks.resolveCliType.mockResolvedValue('codex');
    mocks.createAdapter.mockReturnValue(adapter);

    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'codex',
      initialPrompt: 'hello world',
    });
    await instance.readyPromise;

    expect(mocks.createAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        cliType: 'codex',
        options: expect.objectContaining({
          instanceId: instance.id,
          ephemeral: false,
        }),
      }),
    );
  });

  it('native-resumes from registry capabilities after the previous adapter was disposed', async () => {
    const harness = makeHarness();
    const initialAdapter = makeFakeAdapter();
    const resumedAdapter = makeFakeAdapter();
    mocks.resolveCliType.mockResolvedValue('codex');
    mocks.createAdapter
      .mockReturnValueOnce(initialAdapter)
      .mockReturnValueOnce(resumedAdapter);
    mocks.getProviderCapabilities.mockReturnValue({
      supportsResume: true,
      supportsForkSession: false,
      supportsNativeCompaction: true,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
      selfManagedAutoCompaction: true,
    });

    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'codex',
      initialPrompt: 'continue the task',
    });
    await instance.readyPromise;
    instance.providerSessionId = 'provider-thread-1';
    instance.sessionId = 'provider-thread-1';
    harness.adapters.delete(instance.id);

    await harness.manager.restartInstance(instance.id);

    expect(mocks.getProviderCapabilities).toHaveBeenCalledWith(undefined, 'codex');
    expect(mocks.createAdapter).toHaveBeenLastCalledWith(expect.objectContaining({
      cliType: 'codex',
      options: expect.objectContaining({
        sessionId: 'provider-thread-1',
        resume: true,
      }),
    }));
    expect(instance.recoveryMethod).toBe('native');
    expect(harness.adapters.get(instance.id)).toBe(resumedAdapter);
  });

  it('keeps recovery identities redacted when the published replacement later restarts', async () => {
    const harness = makeHarness();
    const initialAdapter = makeFakeAdapter();
    const resumedAdapter = makeFakeAdapter();
    const cursor = 'restart-recovery-cursor-placeholder';
    const historyThreadId = 'restart-recovery-history-placeholder';
    mocks.resolveCliType.mockResolvedValue('codex');
    mocks.createAdapter
      .mockReturnValueOnce(initialAdapter)
      .mockReturnValueOnce(resumedAdapter);
    mocks.getProviderCapabilities.mockReturnValue({
      supportsResume: true,
      supportsForkSession: false,
      supportsNativeCompaction: true,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
      selfManagedAutoCompaction: true,
    });
    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'codex',
      sessionId: cursor,
      historyThreadId,
      resume: true,
      metadata: { continuityRevival: true, reason: 'crash-recovery' },
    });
    await instance.readyPromise;
    instance.providerSessionId = cursor;
    mocks.loggerInfo.mockClear();

    await harness.manager.restartInstance(instance.id);

    const serializedLogs = JSON.stringify(mocks.loggerInfo.mock.calls);
    expect(serializedLogs).not.toContain(cursor);
    expect(serializedLogs).not.toContain(historyThreadId);
    expect(serializedLogs).toContain('recoverySession');
  });

  it('keeps the recovery cursor redacted when a later native wake falls back', async () => {
    const harness = makeHarness();
    const initialAdapter = makeFakeAdapter();
    const nativeWakeAdapter = makeFakeAdapter();
    const replayWakeAdapter = makeFakeAdapter();
    const cursor = 'wake-recovery-cursor-placeholder';
    replayWakeAdapter.spawn.mockRejectedValue(
      new Error(`fallback wake failed for ${cursor}`),
    );
    mocks.createAdapter
      .mockReturnValueOnce(initialAdapter)
      .mockReturnValueOnce(nativeWakeAdapter)
      .mockReturnValueOnce(replayWakeAdapter);
    mocks.continuityResumeSession.mockResolvedValue({
      instanceId: 'source-instance-placeholder',
      sessionId: cursor,
      historyThreadId: 'wake-history-placeholder',
      displayName: 'Recovered wake fixture',
      agentId: 'build',
      modelId: '',
      provider: 'claude',
      workingDirectory: '/tmp/project',
      conversationHistory: [{
        id: 'wake-user-message', role: 'user', content: 'fixture prompt', timestamp: 1,
      }],
      contextUsage: { used: 1, total: 200_000 },
      pendingTasks: [],
      environmentVariables: {},
      activeFiles: [],
      skillsLoaded: [],
      hooksActive: [],
    });
    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
      sessionId: cursor,
      resume: true,
      metadata: { continuityRevival: true, reason: 'crash-recovery' },
    });
    await instance.readyPromise;
    await harness.manager.hibernateInstance(instance.id);
    mocks.evaluateResumeHealth.mockResolvedValue('unrecoverable');
    mocks.loggerWarn.mockClear();
    mocks.loggerError.mockClear();

    await expect(harness.manager.wakeInstance(instance.id))
      .rejects.toThrow('Recovery instance wake failed');

    expect(mocks.continuityResumeSession).toHaveBeenCalledWith(instance.id, {
      restoreMessages: true,
      restoreContext: true,
    });
    expect(mocks.evaluateResumeHealth).toHaveBeenCalled();
    const serializedLogs = JSON.stringify([
      mocks.loggerWarn.mock.calls,
      mocks.loggerError.mock.calls,
    ]);
    expect(serializedLogs).not.toContain(cursor);
    expect(serializedLogs).toContain('recoverySession');
  });

  it('disarms the handlers that own a hold, not just the banner', async () => {
    // Round 8, 2026-08-30. Clearing the waitReason alone HID the hold while
    // leaving its background state armed: a `quota-park` keeps its resume timer
    // and durable automation, and a handler-registered `auth-required` keeps its
    // sign-in watch. Either fires `resendInput` later with the pre-restart
    // prompt — injecting a message into a session the user restarted to move on
    // from, with the one banner that hinted at it now removed.
    //
    // Round 9 rejected the first version of this test: it only spied on the two
    // methods, and configured NEITHER handler, so both calls were no-ops and it
    // would have passed against a gutted disarm. This version arms a REAL park
    // and a REAL auth block, then asserts the state is actually gone and the
    // scheduled resume cannot fire.
    const { getInstanceProviderLimitHandler } = await import('../instance-provider-limit-handler');
    const { getInstanceAuthRepairHandler } = await import('../instance-auth-repair-handler');
    const limitHandler = getInstanceProviderLimitHandler();
    const authHandler = getInstanceAuthRepairHandler();

    const resends: { instanceId: string; prompt: string }[] = [];
    // NOT cast to `never`. The previous version silenced the type error with a
    // cast and got the shape of BOTH callbacks wrong: `scheduleResume` must
    // return a bare canceller function (returning an object made `entry.cancel()`
    // throw inside `cancel()`, which restartInstance's try/catch swallowed — so
    // the disarm never ran while `isParked()` still read false), and
    // `resumeInstance` takes `(instanceId, opts)` (calling it with no arguments
    // could never resend, making the decisive assertion vacuous).
    let scheduledResume: ((instanceId: string) => void) | null = null;
    let cancelledSchedule = false;
    limitHandler.configure({
      isEnabled: () => true,
      setWaitReason: () => {},
      getQuotaSnapshot: () => null,
      refreshQuotaSnapshot: () => {},
      getWorkspaceCwd: () => '/tmp/project',
      isResumable: () => true,
      resendInput: (id: string, prompt: string) => { resends.push({ instanceId: id, prompt }); },
      scheduleResume: ({ resumeInstance }) => {
        scheduledResume = resumeInstance;
        return () => { cancelledSchedule = true; };
      },
    });
    // Not cast to `never` either — the same suppression that hid two wrong
    // callback shapes on the other handler.
    authHandler.configure({
      setWaitReason: () => {},
      revive: async (id: string) => id,
      resendInput: (id, turn) => { resends.push({ instanceId: id, prompt: turn.message }); },
      probeAuth: async () => 'unauthenticated' as const,
    });

    const harness = makeHarness();
    mocks.createAdapter.mockReturnValue(makeFakeAdapter());
    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'copilot',
      initialPrompt: 'go',
    });
    await instance.readyPromise;

    limitHandler.maybePark({
      instanceId: instance.id,
      provider: 'claude',
      resetAtHint: Date.now() + 3_600_000,
      reason: 'limit',
      resumePrompt: 'STALE PRE-RESTART PROMPT',
    } as never);
    const blockOutcome = await authHandler.maybeBlockOnAuth({
      instanceId: instance.id,
      provider: 'claude',
      reason: 'provider auth failure on turn',
      resumeTurn: { message: 'STALE PRE-RESTART PROMPT' },
      authoritative: false,
    });
    // Both preconditions asserted. Without the auth one, a `maybeBlockOnAuth`
    // that silently returned 'skipped' would make the `not-blocked` assertion
    // below pass while proving nothing.
    expect(blockOutcome, 'precondition: really blocked on auth').toBe('blocked');
    expect(authHandler.isBlocked(instance.id), 'precondition: really blocked').toBe(true);
    expect(limitHandler.isParked(instance.id), 'precondition: really parked').toBe(true);

    try {
      await harness.manager.restartInstance(instance.id);

      expect(limitHandler.isParked(instance.id), 'the park must be gone, not just hidden').toBe(false);
      expect(cancelledSchedule, 'the scheduled resume must actually be cancelled').toBe(true);
      await expect(authHandler.retryNow(instance.id)).resolves.toEqual({ status: 'not-blocked' });

      // The decisive assertion. Invoked the way production's own timer closure
      // invokes it — WITH the instance id — so it genuinely exercises the resend
      // path. Even if a timer or durable automation still fires after a restart,
      // the stale prompt must not be re-injected into the session.
      const fire = scheduledResume as ((instanceId: string) => void) | null;
      expect(fire, 'the resume callback must have been captured').not.toBeNull();
      fire?.(instance.id);
      expect(resends, 'a restarted session must never receive its pre-restart prompt').toEqual([]);
    } finally {
      // In a finally: an assertion above throwing would otherwise leave these
      // process-global singletons configured with this test's closures for
      // every later test in the file.
      limitHandler._resetForTesting();
      (authHandler.constructor as unknown as { _resetForTesting(): void })._resetForTesting();
    }
  });

  it('disarms a hold even when the restart itself FAILS', async () => {
    // Round 11, 2026-08-30. The disarm sat after the `if (!result.success)`
    // early return, so a failed restart left the park's timer and durable
    // automation armed. The session lands in `error`, and the timer later
    // resends the pre-restart prompt into that broken session — the same harm
    // the success-path fix removed, reachable whenever recovery fails for an
    // unrelated reason (CLI missing, spawn error).
    const { getInstanceProviderLimitHandler } = await import('../instance-provider-limit-handler');
    const limitHandler = getInstanceProviderLimitHandler();

    const resends: { instanceId: string; prompt: string }[] = [];
    let scheduledResume: ((instanceId: string) => void) | null = null;
    limitHandler.configure({
      isEnabled: () => true,
      setWaitReason: () => {},
      getQuotaSnapshot: () => null,
      refreshQuotaSnapshot: () => {},
      getWorkspaceCwd: () => '/tmp/project',
      isResumable: () => true,
      resendInput: (id: string, prompt: string) => { resends.push({ instanceId: id, prompt }); },
      scheduleResume: ({ resumeInstance }) => {
        scheduledResume = resumeInstance;
        return () => {};
      },
    });

    const harness = makeHarness();
    mocks.createAdapter.mockReturnValue(makeFakeAdapter());
    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'copilot',
      initialPrompt: 'go',
    });
    await instance.readyPromise;

    limitHandler.maybePark({
      instanceId: instance.id,
      provider: 'claude',
      resetAtHint: Date.now() + 3_600_000,
      reason: 'limit',
      resumePrompt: 'STALE PRE-RESTART PROMPT',
    });
    expect(limitHandler.isParked(instance.id), 'precondition: really parked').toBe(true);

    try {
      // Make the restart's own recovery fail.
      mocks.createAdapter.mockImplementation(() => {
        throw new Error('ENOENT: cli not found');
      });
      // A missing CLI throws out of recovery rather than returning a failure
      // result, so accept either shape — both leave the session unusable.
      const outcome = await harness.manager
        .restartInstance(instance.id)
        .catch((error: unknown) => ({ success: false as const, error }));
      expect(outcome.success, 'precondition: the restart must actually fail').toBe(false);

      expect(limitHandler.isParked(instance.id), 'a FAILED restart must still disarm').toBe(false);
      const fire = scheduledResume as ((instanceId: string) => void) | null;
      fire?.(instance.id);
      expect(resends, 'a broken session must never receive its pre-restart prompt').toEqual([]);
    } finally {
      limitHandler._resetForTesting();
    }
  });

  it('does not touch the shared provider-limit gate when nothing was parked', async () => {
    // Round 12, 2026-08-30. `cancel()` is NOT a no-op for an unparked instance:
    // it also clears the durable known-limit gate, which the ledger keys by
    // PROVIDER/MODEL, not by instance. Calling it unconditionally from the
    // restart `finally` meant restarting ANY session wiped the "this provider is
    // rate-limited" gate for every other session on that provider — letting the
    // next turn sail into the limit, and letting failover pick a provider that
    // is still throttled.
    const { getInstanceProviderLimitHandler } = await import('../instance-provider-limit-handler');
    const limitHandler = getInstanceProviderLimitHandler();
    const cancelSpy = vi.spyOn(limitHandler, 'cancel');

    const harness = makeHarness();
    mocks.createAdapter.mockReturnValue(makeFakeAdapter());
    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'copilot',
      initialPrompt: 'go',
    });
    await instance.readyPromise;
    expect(limitHandler.isParked(instance.id), 'precondition: NOT parked').toBe(false);

    try {
      await harness.manager.restartInstance(instance.id);
      expect(cancelSpy, 'an unparked restart must not reach cancel() at all').not.toHaveBeenCalled();
    } finally {
      cancelSpy.mockRestore();
      limitHandler._resetForTesting();
    }
  });

  it('clears any hold when a restart succeeds', async () => {
    // Round 7, 2026-08-30. `queueUpdate`'s waitReason parameter treats
    // `undefined` as "preserve", and restartInstance passed nothing — so a
    // session parked on a Copilot routing failure came back fully healthy while
    // still showing a "signed out of copilot" banner it could never shed.
    const harness = makeHarness();
    mocks.createAdapter.mockReturnValue(makeFakeAdapter());

    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'copilot',
      initialPrompt: 'go',
    });
    await instance.readyPromise;
    (harness.deps.queueUpdate as ReturnType<typeof vi.fn>).mockClear();

    await harness.manager.restartInstance(instance.id);

    // waitReason is the 11th positional argument; `null` clears it.
    const calls = (harness.deps.queueUpdate as ReturnType<typeof vi.fn>).mock.calls;
    const cleared = calls.some((args: unknown[]) => args[10] === null);
    expect(cleared, 'a successful restart must clear the hold, not preserve it').toBe(true);
  });

  it('passes local-model runtime targets to adapter creation with resolved remote execution', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter();
    mocks.createAdapter.mockReturnValue(adapter);
    const runtimeTarget = {
      kind: 'local-model' as const,
      source: 'worker-node' as const,
      selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      endpointProvider: 'ollama' as const,
      endpointId: 'ollama',
      modelId: 'qwen',
    };
    mocks.localModelInventory.push({
      selectorId: runtimeTarget.selectorId,
      source: 'worker-node',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'qwen',
      healthy: true,
    });

    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
      modelRuntimeTarget: runtimeTarget,
    });
    await instance.readyPromise;

    expect(instance.executionLocation).toEqual({ type: 'remote', nodeId: 'node-win' });
    expect(instance.currentModel).toBe('qwen');
    expect(instance.runtimeSummary).toMatchObject({
      kind: 'local-model',
      label: 'qwen on windows-pc',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
    });
    expect(mocks.createAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        cliType: 'claude',
        executionLocation: { type: 'remote', nodeId: 'node-win' },
        options: expect.objectContaining({
          model: 'qwen',
          modelRuntimeTarget: runtimeTarget,
        }),
      }),
    );
  });

  it('fails local-model launches clearly when the selected worker model is no longer healthy', async () => {
    const harness = makeHarness();
    mocks.createAdapter.mockReturnValue(makeFakeAdapter());
    const runtimeTarget = {
      kind: 'local-model' as const,
      source: 'worker-node' as const,
      selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      endpointProvider: 'ollama' as const,
      endpointId: 'ollama',
      modelId: 'qwen',
    };

    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
      modelRuntimeTarget: runtimeTarget,
    });

    await expect(instance.readyPromise).rejects.toThrow(
      'qwen is no longer available on windows-pc. Pick another model or start the endpoint on that worker.',
    );
    expect(mocks.createAdapter).not.toHaveBeenCalled();
  });

  it('refreshes local-model inventory before launch and blocks a disappeared model', async () => {
    const harness = makeHarness();
    mocks.createAdapter.mockReturnValue(makeFakeAdapter());
    const runtimeTarget = {
      kind: 'local-model' as const,
      source: 'worker-node' as const,
      selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      endpointProvider: 'ollama' as const,
      endpointId: 'ollama',
      modelId: 'qwen',
    };
    mocks.localModelInventory.push({
      selectorId: runtimeTarget.selectorId,
      source: 'worker-node',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'qwen',
      healthy: true,
    });
    mocks.localModelRefresh.mockImplementation(async () => {
      mocks.localModelInventory.length = 0;
      return mocks.localModelInventory;
    });

    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
      modelRuntimeTarget: runtimeTarget,
    });

    await expect(instance.readyPromise).rejects.toThrow(
      'qwen is no longer available on windows-pc. Pick another model or start the endpoint on that worker.',
    );
    expect(mocks.localModelRefresh).toHaveBeenCalledOnce();
    expect(mocks.createAdapter).not.toHaveBeenCalled();
  });

  it('does not terminate the current adapter when a local-model change target is unavailable', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter();
    mocks.createAdapter.mockReturnValue(adapter);
    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
    });
    await instance.readyPromise;
    adapter.terminate.mockClear();
    mocks.createAdapter.mockClear();
    const runtimeTarget = {
      kind: 'local-model' as const,
      source: 'worker-node' as const,
      selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      endpointProvider: 'ollama' as const,
      endpointId: 'ollama',
      modelId: 'qwen',
    };

    await expect(
      harness.manager.changeModel(instance.id, runtimeTarget.modelId, undefined, runtimeTarget),
    ).rejects.toThrow(
      'qwen is no longer available on windows-pc. Pick another model or start the endpoint on that worker.',
    );

    expect(adapter.terminate).not.toHaveBeenCalled();
    expect(harness.adapters.get(instance.id)).toBe(adapter);
    expect(mocks.createAdapter).not.toHaveBeenCalled();
    expect(instance.currentModel).not.toBe('qwen');
  });

  it('does not terminate the current adapter when a this-device local-model target is unavailable', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter();
    mocks.createAdapter.mockReturnValue(adapter);
    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
    });
    await instance.readyPromise;
    adapter.terminate.mockClear();
    mocks.createAdapter.mockClear();
    const runtimeTarget = {
      kind: 'local-model' as const,
      source: 'this-device' as const,
      selectorId: 'lm://this-device/ollama/ollama/qwen',
      endpointProvider: 'ollama' as const,
      endpointId: 'ollama',
      modelId: 'qwen',
    };

    await expect(
      harness.manager.changeModel(instance.id, runtimeTarget.modelId, undefined, runtimeTarget),
    ).rejects.toThrow(
      'qwen is no longer available on this device. Pick another model or start the endpoint on this device.',
    );

    expect(adapter.terminate).not.toHaveBeenCalled();
    expect(harness.adapters.get(instance.id)).toBe(adapter);
    expect(mocks.createAdapter).not.toHaveBeenCalled();
    expect(instance.currentModel).not.toBe('qwen');
  });
});
