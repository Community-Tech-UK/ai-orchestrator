import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, OutputMessage } from '../../../shared/types/instance.types';
import type { InstanceContextPort } from '../instance-context-port';
import type { RlmContextInfo, UnifiedMemoryContextInfo } from '../instance-types';
import type { IndexedCodebaseContextInfo } from '../../indexing/indexed-codebase-context';

const CONTEXT_DEADLINE_MS = 500;

const {
  mockCommunicationSendInput,
  mockCommandExecuteCommandString,
  mockIndexedBuildContext,
  mockIndexedFormatContextBlock,
  mockPromptHistoryRecord,
  mockQueueContinuityPreamble,
  mockQueueUpdate,
  mockGetSchedulingReminder,
  mockStateInstances,
  MockEmitter,
} = vi.hoisted(() => ({
  mockCommunicationSendInput: vi.fn(),
  mockCommandExecuteCommandString: vi.fn(),
  mockIndexedBuildContext: vi.fn(),
  mockIndexedFormatContextBlock: vi.fn(),
  mockPromptHistoryRecord: vi.fn(),
  mockQueueContinuityPreamble: vi.fn(),
  mockQueueUpdate: vi.fn(),
  mockGetSchedulingReminder: vi.fn(),
  mockStateInstances: new Map<string, Instance>(),
  MockEmitter: class {
    on(): this { return this; }
    emit(): boolean { return false; }
    removeListener(): this { return this; }
  },
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/test'),
    isPackaged: false,
  },
}));

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    get: vi.fn(),
    set: vi.fn(),
    store: {},
  })),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
}));

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: vi.fn(() => ({
    getAll: vi.fn(() => ({
      allowNestedOrchestration: false,
      maxChildrenPerParent: 10,
      maxTotalInstances: 20,
      outputBufferSize: 500,
    })),
    on: vi.fn(),
  })),
}));

vi.mock('../../commands/command-manager', () => ({
  getCommandManager: vi.fn(() => ({
    executeCommandString: mockCommandExecuteCommandString,
  })),
}));

vi.mock('../../prompt-history/prompt-history-service', () => ({
  getPromptHistoryService: vi.fn(() => ({
    record: mockPromptHistoryRecord,
  })),
}));

vi.mock('../../indexing/indexed-codebase-context', () => ({
  getIndexedCodebaseContextService: vi.fn(() => ({
    buildContext: mockIndexedBuildContext,
    formatContextBlock: mockIndexedFormatContextBlock,
  })),
}));

vi.mock('../../pause/pause-coordinator', () => ({
  getPauseCoordinator: vi.fn(() => ({
    isPaused: vi.fn(() => false),
    on: vi.fn(),
    removeListener: vi.fn(),
  })),
  OrchestratorPausedError: class OrchestratorPausedError extends Error {},
}));

vi.mock('../../plugins/hook-emitter', () => ({
  emitPluginHook: vi.fn(),
}));

vi.mock('../../process/resource-governor', () => ({
  getResourceGovernor: vi.fn(() => ({
    getCreationBlockReason: vi.fn(() => null),
  })),
}));

vi.mock('../../orchestration/task-manager', () => ({
  getTaskManager: vi.fn(() => ({
    startTimeoutChecker: vi.fn(),
    stopTimeoutChecker: vi.fn(),
  })),
}));

vi.mock('../../context/compaction-coordinator.js', () => ({
  getCompactionCoordinator: vi.fn(() => ({
    compactInstance: vi.fn().mockResolvedValue(undefined),
    getBudgetTracker: vi.fn(() => undefined),
  })),
}));

vi.mock('../../session/session-continuity', () => ({
  getSessionContinuityManager: vi.fn(() => ({
    createSnapshot: vi.fn(),
    updateState: vi.fn(),
  })),
}));

vi.mock('../../security/permission-enforcer', () => ({
  getPermissionEnforcer: vi.fn(() => ({
    recordUserDecision: vi.fn(),
  })),
}));

vi.mock('../../security/permission-manager', () => ({
  getPermissionManager: vi.fn(() => ({
    loadProjectRules: vi.fn(),
  })),
}));

vi.mock('../../security/tool-execution-gate', () => ({
  getToolExecutionGate: vi.fn(() => ({
    evaluate: vi.fn(() => ({
      action: 'ask',
      reason: 'test',
      source: 'test',
      permission: { action: 'prompt', reason: 'test', mode: 'default' },
    })),
  })),
}));

vi.mock('../../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: vi.fn(() => ({
    createAdapter: vi.fn(),
  })),
}));

vi.mock('../../providers/provider-output-event', () => ({
  toProviderOutputEvent: vi.fn((message: OutputMessage) => ({
    kind: 'output',
    messageType: message.type,
    content: message.content,
  })),
}));

vi.mock('../../cli/adapters/adapter-factory', () => ({
  resolveCliType: vi.fn().mockResolvedValue('claude'),
}));

vi.mock('../../cli/adapters/base-cli-adapter', () => ({
  BaseCliAdapter: class {},
}));

vi.mock('../../remote-node/worker-node-registry', () => ({
  getWorkerNodeRegistry: vi.fn(() => ({
    getHealthyNodes: vi.fn(() => []),
  })),
}));

vi.mock('../instance-state', () => {
  class InstanceStateManager extends MockEmitter {
    getInstance(id: string): Instance | undefined {
      return mockStateInstances.get(id);
    }

    getAllInstances(): Instance[] {
      return [...mockStateInstances.values()];
    }

    getInstanceCount(): number {
      return mockStateInstances.size;
    }

    getAdapter(): undefined {
      return undefined;
    }

    setAdapter(): void { return undefined; }
    deleteAdapter(): boolean { return true; }
    getDiffTracker(): undefined { return undefined; }
    setDiffTracker(): void { return undefined; }
    deleteDiffTracker(): void { return undefined; }
    getStateMachine(): undefined { return undefined; }
    setStateMachine(): void { return undefined; }
    deleteStateMachine(): void { return undefined; }
    setInstance(instance: Instance): void { mockStateInstances.set(instance.id, instance); }
    deleteInstance(id: string): boolean { return mockStateInstances.delete(id); }
    destroy(): void { return undefined; }
    serializeForIpc(instance: Instance): Record<string, unknown> { return { id: instance.id }; }
    getAllInstancesForIpc(): Record<string, unknown>[] { return []; }
    queueUpdate(...args: unknown[]): void { mockQueueUpdate(...args); }
  }

  return { InstanceStateManager };
});

vi.mock('../instance-communication', () => {
  class InstanceCommunicationManager extends MockEmitter {
    sendInput = mockCommunicationSendInput;
    queueContinuityPreamble = mockQueueContinuityPreamble;
    setupAdapterEvents(): void { return undefined; }
    markInterrupted(): void { return undefined; }
    clearInterrupted(): void { return undefined; }
    cleanupCircuitBreaker(): void { return undefined; }
    cleanupToolResultDedup(): void { return undefined; }
    sendInputResponse(): Promise<void> { return Promise.resolve(); }
    addToOutputBuffer(instance: Instance, message: OutputMessage): void {
      instance.outputBuffer.push(message);
    }
  }

  return { InstanceCommunicationManager };
});

vi.mock('../instance-lifecycle', () => {
  class InstanceLifecycleManager extends MockEmitter {
    transitionStatePublic(instance: Instance, status: Instance['status']): void {
      instance.status = status;
    }

    createInstance(): Promise<Instance> { return Promise.reject(new Error('not implemented')); }
    terminateInstance(): Promise<void> { return Promise.resolve(); }
    restartInstance(): Promise<void> { return Promise.resolve(); }
    restartFreshInstance(): Promise<void> { return Promise.resolve(); }
    terminateAll(): Promise<void> { return Promise.resolve(); }
    renameInstance(): void { return undefined; }
    changeAgentMode(): Promise<Instance> { return Promise.reject(new Error('not implemented')); }
    toggleYoloMode(): Promise<Instance> { return Promise.reject(new Error('not implemented')); }
    resumeAfterDeferredPermission(): Promise<void> { return Promise.resolve(); }
    changeModel(): Promise<Instance> { return Promise.reject(new Error('not implemented')); }
    interruptInstance(): boolean { return true; }
    hibernateInstance(): Promise<void> { return Promise.resolve(); }
    wakeInstance(): Promise<void> { return Promise.resolve(); }
    enterPlanMode(): Instance { throw new Error('not implemented'); }
    exitPlanMode(): Instance { throw new Error('not implemented'); }
    approvePlan(): Instance { throw new Error('not implemented'); }
    updatePlanContent(): Instance { throw new Error('not implemented'); }
    getPlanModeState(): { enabled: boolean; state: string } { return { enabled: false, state: 'idle' }; }
    respawnAfterInterrupt(): Promise<void> { return Promise.resolve(); }
    respawnAfterUnexpectedExit(): Promise<void> { return Promise.resolve(); }
    getMemoryStats(): Record<string, unknown> { return {}; }
    destroy(): void { return undefined; }
  }

  return { InstanceLifecycleManager };
});

vi.mock('../instance-orchestration', () => {
  class InstanceOrchestrationManager {
    setupOrchestrationHandlers(): void { return undefined; }
    processOrchestrationOutput(): void { return undefined; }
    registerInstance(): void { return undefined; }
    unregisterInstance(): void { return undefined; }
    hasActiveWork(): boolean { return false; }
    getOrchestrationPrompt(): string { return '[ORCHESTRATION PROMPT]'; }
    getSchedulingReminderIfRelevant(message: string): string | null {
      return mockGetSchedulingReminder(message) as string | null;
    }
    getOrchestrationHandler(): Record<string, unknown> {
      return {
        getPendingUserActionsForInstance: vi.fn(() => []),
        respondToUserAction: vi.fn(),
      };
    }
  }

  return { InstanceOrchestrationManager };
});

vi.mock('../instance-persistence', () => ({
  InstancePersistenceManager: class {
    forkInstance(): Promise<Instance> { return Promise.reject(new Error('not implemented')); }
    exportSession(): Record<string, unknown> { return {}; }
    exportSessionMarkdown(): string { return ''; }
    importSession(): Promise<Instance> { return Promise.reject(new Error('not implemented')); }
    loadHistoricalOutput(): Promise<OutputMessage[]> { return Promise.resolve([]); }
    getInstanceStorageStats(): Record<string, unknown> { return {}; }
  },
}));

vi.mock('../instance-event-aggregator', () => ({
  InstanceEventAggregator: class {
    recordCreated(): Record<string, unknown> { return {}; }
    recordRemoved(): Record<string, unknown> { return {}; }
    recordStateUpdate(): Record<string, unknown> { return {}; }
  },
}));

vi.mock('../instance-settled-tracker', () => ({
  InstanceSettledTracker: class {
    recordActivity(): void { return undefined; }
    clear(): void { return undefined; }
    destroy(): void { return undefined; }
    waitForSettled(): Promise<undefined> { return Promise.resolve(undefined); }
  },
}));

vi.mock('../instance-child-completion-handler', () => ({
  InstanceChildCompletionHandler: class {
    handleChildExit(): Promise<void> { return Promise.resolve(); }
  },
}));

vi.mock('../warm-start-manager', () => ({
  WarmStartManager: class {},
}));

vi.mock('../stuck-process-detector', () => ({
  StuckProcessDetector: class extends MockEmitter {
    recordOutput(): void { return undefined; }
    updateState(): void { return undefined; }
    startTracking(): void { return undefined; }
    stopTracking(): void { return undefined; }
  },
}));

vi.mock('../stale-runtime-reconciler', () => ({
  StaleRuntimeReconciler: {
    getInstance: vi.fn(() => ({})),
  },
}));

vi.mock('../auto-title-service', () => ({
  getAutoTitleService: vi.fn(() => ({
    maybeGenerateTitle: vi.fn().mockResolvedValue(undefined),
    clearInstance: vi.fn(),
  })),
}));

vi.mock('../instance-deps', () => ({
  productionCoreDeps: vi.fn(() => undefined),
}));

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    sessionId: 'session-1',
    displayName: 'Test Instance',
    workingDirectory: '/tmp/project',
    status: 'idle',
    provider: 'claude',
    currentModel: 'sonnet',
    requestCount: 0,
    lastActivity: 0,
    outputBuffer: [
      {
        id: 'prior-user',
        timestamp: 1,
        type: 'user',
        content: 'prior turn',
      },
    ],
    contextUsage: { used: 0, total: 1000, percentage: 0 },
    parentId: null,
    childrenIds: [],
    processId: 123,
    errorCount: 0,
    restartCount: 0,
    yoloMode: false,
    isRenamed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastOutputAt: Date.now(),
    metadata: {},
    ...overrides,
  } as Instance;
}

function createContextPort(overrides: Partial<InstanceContextPort> = {}): InstanceContextPort {
  return {
    initializeRlm: vi.fn().mockResolvedValue(undefined),
    endRlmSession: vi.fn(),
    ingestInitialOutputToRlm: vi.fn().mockResolvedValue(undefined),
    ingestToRLM: vi.fn(),
    ingestToUnifiedMemory: vi.fn(),
    calculateContextBudget: vi.fn(() => ({
      totalTokens: 1000,
      rlmMaxTokens: 300,
      unifiedMaxTokens: 300,
      rlmTopK: 2,
    })),
    buildRlmContext: vi.fn().mockResolvedValue(null),
    buildUnifiedMemoryContext: vi.fn().mockResolvedValue(null),
    formatRlmContextBlock: vi.fn((context: RlmContextInfo | null) =>
      context ? `[RLM]\n${context.context}` : null
    ),
    formatUnifiedMemoryContextBlock: vi.fn((context: UnifiedMemoryContextInfo | null) =>
      context ? `[Memory]\n${context.context}` : null
    ),
    compactContext: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('InstanceManager context deadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockStateInstances.clear();
    mockCommunicationSendInput.mockResolvedValue(undefined);
    mockCommandExecuteCommandString.mockReset();
    mockCommandExecuteCommandString.mockResolvedValue(null);
    mockIndexedBuildContext.mockResolvedValue(null);
    mockIndexedFormatContextBlock.mockReturnValue('[Indexed]\nindex context');
    mockGetSchedulingReminder.mockReset();
    mockGetSchedulingReminder.mockReturnValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sendInput completes within the context deadline when context builders hang', async () => {
    const { InstanceManager } = await import('../instance-manager');
    const contextPort = createContextPort({
      buildRlmContext: vi.fn(() => new Promise(() => undefined)),
      buildUnifiedMemoryContext: vi.fn(() => new Promise(() => undefined)),
    });
    mockIndexedBuildContext.mockImplementation(() => new Promise(() => undefined));
    const instance = makeInstance();
    mockStateInstances.set(instance.id, instance);
    const manager = new InstanceManager(undefined, contextPort);

    const sendPromise = manager.sendInput(instance.id, 'current message');
    await vi.advanceTimersByTimeAsync(CONTEXT_DEADLINE_MS + 100);
    await flushMicrotasks();

    expect(mockCommunicationSendInput).toHaveBeenCalledTimes(1);
    await expect(sendPromise).resolves.toBeUndefined();
  });

  it('passes the context block to communication.sendInput when context resolves within the deadline', async () => {
    const { InstanceManager } = await import('../instance-manager');
    const rlmContext: RlmContextInfo = {
      context: 'rlm context',
      tokens: 10,
      sectionsAccessed: ['s1'],
      durationMs: 3,
      source: 'semantic',
    };
    const unifiedContext: UnifiedMemoryContextInfo = {
      context: 'memory context',
      tokens: 11,
      longTermCount: 1,
      proceduralCount: 0,
      durationMs: 4,
    };
    const indexedContext = {
      context: 'index context',
      tokens: 12,
      storeId: 'store-1',
      workspacePath: '/tmp/project',
      results: [],
      durationMs: 5,
    } satisfies IndexedCodebaseContextInfo;
    const contextPort = createContextPort({
      buildRlmContext: vi.fn().mockResolvedValue(rlmContext),
      buildUnifiedMemoryContext: vi.fn().mockResolvedValue(unifiedContext),
    });
    mockIndexedBuildContext.mockResolvedValue(indexedContext);
    const instance = makeInstance();
    mockStateInstances.set(instance.id, instance);
    const manager = new InstanceManager(undefined, contextPort);

    await manager.sendInput(instance.id, 'current message');

    const contextBlock = mockCommunicationSendInput.mock.calls[0]?.[3] as string | null;
    expect(contextBlock).toContain('[Memory]\nmemory context');
    expect(contextBlock).toContain('[Indexed]\nindex context');
    expect(contextBlock).toContain('[RLM]\nrlm context');
  });

  it('passes null as contextBlock when context exceeds the deadline', async () => {
    const { InstanceManager } = await import('../instance-manager');
    const contextPort = createContextPort({
      buildRlmContext: vi.fn(() => new Promise(() => undefined)),
      buildUnifiedMemoryContext: vi.fn(() => new Promise(() => undefined)),
    });
    mockIndexedBuildContext.mockImplementation(() => new Promise(() => undefined));
    const instance = makeInstance();
    mockStateInstances.set(instance.id, instance);
    const manager = new InstanceManager(undefined, contextPort);

    const sendPromise = manager.sendInput(instance.id, 'current message');
    await vi.advanceTimersByTimeAsync(CONTEXT_DEADLINE_MS + 100);
    await sendPromise;

    expect(mockCommunicationSendInput.mock.calls[0]?.[3]).toBeNull();
  });

  it('queues late context for the next turn after sending without it', async () => {
    const { InstanceManager } = await import('../instance-manager');
    const rlm = deferred<RlmContextInfo | null>();
    const unified = deferred<UnifiedMemoryContextInfo | null>();
    const indexed = deferred<IndexedCodebaseContextInfo | null>();
    const contextPort = createContextPort({
      buildRlmContext: vi.fn(() => rlm.promise),
      buildUnifiedMemoryContext: vi.fn(() => unified.promise),
    });
    mockIndexedBuildContext.mockImplementation(() => indexed.promise);
    const instance = makeInstance();
    mockStateInstances.set(instance.id, instance);
    const manager = new InstanceManager(undefined, contextPort);

    const sendPromise = manager.sendInput(instance.id, 'current message');
    await vi.advanceTimersByTimeAsync(CONTEXT_DEADLINE_MS + 100);
    await sendPromise;
    expect(mockCommunicationSendInput.mock.calls[0]?.[3]).toBeNull();

    rlm.resolve({
      context: 'late rlm context',
      tokens: 10,
      sectionsAccessed: ['s1'],
      durationMs: 501,
      source: 'semantic',
    });
    unified.resolve(null);
    indexed.resolve(null);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(mockQueueContinuityPreamble).toHaveBeenCalledWith(
      instance.id,
      expect.stringContaining('late rlm context'),
    );
  });

  it('fails slash-command sends when command resolution exceeds the preflight deadline', async () => {
    const { InstanceManager } = await import('../instance-manager');
    mockCommandExecuteCommandString.mockImplementation(() => new Promise(() => undefined));
    const instance = makeInstance();
    mockStateInstances.set(instance.id, instance);
    const manager = new InstanceManager(undefined, createContextPort());

    const sendResult = manager
      .sendInput(instance.id, '/explain src/main/index.ts')
      .then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      );

    await vi.advanceTimersByTimeAsync(5_100);
    await flushMicrotasks();

    const result = await Promise.race([
      sendResult,
      Promise.resolve({ status: 'pending' as const }),
    ]);

    expect(result.status).toBe('rejected');
    expect(result.status === 'rejected' ? result.error : undefined).toMatchObject({
      message: expect.stringContaining('Slash command resolution timed out'),
    });
    expect(mockCommunicationSendInput).not.toHaveBeenCalled();
  });

  // makeInstance() seeds prior conversation history, so the first tracked input is
  // NOT a fresh-conversation first message — i.e. the orchestration prompt is not
  // (re)injected. This is exactly the long-conversation case where the scheduling
  // reminder must be re-surfaced.
  it('injects the scheduling reminder into the context block on a later-turn scheduling request', async () => {
    const { InstanceManager } = await import('../instance-manager');
    mockGetSchedulingReminder.mockImplementation((msg: string) =>
      msg.includes('automation') ? '[SCHED REMINDER]' : null,
    );
    const contextPort = createContextPort({
      buildRlmContext: vi.fn().mockResolvedValue(null),
      buildUnifiedMemoryContext: vi.fn().mockResolvedValue(null),
    });
    mockIndexedBuildContext.mockResolvedValue(null);
    mockIndexedFormatContextBlock.mockReturnValue(null);
    const instance = makeInstance();
    mockStateInstances.set(instance.id, instance);
    const manager = new InstanceManager(undefined, contextPort);

    await manager.sendInput(instance.id, 'please create an automation for this');

    expect(mockGetSchedulingReminder).toHaveBeenCalledWith('please create an automation for this');
    const contextBlock = mockCommunicationSendInput.mock.calls[0]?.[3] as string | null;
    expect(contextBlock).toContain('[SCHED REMINDER]');
  });

  it('prepends the reminder alongside retrieved context without dropping it', async () => {
    const { InstanceManager } = await import('../instance-manager');
    mockGetSchedulingReminder.mockReturnValue('[SCHED REMINDER]');
    const contextPort = createContextPort({
      buildRlmContext: vi.fn().mockResolvedValue({
        context: 'rlm context',
        tokens: 10,
        sectionsAccessed: ['s1'],
        durationMs: 3,
        source: 'semantic',
      } satisfies RlmContextInfo),
      buildUnifiedMemoryContext: vi.fn().mockResolvedValue(null),
    });
    mockIndexedBuildContext.mockResolvedValue(null);
    mockIndexedFormatContextBlock.mockReturnValue(null);
    const instance = makeInstance();
    mockStateInstances.set(instance.id, instance);
    const manager = new InstanceManager(undefined, contextPort);

    await manager.sendInput(instance.id, 'schedule something daily');

    const contextBlock = mockCommunicationSendInput.mock.calls[0]?.[3] as string | null;
    expect(contextBlock).toContain('[SCHED REMINDER]');
    expect(contextBlock).toContain('[RLM]\nrlm context');
  });

  it('does not inject a reminder for non-scheduling messages', async () => {
    const { InstanceManager } = await import('../instance-manager');
    mockGetSchedulingReminder.mockImplementation((msg: string) =>
      msg.includes('automation') ? '[SCHED REMINDER]' : null,
    );
    const instance = makeInstance();
    mockStateInstances.set(instance.id, instance);
    const manager = new InstanceManager(undefined, createContextPort());

    await manager.sendInput(instance.id, 'fix the failing test');

    const contextBlock = mockCommunicationSendInput.mock.calls[0]?.[3] as string | null;
    expect(contextBlock ?? '').not.toContain('[SCHED REMINDER]');
  });
});
