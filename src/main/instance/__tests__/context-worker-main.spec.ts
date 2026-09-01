import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function flushMicrotasks(times = 8): Promise<void> {
  for (let index = 0; index < times; index++) {
    await Promise.resolve();
  }
}

describe('context worker main', () => {
  const startHotPrewarm = vi.fn(() => true);
  const cancelHotPrewarm = vi.fn(() => true);

  beforeEach(() => {
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
        getInstance: vi.fn(() => ({ startHotPrewarm, cancelHotPrewarm })),
      },
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
    vi.doMock('../../learning/learning-state-snapshots', () => ({
      loadHabitTrackerStateSnapshot: vi.fn(() => null),
      loadMetricsCollectorStateSnapshot: vi.fn(() => null),
      loadOutcomeTrackerStateSnapshot: vi.fn(() => null),
    }));
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
      // BEFORE registerWorkerEventForwarding() runs — otherwise
      // RLMContextManager's eager, no-config getRLMDatabase() call (triggered
      // from inside registerWorkerEventForwarding) wins the getInstance()
      // singleton race and permanently pins the RLM database to its
      // process.cwd()-hashed fallback path instead of this worker's real
      // per-profile userData path (LT-480).
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
