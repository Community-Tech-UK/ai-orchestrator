import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function flushMicrotasks(times = 8): Promise<void> {
  for (let index = 0; index < times; index++) {
    await Promise.resolve();
  }
}

describe('context worker main', () => {
  const startHotPrewarm = vi.fn(() => true);
  const cancelHotPrewarm = vi.fn(() => true);
  const residencySnapshot = {
    processRole: 'context-worker',
    counts: {
      durableStores: 3,
      durableSections: 5,
      activeSessions: 1,
      residentMetadataSections: 2,
      deferredMetadataSections: 3,
      residentContentSections: 1,
      residentContentStores: 1,
      metadataOnlyStores: 2,
      deferredStores: 2,
    },
    discoveredStores: 3,
    activeSessions: 1,
    startupContentBytes: 0,
    residentMetadataSections: 2,
    deferredMetadataSections: 3,
    residentContentBytes: 12,
    residentContentSections: 1,
    residentContentStores: 1,
    hotCandidates: 2,
    hotAdmitted: 1,
    hotSkipped: 0,
    hotExhausted: 0,
    hotCancelled: 1,
    semanticDiscovered: 3,
    semanticIndexed: 2,
    semanticSkipped: 0,
    semanticFailed: 1,
    semanticRetried: 1,
    metadataOnlyStores: 2,
    deferredStores: 2,
    exhausted: {
      metadata: false,
      contentBytes: false,
      contentSections: false,
      contentStores: false,
    },
    elapsedMs: 4,
    lastAdmissionFailure: { reason: 'store-not-found' },
  } as const;
  const getResidencyStats = vi.fn(() => residencySnapshot);
  const on = vi.fn();
  const rlmManager = { startHotPrewarm, cancelHotPrewarm, getResidencyStats, on };
  const handleRlmWorkerRequest = vi.fn();
  const recordTaskOutcome = vi.fn();
  const unifiedMemoryController = { recordTaskOutcome };
  const handleUnifiedMemoryWorkerRequest = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.doMock('../register-aliases', () => ({}));
    vi.doMock('../register-aliases.ts', () => ({}));
    vi.doMock('node:worker_threads', () => ({
      default: { parentPort: null, isMainThread: true, workerData: null },
      parentPort: null,
      isMainThread: true,
      workerData: null,
    }));
    vi.doMock('../instance-context', () => ({
      InstanceContextManager: vi.fn(() => ({
        buildRlmContext: vi.fn().mockResolvedValue({
          context: 'from rlm',
          tokens: 2,
          sectionsAccessed: [],
          durationMs: 1,
          source: 'semantic',
        }),
        initializeRlm: vi.fn().mockResolvedValue(undefined),
        endRlmSession: vi.fn(),
        ingestToRLM: vi.fn(),
        ingestToUnifiedMemory: vi.fn(),
        buildUnifiedMemoryContext: vi.fn().mockResolvedValue(null),
        compactContext: vi.fn().mockResolvedValue(undefined),
        ingestInitialOutputToRlm: vi.fn().mockResolvedValue(undefined),
      })),
    }));
    vi.doMock('../../persistence/rlm-database', () => ({
      RLMDatabase: { getInstance: vi.fn(() => ({})) },
    }));
    vi.doMock('../../rlm/context-manager', () => ({
      RLMContextManager: {
        getInstance: vi.fn(() => rlmManager),
      },
    }));
    vi.doMock('../rlm-worker-request-handler', () => ({ handleRlmWorkerRequest }));
    vi.doMock('../unified-memory-worker-request-handler', () => ({
      handleUnifiedMemoryWorkerRequest,
    }));
    vi.doMock('../context-worker-event-forwarding', () => ({
      registerWorkerEventForwarding: vi.fn(),
    }));
    vi.doMock('../../memory/wake-context-builder', () => ({
      // LT-206: registerWorkerEventForwarding() subscribes to
      // 'wake:context-generated' at module load, so the mock must expose the
      // EventEmitter surface the real WakeContextBuilder has (it extends
      // EventEmitter), not just getWakeUpText().
      getWakeContextBuilder: () => ({ getWakeUpText: vi.fn(() => 'wake text'), on: vi.fn(), emit: vi.fn() }),
    }));
    vi.doMock('../../mcp/mcp-runtime-tool-context', () => ({
      buildMcpRuntimeToolContextSelection: vi.fn(() => ({
        serverSummaries: [],
        selectedToolIds: [],
        deferredToolCount: 0,
      })),
    }));
    vi.doMock('../../observation/policy-adapter', () => ({
      getPolicyAdapter: () => ({ buildObservationContext: vi.fn().mockResolvedValue(null) }),
    }));
    vi.doMock('../../memory/project-memory-brief-worker', () => ({
      buildProjectMemoryBriefInWorker: vi.fn().mockResolvedValue(null),
    }));
    vi.doMock('../../memory/unified-controller', () => ({
      getUnifiedMemory: () => unifiedMemoryController,
    }));
    vi.doMock('../../learning/learning-state-snapshots', () => ({
      loadHabitTrackerStateSnapshot: vi.fn(() => null),
      loadMetricsCollectorStateSnapshot: vi.fn(() => null),
      loadOutcomeTrackerStateSnapshot: vi.fn(() => null),
    }));
  });

  it('publishes the clone-safe authoritative residency snapshot with worker readiness', async () => {
    const send = vi.fn();
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');
    const originalOn = process.on.bind(process);
    Object.defineProperty(process, 'send', { configurable: true, value: send });
    vi.spyOn(process, 'on').mockImplementation((eventName, listener) => {
      if (eventName === 'message') return process;
      return originalOn(eventName, listener);
    });

    try {
      await import('../context-worker-main');

      expect(send).toHaveBeenCalledWith({
        type: 'worker-metrics',
        residency: residencySnapshot,
      });
      expect(send).toHaveBeenCalledWith({ type: 'ready' });
      expect(on).toHaveBeenCalledWith('residency:stats', expect.any(Function));
      expect(() => structuredClone(send.mock.calls[0]?.[0])).not.toThrow();
      expect(JSON.stringify(send.mock.calls)).not.toContain('storeId');
    } finally {
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor);
      } else {
        Reflect.deleteProperty(process, 'send');
      }
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('../register-aliases');
    vi.doUnmock('../register-aliases.ts');
    vi.doUnmock('node:worker_threads');
  });

  it('accepts child-process IPC when launched outside worker_threads', async () => {
    const send = vi.fn();
    const handlers: ((message: unknown) => void)[] = [];
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');
    const originalOn = process.on.bind(process);
    Object.defineProperty(process, 'send', { configurable: true, value: send });
    vi.spyOn(process, 'on').mockImplementation((eventName, listener) => {
      if (eventName === 'message') {
        handlers.push(listener as (message: unknown) => void);
        return process;
      }
      return originalOn(eventName, listener);
    });
    process.env['AIO_USER_DATA_PATH'] = '/tmp/aio-context-child-test';

    try {
      await import('../context-worker-main');
      expect(handlers).toHaveLength(1);
      handlers[0]?.({
        type: 'build-rlm-context',
        id: 42,
        instanceId: 'inst-1',
        query: 'query',
        maxTokens: 100,
        topK: 3,
      });
      await flushMicrotasks();

      expect(send).toHaveBeenCalledWith({ type: 'ready' });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'rpc-response',
        id: 42,
        result: expect.objectContaining({ context: 'from rlm' }),
      }));
    } finally {
      delete process.env['AIO_USER_DATA_PATH'];
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor);
      } else {
        Reflect.deleteProperty(process, 'send');
      }
    }
  });

  it('routes clone-safe hot-prewarm start, cancel, and shutdown cancellation to the RLM owner', async () => {
    const send = vi.fn();
    const handlers: ((message: unknown) => void)[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');
    const originalOn = process.on.bind(process);
    Object.defineProperty(process, 'send', { configurable: true, value: send });
    vi.spyOn(process, 'on').mockImplementation((eventName, listener) => {
      if (eventName === 'message') {
        handlers.push(listener as (message: unknown) => void);
        return process;
      }
      return originalOn(eventName, listener);
    });

    try {
      await import('../context-worker-main');
      handlers[0]?.({ type: 'start-hot-prewarm', id: 51 });
      handlers[0]?.({ type: 'cancel-hot-prewarm' });
      handlers[0]?.({ type: 'shutdown', id: 52 });
      await flushMicrotasks();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(startHotPrewarm).toHaveBeenCalledOnce();
      expect(cancelHotPrewarm).toHaveBeenCalledTimes(2);
      expect(exit).toHaveBeenCalledWith(0);
      expect(send).toHaveBeenCalledWith({
        type: 'rpc-response', id: 51, result: true, error: undefined,
      });
    } finally {
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor);
      } else {
        Reflect.deleteProperty(process, 'send');
      }
    }
  });

  it('records one task outcome through the worker-local unified memory controller without an RPC response', async () => {
    const send = vi.fn();
    const handlers: ((message: unknown) => void)[] = [];
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');
    const originalOn = process.on.bind(process);
    Object.defineProperty(process, 'send', { configurable: true, value: send });
    vi.spyOn(process, 'on').mockImplementation((eventName, listener) => {
      if (eventName === 'message') {
        handlers.push(listener as (message: unknown) => void);
        return process;
      }
      return originalOn(eventName, listener);
    });

    try {
      await import('../context-worker-main');
      handlers[0]?.({
        type: 'record-task-outcome',
        taskId: 'task-outcome-47',
        success: true,
        score: 0.75,
      });
      await flushMicrotasks();

      expect(recordTaskOutcome).toHaveBeenCalledOnce();
      expect(recordTaskOutcome).toHaveBeenCalledWith('task-outcome-47', true, 0.75);
      expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'rpc-response' }));
    } finally {
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor);
      } else {
        Reflect.deleteProperty(process, 'send');
      }
    }
  });

  it('routes RLM requests through the worker-local manager and responds with serialized results', async () => {
    const send = vi.fn();
    const handlers: ((message: unknown) => void)[] = [];
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');
    const originalOn = process.on.bind(process);
    Object.defineProperty(process, 'send', { configurable: true, value: send });
    vi.spyOn(process, 'on').mockImplementation((eventName, listener) => {
      if (eventName === 'message') {
        handlers.push(listener as (message: unknown) => void);
        return process;
      }
      return originalOn(eventName, listener);
    });
    const request = { kind: 'list-stores' as const };
    const result = [{ id: 'store-1', sections: [] }];
    handleRlmWorkerRequest.mockResolvedValueOnce(result);

    try {
      await import('../context-worker-main');
      handlers[0]?.({ type: 'rlm-request', id: 61, request });
      await flushMicrotasks();

      expect(handleRlmWorkerRequest).toHaveBeenCalledWith(rlmManager, request);
      expect(send).toHaveBeenCalledWith({
        type: 'rpc-response', id: 61, result, error: undefined,
      });
    } finally {
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor);
      } else {
        Reflect.deleteProperty(process, 'send');
      }
    }
  });

  it('routes unified-memory requests through the worker-local controller', async () => {
    const send = vi.fn();
    const handlers: ((message: unknown) => void)[] = [];
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');
    const originalOn = process.on.bind(process);
    Object.defineProperty(process, 'send', { configurable: true, value: send });
    vi.spyOn(process, 'on').mockImplementation((eventName, listener) => {
      if (eventName === 'message') {
        handlers.push(listener as (message: unknown) => void);
        return process;
      }
      return originalOn(eventName, listener);
    });
    const request = { kind: 'get-stats' as const };
    const result = { shortTermTokens: 10, longTermEntries: 2 };
    handleUnifiedMemoryWorkerRequest.mockResolvedValueOnce(result);

    try {
      await import('../context-worker-main');
      handlers[0]?.({ type: 'unified-memory-request', id: 64, request });
      await flushMicrotasks();

      expect(handleUnifiedMemoryWorkerRequest).toHaveBeenCalledWith(
        unifiedMemoryController,
        request,
      );
      expect(send).toHaveBeenCalledWith({
        type: 'rpc-response', id: 64, result, error: undefined,
      });
    } finally {
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor);
      } else {
        Reflect.deleteProperty(process, 'send');
      }
    }
  });

  it('returns RLM request failures through the existing RPC error envelope', async () => {
    const send = vi.fn();
    const handlers: ((message: unknown) => void)[] = [];
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');
    Object.defineProperty(process, 'send', { configurable: true, value: send });
    vi.spyOn(process, 'on').mockImplementation((eventName, listener) => {
      if (eventName === 'message') {
        handlers.push(listener as (message: unknown) => void);
      }
      return process;
    });
    handleRlmWorkerRequest.mockRejectedValueOnce(new Error('store listing failed'));

    try {
      await import('../context-worker-main');
      handlers[0]?.({ type: 'rlm-request', id: 62, request: { kind: 'list-stores' } });
      await flushMicrotasks();

      expect(send).toHaveBeenCalledWith({
        type: 'rpc-response', id: 62, result: undefined, error: 'store listing failed',
      });
    } finally {
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor);
      } else {
        Reflect.deleteProperty(process, 'send');
      }
    }
  });

  it('returns the worker-local load and residency snapshot from get-stats', async () => {
    const send = vi.fn();
    const handlers: ((message: unknown) => void)[] = [];
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');
    Object.defineProperty(process, 'send', { configurable: true, value: send });
    vi.spyOn(process, 'on').mockImplementation((eventName, listener) => {
      if (eventName === 'message') {
        handlers.push(listener as (message: unknown) => void);
      }
      return process;
    });

    try {
      await import('../context-worker-main');
      getResidencyStats.mockClear();
      handlers[0]?.({ type: 'get-stats', id: 63 });
      await flushMicrotasks();

      // The RPC result and the post-operation worker-metrics refresh both read
      // the same authoritative snapshot.
      expect(getResidencyStats).toHaveBeenCalledTimes(2);
      expect(send).toHaveBeenCalledWith({
        type: 'rpc-response',
        id: 63,
        result: residencySnapshot,
        error: undefined,
      });
      expect(JSON.stringify(send.mock.calls)).not.toContain('storeId');
    } finally {
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor);
      } else {
        Reflect.deleteProperty(process, 'send');
      }
    }
  });

  it('LT-480: pre-initialises RLMDatabase with explicit dbPath before wiring worker event forwarding', async () => {
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');
    Object.defineProperty(process, 'send', { configurable: true, value: vi.fn() });
    vi.spyOn(process, 'on').mockImplementation(() => process);
    process.env['AIO_USER_DATA_PATH'] = '/tmp/aio-context-ordering-test';

    try {
      await import('../context-worker-main');

      const { RLMDatabase } = await import('../../persistence/rlm-database');
      const { registerWorkerEventForwarding } = await import('../context-worker-event-forwarding');
      const getInstanceMock = RLMDatabase.getInstance as unknown as ReturnType<typeof vi.fn>;
      const forwardingMock = registerWorkerEventForwarding as unknown as ReturnType<typeof vi.fn>;

      expect(getInstanceMock).toHaveBeenCalled();
      expect(forwardingMock).toHaveBeenCalled();

      // RLMDatabase.getInstance() must be called with the real dbPath/contentDir
      // before this entrypoint resolves RLMContextManager at the forwarding
      // call site. Its eager, no-config getRLMDatabase() call would otherwise
      // win the singleton race and pin the worker to the fallback path instead
      // of this profile's userData path (LT-480).
      const firstGetInstanceCall = getInstanceMock.mock.calls[0]?.[0] as
        | { dbPath?: string }
        | undefined;
      expect(firstGetInstanceCall?.dbPath).toContain('aio-context-ordering-test');
      expect(getInstanceMock.mock.invocationCallOrder[0]).toBeLessThan(
        forwardingMock.mock.invocationCallOrder[0],
      );
    } finally {
      delete process.env['AIO_USER_DATA_PATH'];
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor);
      } else {
        Reflect.deleteProperty(process, 'send');
      }
    }
  });
});
