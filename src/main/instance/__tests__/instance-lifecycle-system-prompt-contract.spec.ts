/**
 * WS-B4 regression: instance-lifecycle.ts's real system-prompt assembly
 * (createInstance() background init) must route every block through
 * `createSystemPromptComposer()` in `SYSTEM_PROMPT_BLOCK_ORDER` and reproduce
 * the exact pre-refactor concatenation shape — same content, same
 * `\n\n---\n\n` separators, same order. This exercises the REAL
 * InstanceLifecycleManager.createInstance() (not the composer in isolation;
 * see prompt-injection-contract.spec.ts for that) with several of the
 * optional blocks populated, and asserts the system prompt handed to the
 * adapter equals a string built independently in this test from the same
 * inputs.
 *
 * Harness borrowed from instance-lifecycle-spawn-rollback.spec.ts (same
 * mocking shape); trimmed to what createInstance() touches.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../../shared/types/instance.types';
import type { LifecycleDependencies } from '../instance-lifecycle.types';
import type { InstanceStateMachine } from '../instance-state-machine';
import { buildToolPermissionPrompt } from '../lifecycle/tool-permission-prompt';
import { SYSTEM_PROMPT_BLOCK_SEPARATOR } from '../../context/prompt-injection-contract';

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
  buildProjectMemoryBrief: vi.fn(),
  extractAuthoredLessons: vi.fn(),
  outputStyle: 'default' as string,
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
      outputStyle: mocks.outputStyle,
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
    buildProjectMemoryBrief: mocks.buildProjectMemoryBrief,
  }),
}));

vi.mock('../../memory/project-memory-brief', () => ({
  getProjectMemoryBriefService: () => ({ buildBrief: vi.fn() }),
}));

vi.mock('../../memory/project-story-convention', () => ({
  extractAuthoredLessons: mocks.extractAuthoredLessons,
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
    evaluateResumeHealth(): Promise<'healthy'> { return Promise.resolve('healthy'); }
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

function makeHarness(overrides: Partial<LifecycleDependencies> = {}) {
  const instances = new Map<string, Instance>();
  const adapters = new Map<string, unknown>();
  const stateMachines = new Map<string, InstanceStateMachine>();

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
    deleteDiffTracker: vi.fn(),
    getStateMachine: (id: string) => stateMachines.get(id),
    setStateMachine: (id: string, machine: InstanceStateMachine) => {
      stateMachines.set(id, machine);
    },
    deleteStateMachine: (id: string) => { stateMachines.delete(id); },
    ...overrides,
  } as unknown as LifecycleDependencies;

  const manager = new InstanceLifecycleManager(deps);
  return { manager, deps, instances, adapters, stateMachines };
}

describe('instance-lifecycle system-prompt composition (WS-B4 regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.outputStyle = 'default';
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
    mocks.buildProjectMemoryBrief.mockResolvedValue({
      text: '',
      stats: { projectKey: 'test', candidatesScanned: 0, candidatesIncluded: 0, truncated: false },
      sources: [],
    });
    mocks.extractAuthoredLessons.mockReturnValue(null);
  });

  it('assembles instructions + tool-permissions in contract order with no optional blocks populated', async () => {
    const harness = makeHarness();
    const adapter = makeFakeAdapter();
    mocks.createAdapter.mockReturnValue(adapter);
    const agent = getDefaultAgent();

    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
    });
    await instance.readyPromise;

    const expected = [
      agent.systemPrompt,
      buildToolPermissionPrompt(instance.yoloMode),
    ].join(SYSTEM_PROMPT_BLOCK_SEPARATOR);

    expect(mocks.createAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ systemPrompt: expected }),
      }),
    );
  });

  it('assembles instructions + output-style + observation-memory + project-brief + lessons + tool-permissions in contract order', async () => {
    const harness = makeHarness({
      buildObservationContext: vi.fn().mockResolvedValue('Past reflection: prefer const bindings.'),
    } as Partial<LifecycleDependencies>);
    const adapter = makeFakeAdapter();
    mocks.createAdapter.mockReturnValue(adapter);
    mocks.outputStyle = 'concise';
    mocks.buildProjectMemoryBrief.mockResolvedValue({
      text: 'Project: ai-orchestrator. Electron + Angular desktop app.',
      stats: { projectKey: 'test', candidatesScanned: 3, candidatesIncluded: 2, truncated: false },
      sources: [],
    });
    mocks.extractAuthoredLessons.mockReturnValue('## Lessons\n- Always run tsc --noEmit before claiming done.');
    const agent = getDefaultAgent();

    const instance = await harness.manager.createInstance({
      workingDirectory: '/tmp/project',
      provider: 'claude',
    });
    await instance.readyPromise;

    const expected = [
      agent.systemPrompt,
      'Output style — Concise: minimize prose. Prefer short, direct answers, bullet points, and code over explanation. Skip pleasantries and do not restate the question. Lead with the answer.',
      'Past reflection: prefer const bindings.',
      'Project: ai-orchestrator. Electron + Angular desktop app.',
      '## Lessons\n- Always run tsc --noEmit before claiming done.',
      buildToolPermissionPrompt(instance.yoloMode),
    ].join(SYSTEM_PROMPT_BLOCK_SEPARATOR);

    expect(mocks.createAdapter).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ systemPrompt: expected }),
      }),
    );
  });
});
