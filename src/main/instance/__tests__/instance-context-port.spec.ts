import { describe, it, expect, vi } from 'vitest';
import type { InstanceContextPort } from '../instance-context-port';

// ── Minimal module-level mocks ──────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test'), isPackaged: false },
}));

vi.mock('electron-store', () => ({
  default: vi.fn().mockImplementation(() => ({
    store: {},
    get: vi.fn(),
    set: vi.fn(),
    clear: vi.fn(),
    path: '/tmp/test/settings.json',
  })),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  getLogManager: vi.fn(() => ({ getLogger: vi.fn(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() })) })),
  _resetLogManagerForTesting: vi.fn(),
}));

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: vi.fn(() => ({
    get: vi.fn(),
    getAll: vi.fn(() => ({ persistSessionContent: true, defaultCli: 'auto' })),
    on: vi.fn(),
    emit: vi.fn(),
  })),
  SettingsManager: vi.fn().mockImplementation(() => ({
    get: vi.fn(),
    getAll: vi.fn(() => ({})),
    on: vi.fn(),
  })),
}));

vi.mock('../../rlm/context-manager', () => ({
  RLMContextManager: {
    getInstance: vi.fn(() => ({
      getStore: vi.fn(),
      newSession: vi.fn(() => 'sess-1'),
      endSession: vi.fn(),
      addSection: vi.fn(),
    })),
  },
}));

vi.mock('../../memory', () => ({
  getUnifiedMemory: vi.fn(() => ({ retrieve: vi.fn(), ingest: vi.fn() })),
  getMemoryMonitor: vi.fn(() => ({ on: vi.fn(), start: vi.fn(), stop: vi.fn() })),
  getOutputStorageManager: vi.fn(() => ({ store: vi.fn(), getRecent: vi.fn() })),
}));

// instance-context deep-imports getUnifiedMemory from the controller module
// (not the '../memory' barrel) so the context worker doesn't pull electron-coupled
// modules. Mock the deep path too, or the real controller loads here.
vi.mock('../../memory/unified-controller', () => ({
  getUnifiedMemory: vi.fn(() => ({ retrieve: vi.fn(), processInput: vi.fn(), ingest: vi.fn() })),
  UnifiedMemoryController: vi.fn(),
}));

vi.mock('../../context/jit-loader', () => ({
  getJITLoader: vi.fn(() => ({ registerLoader: vi.fn(), load: vi.fn() })),
  FileSystemLoader: vi.fn(),
  MemoryStoreLoader: vi.fn(),
}));

// Mocks needed for InstanceManager transitive imports
vi.mock('../../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: vi.fn(() => ({ createAdapter: vi.fn() })),
}));
vi.mock('../../observability/otel-setup', () => ({ getOrchestratorTracer: vi.fn(() => ({ startSpan: vi.fn(() => ({ end: vi.fn() })), startActiveSpan: vi.fn((_n: string, _a: unknown, fn: (s: { end: () => void; setStatus: () => void }) => unknown) => fn({ end: vi.fn(), setStatus: vi.fn() })) })) }));
vi.mock('../../observability', () => ({}));
vi.mock('../../session/session-continuity', () => ({ getSessionContinuityManager: vi.fn(() => ({ startTracking: vi.fn(), stopTracking: vi.fn(), updateState: vi.fn(), addConversationEntry: vi.fn() })) }));
vi.mock('../../session/resume-hint', () => ({ getResumeHintManager: vi.fn(() => ({ getHint: vi.fn(), saveHint: vi.fn() })) }));
vi.mock('../../util/cleanup-registry', () => ({ registerCleanup: vi.fn() }));
vi.mock('../../storage/project-storage-paths', () => ({ getProjectStoragePaths: vi.fn(() => ({ getGlobalDomainRoot: vi.fn(() => '/tmp/test'), getSessionEventLogPath: vi.fn(() => '/tmp/test/events.ndjson') })) }));
vi.mock('../../session/session-persistence-queue', () => ({ getSessionPersistenceQueue: vi.fn(() => ({ enqueueEvent: vi.fn(), enqueueSave: vi.fn(), shutdown: vi.fn() })) }));
vi.mock('../../orchestration/resource-governor', () => ({ getResourceGovernor: vi.fn(() => ({ getCreationBlockReason: vi.fn(() => null), on: vi.fn() })) }));
vi.mock('../../orchestration/orchestration-handler', () => ({ OrchestrationHandler: vi.fn().mockImplementation(() => ({ on: vi.fn(), emit: vi.fn() })) }));
vi.mock('../warm-start-manager', () => ({ WarmStartManager: vi.fn().mockImplementation(() => ({ preWarm: vi.fn(), getWarmAdapter: vi.fn(), returnAdapter: vi.fn() })) }));
vi.mock('../stuck-process-detector', () => ({ StuckProcessDetector: vi.fn().mockImplementation(() => ({ onProcessStarted: vi.fn(), onProcessEnded: vi.fn(), on: vi.fn() })) }));
vi.mock('../auto-title-service', () => ({ getAutoTitleService: vi.fn(() => ({ maybeGenerate: vi.fn(), clearInstance: vi.fn() })) }));
vi.mock('../instance-deps', () => ({ productionCoreDeps: {} }));
vi.mock('../../cli/cli-detection', () => ({ detectAllClis: vi.fn().mockResolvedValue([]) }));
vi.mock('../../process/load-balancer', () => ({ getLoadBalancer: vi.fn(() => ({ updateMetrics: vi.fn(), removeMetrics: vi.fn() })) }));
vi.mock('../../state', () => ({ getAppStore: vi.fn(), setGlobalState: vi.fn() }));
vi.mock('../../util/slow-operations', () => ({ measureAsync: vi.fn((_n: string, fn: () => unknown) => fn()), SlowOperationMonitor: vi.fn().mockImplementation(() => ({ record: vi.fn() })) }));
vi.mock('../../orchestration/task-manager', () => ({ getTaskManager: vi.fn(() => ({ startTimeoutChecker: vi.fn(), stopTimeoutChecker: vi.fn() })) }));
vi.mock('../../pause/pause-coordinator', async () => {
  const { EventEmitter } = await import('node:events');
  const coordinator = new EventEmitter();
  return { getPauseCoordinator: vi.fn(() => coordinator) };
});
vi.mock('../../cli/adapters/adapter-factory', () => ({
  resolveCliType: vi.fn().mockResolvedValue('claude'),
  getCliDisplayName: vi.fn((cliType: string) => cliType),
  createCliAdapter: vi.fn(),
}));
vi.mock('../../cli/adapters/base-cli-adapter', () => ({ BaseCliAdapter: class {} }));
vi.mock('../../context/compaction-coordinator.js', () => ({
  getCompactionCoordinator: vi.fn(() => ({ getBudgetTracker: vi.fn(), resetBudgetTracker: vi.fn() })),
}));
vi.mock('../../context/context-engine.js', () => ({
  getContextEngine: vi.fn(() => ({ ingest: vi.fn() })),
}));
vi.mock('../../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../../history/history-restore-coordinator', () => ({ getHistoryRestoreCoordinator: vi.fn(() => ({})) }));
vi.mock('../../prompt-history/prompt-history-service', () => ({ getPromptHistoryService: vi.fn(() => ({})) }));
vi.mock('../../indexing/indexed-codebase-context', () => ({
  getIndexedCodebaseContextService: vi.fn(() => ({ buildContext: vi.fn(), buildFastPathResult: vi.fn() })),
}));
vi.mock('../../commands/command-manager', () => ({ getCommandManager: vi.fn(() => ({})) }));
vi.mock('../../commands/goal-command', () => ({ appendActiveGoalContext: vi.fn((input: string) => input) }));
vi.mock('../../commands/goal-loop-command', () => ({ executeGoalLoopCommandForInstanceInput: vi.fn() }));
vi.mock('../../session/session-reference-resolver', () => ({ resolveSessionReferences: vi.fn() }));
vi.mock('../../security/action-circuit-breaker', () => ({ getActionCircuitBreaker: vi.fn(() => ({})) }));
vi.mock('../../codemem/lsp-feedback-registration', () => ({ forgetLspFeedbackInstance: vi.fn() }));
vi.mock('../../security/permission-enforcer', () => ({ getPermissionEnforcer: vi.fn(() => ({})) }));
vi.mock('../../security/permission-manager', () => ({ getPermissionManager: vi.fn(() => ({})) }));
vi.mock('../../security/tool-execution-gate', () => ({ getToolExecutionGate: vi.fn(() => ({})) }));
vi.mock('../../remote-node/worker-node-registry', () => ({
  getWorkerNodeRegistry: vi.fn(() => ({ getHealthyNodes: vi.fn(() => []) })),
  resolveWorkerNodeTarget: vi.fn(() => ({ error: 'not found' })),
}));
vi.mock('../../providers/provider-output-event', () => ({ toProviderOutputEvent: vi.fn() }));
vi.mock('../instance-state', async () => {
  const { EventEmitter } = await import('node:events');
  class MockInstanceStateManager extends EventEmitter {
    private instances = new Map<string, unknown>();
    private adapters = new Map<string, unknown>();
    private diffTrackers = new Map<string, unknown>();
    private stateMachines = new Map<string, unknown>();

    getInstance(id: string): unknown { return this.instances.get(id); }
    hasInstance(id: string): boolean { return this.instances.has(id); }
    getAllInstances(): unknown[] { return Array.from(this.instances.values()); }
    getAllInstancesForIpc(): unknown[] { return this.getAllInstances(); }
    getInstanceCount(): number { return this.instances.size; }
    setInstance(instance: { id: string }): void { this.instances.set(instance.id, instance); }
    deleteInstance(id: string): boolean { return this.instances.delete(id); }
    forEachInstance(callback: (instance: unknown, id: string) => void): void { this.instances.forEach(callback); }
    getAdapter(id: string): unknown { return this.adapters.get(id); }
    setAdapter(id: string, adapter: unknown): void { this.adapters.set(id, adapter); }
    deleteAdapter(id: string): boolean { return this.adapters.delete(id); }
    getAdapterEntries(): IterableIterator<[string, unknown]> { return this.adapters.entries(); }
    getDiffTracker(id: string): unknown { return this.diffTrackers.get(id); }
    setDiffTracker(id: string, tracker: unknown): void { this.diffTrackers.set(id, tracker); }
    deleteDiffTracker(id: string): void { this.diffTrackers.delete(id); }
    getStateMachine(id: string): unknown { return this.stateMachines.get(id); }
    setStateMachine(id: string, machine: unknown): void { this.stateMachines.set(id, machine); }
    deleteStateMachine(id: string): void { this.stateMachines.delete(id); }
    queueUpdate(): void {}
    serializeForIpc(instance: unknown): unknown { return instance; }
    destroy(): void {}
  }
  return { InstanceStateManager: MockInstanceStateManager };
});
vi.mock('../instance-lifecycle', async () => {
  const { EventEmitter } = await import('node:events');
  class MockInstanceLifecycleManager extends EventEmitter {
    transitionStatePublic(instance: { status?: string }, status: string): void { instance.status = status; }
    respawnAfterInterrupt = vi.fn().mockResolvedValue(undefined);
    respawnAfterUnexpectedExit = vi.fn().mockResolvedValue(undefined);
    noteInterruptSettled = vi.fn();
    refreshAdapterRuntimeConfig = vi.fn();
    terminateInstance = vi.fn().mockResolvedValue(undefined);
    restartInstance = vi.fn().mockResolvedValue(undefined);
    getMemoryStats = vi.fn(() => ({}));
    destroy = vi.fn();
  }
  return { InstanceLifecycleManager: MockInstanceLifecycleManager };
});
vi.mock('../instance-communication', async () => {
  const { EventEmitter } = await import('node:events');
  class MockInstanceCommunicationManager extends EventEmitter {
    addToOutputBuffer = vi.fn();
    setupAdapterEvents = vi.fn();
    markInterrupted = vi.fn();
    clearInterrupted = vi.fn();
    queueContinuityPreamble = vi.fn();
    sendInputResponse = vi.fn().mockResolvedValue(undefined);
    forceCleanupAdapter = vi.fn().mockResolvedValue(undefined);
    isInterrupted = vi.fn(() => false);
  }
  return { InstanceCommunicationManager: MockInstanceCommunicationManager };
});
vi.mock('../instance-orchestration', () => ({
  InstanceOrchestrationManager: vi.fn().mockImplementation(() => ({
    getOrchestrationHandler: vi.fn(() => ({
      hasActiveWork: vi.fn(() => false),
      getPendingUserActionsForInstance: vi.fn(() => []),
      respondToUserAction: vi.fn(),
      notifyError: vi.fn(),
    })),
    hasActiveWork: vi.fn(() => false),
    setupOrchestrationHandlers: vi.fn(),
    processOrchestrationOutput: vi.fn(),
    registerInstance: vi.fn(),
    unregisterInstance: vi.fn(),
    getSchedulingReminderIfRelevant: vi.fn(() => null),
  })),
}));
vi.mock('../instance-persistence', () => ({
  InstancePersistenceManager: vi.fn().mockImplementation(() => ({
    forkInstance: vi.fn(),
    exportSession: vi.fn(),
    exportSessionMarkdown: vi.fn(),
    importSession: vi.fn(),
    loadHistoricalOutput: vi.fn(),
    getInstanceStorageStats: vi.fn(),
  })),
}));
vi.mock('../instance-settled-tracker', () => ({
  InstanceSettledTracker: vi.fn().mockImplementation(() => ({
    clear: vi.fn(),
    recordActivity: vi.fn(),
    waitForSettled: vi.fn(),
  })),
}));
vi.mock('../instance-child-completion-handler', () => ({
  InstanceChildCompletionHandler: vi.fn().mockImplementation(() => ({ handleChildExit: vi.fn().mockResolvedValue(undefined) })),
}));
vi.mock('../stale-runtime-reconciler', () => ({
  StaleRuntimeReconciler: { getInstance: vi.fn(() => ({ reconcile: vi.fn(), shutdown: vi.fn() })), _resetForTesting: vi.fn() },
}));

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('InstanceContextPort', () => {
  it('InstanceContextManager structurally satisfies InstanceContextPort', async () => {
    const { InstanceContextManager } = await import('../instance-context');
    const mgr = new InstanceContextManager();
    const port: InstanceContextPort = mgr;

    expect(typeof port.initializeRlm).toBe('function');
    expect(typeof port.endRlmSession).toBe('function');
    expect(typeof port.ingestToRLM).toBe('function');
    expect(typeof port.ingestToUnifiedMemory).toBe('function');
    expect(typeof port.ingestInitialOutputToRlm).toBe('function');
    expect(typeof port.calculateContextBudget).toBe('function');
    expect(typeof port.buildRlmContext).toBe('function');
    expect(typeof port.buildUnifiedMemoryContext).toBe('function');
    expect(typeof port.buildWakeContextText).toBe('function');
    expect(typeof port.buildMcpRuntimeToolContextSelection).toBe('function');
    expect(typeof port.formatRlmContextBlock).toBe('function');
    expect(typeof port.formatUnifiedMemoryContextBlock).toBe('function');
    expect(typeof port.compactContext).toBe('function');
  });

  it('InstanceManager can be constructed with a fake context port', async () => {
    const { InstanceManager } = await import('../instance-manager');

    const fakePort: InstanceContextPort = {
      initializeRlm: vi.fn().mockResolvedValue(undefined),
      endRlmSession: vi.fn(),
      ingestInitialOutputToRlm: vi.fn().mockResolvedValue(undefined),
      ingestToRLM: vi.fn(),
      ingestToUnifiedMemory: vi.fn(),
      calculateContextBudget: vi.fn().mockReturnValue({
        rlmMaxTokens: 1000, rlmTopK: 5,
        unifiedMaxTokens: 500, canInjectRlm: true, canInjectUnified: true,
      }),
      buildRlmContext: vi.fn().mockResolvedValue(null),
      buildUnifiedMemoryContext: vi.fn().mockResolvedValue(null),
      buildWakeContextText: vi.fn().mockResolvedValue(null),
      buildMcpRuntimeToolContextSelection: vi.fn().mockResolvedValue(null),
      formatRlmContextBlock: vi.fn().mockReturnValue(null),
      formatUnifiedMemoryContextBlock: vi.fn().mockReturnValue(null),
      compactContext: vi.fn().mockResolvedValue(undefined),
    };

    expect(() => new InstanceManager(undefined, fakePort)).not.toThrow();
  }, 10_000);

  it('formatRlmContextBlock returns null for null input', async () => {
    const { InstanceContextManager } = await import('../instance-context');
    expect(new InstanceContextManager().formatRlmContextBlock(null)).toBeNull();
  });

  it('formatUnifiedMemoryContextBlock returns null for null input', async () => {
    const { InstanceContextManager } = await import('../instance-context');
    expect(new InstanceContextManager().formatUnifiedMemoryContextBlock(null)).toBeNull();
  });

  it('formatUnifiedMemoryContextBlock treats activated skill instructions as actionable', async () => {
    const { InstanceContextManager } = await import('../instance-context');
    const block = new InstanceContextManager().formatUnifiedMemoryContextBlock({
      context: 'Activated Skill Instructions:\nFollow the public writing rules.',
      tokens: 12,
      longTermCount: 0,
      proceduralCount: 0,
      skillCount: 1,
      durationMs: 1,
    });

    expect(block).toContain('Follow activated skill instructions when relevant.');
    expect(block).toContain('Treat memory notes as background.');
  });

  it('loads skill context for short direct triggers such as use my tone', async () => {
    const { InstanceContextManager } = await import('../instance-context');
    const mgr = new InstanceContextManager();
    const retrieve = vi.fn().mockResolvedValue({
      shortTerm: [],
      longTerm: [],
      procedural: [],
      skills: [
        '# Human Public Writing\nZero literal U+2014 characters in public drafts.',
      ],
      totalTokens: 20,
    });

    (mgr as unknown as { unifiedMemory: { retrieve: typeof retrieve } }).unifiedMemory = {
      retrieve,
    };

    const context = await mgr.buildUnifiedMemoryContext(
      { id: 'inst-1', sessionId: 'session-1' } as never,
      'use my tone',
      'task-1',
      1000,
    );

    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve.mock.calls[0]?.[2]).toMatchObject({
      types: ['skills'],
      sessionId: 'session-1',
      instanceId: 'inst-1',
      includeWakeContext: false,
    });
    expect(context?.context).toContain('Activated Skill Instructions:');
    expect(context?.context).toContain('Zero literal U+2014 characters');
    expect(context?.skillCount).toBe(1);
  });
});
