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
 *   3. initial-prompt send fail  → full rollback after a successful spawn
 *   4. success                   → commit; nothing is torn down
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../../shared/types/instance.types';
import type { LifecycleDependencies } from '../instance-lifecycle.types';
import type { InstanceStateMachine } from '../instance-state-machine';

const mocks = vi.hoisted(() => ({
  resolveAgent: vi.fn(),
  loadProjectRules: vi.fn(),
  supervisorRegister: vi.fn(() => ({ supervisorNodeId: 'sup-1', workerNodeId: 'worker-1' })),
  supervisorUnregister: vi.fn(),
  outputStorageDelete: vi.fn(),
  createAdapter: vi.fn(),
  resolveCliType: vi.fn().mockResolvedValue('claude'),
  promptHistoryRecord: vi.fn(),
  promptHistoryClear: vi.fn(),
  maybeGenerateTitle: vi.fn().mockResolvedValue(undefined),
  localModelInventory: [] as unknown[],
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/aio-test', isPackaged: false },
}));

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({ get: vi.fn(), set: vi.fn(), store: {} })),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
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
  getHistoryManager: () => ({ archiveInstance: vi.fn() }),
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
  getProviderRuntimeService: () => ({ createAdapter: mocks.createAdapter }),
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
    startTracking: vi.fn(),
    stopTracking: vi.fn(),
    updateState: vi.fn(),
    resumeSession: vi.fn(),
    markNativeResumeFailed: vi.fn(),
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
  on: ReturnType<typeof vi.fn>;
}

function makeFakeAdapter(): FakeAdapter {
  return {
    spawn: vi.fn().mockResolvedValue(4242),
    sendInput: vi.fn().mockResolvedValue(undefined),
    terminate: vi.fn().mockResolvedValue(undefined),
    removeAllListeners: vi.fn(),
    getName: () => 'claude',
    on: vi.fn(),
  };
}

interface Harness {
  manager: InstanceLifecycleManager;
  deps: LifecycleDependencies;
  instances: Map<string, Instance>;
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
  const adapters = new Map<string, unknown>();
  const stateMachines = new Map<string, InstanceStateMachine>();

  const initializeRlm = vi.fn().mockResolvedValue(undefined);
  const endRlmSession = vi.fn();
  const unregisterOrchestration = vi.fn();
  const setupAdapterEvents = vi.fn();
  const deleteDiffTracker = vi.fn();

  const deps = {
    getInstance: (id: string) => instances.get(id),
    setInstance: (instance: Instance) => { instances.set(instance.id, instance); },
    deleteInstance: (id: string) => instances.delete(id),
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
    mocks.resolveCliType.mockResolvedValue('claude');
    mocks.resolveAgent.mockResolvedValue(getDefaultAgent());
    mocks.supervisorRegister.mockReturnValue({ supervisorNodeId: 'sup-1', workerNodeId: 'worker-1' });
    mocks.maybeGenerateTitle.mockResolvedValue(undefined);
    mocks.localModelInventory.length = 0;
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

  it('rolls back everything when the initial prompt send fails after a successful spawn', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter();
    adapter.sendInput.mockRejectedValue(new Error('stdin closed'));
    mocks.createAdapter.mockReturnValue(adapter);

    const instance = await createAndAwaitFailure(harness, {
      workingDirectory: '/tmp/project',
      provider: 'claude',
      initialPrompt: 'hello world',
    });

    expect(adapter.spawn).toHaveBeenCalled();
    expect(harness.instances.has(instance.id)).toBe(false);
    expect(harness.adapters.has(instance.id)).toBe(false);
    expect(adapter.removeAllListeners).toHaveBeenCalled();
    expect(adapter.terminate).toHaveBeenCalledWith(false);
    expect(mocks.supervisorUnregister).toHaveBeenCalledWith(instance.id);
    expect(harness.unregisterOrchestration).toHaveBeenCalledWith(instance.id);
    expect(mocks.outputStorageDelete).toHaveBeenCalledWith(instance.id);
    expect(harness.endRlmSession).toHaveBeenCalledWith(instance.id);
    expect(mocks.promptHistoryClear).toHaveBeenCalledWith(instance.id);
    expect(harness.removedEvents).toContain(instance.id);
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
});
