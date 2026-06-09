import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function flushMicrotasks(times = 8): Promise<void> {
  for (let index = 0; index < times; index++) {
    await Promise.resolve();
  }
}

describe('context worker main', () => {
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
    vi.doMock('../../memory/wake-context-builder', () => ({
      getWakeContextBuilder: () => ({ getWakeUpText: vi.fn(() => 'wake text') }),
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
});
