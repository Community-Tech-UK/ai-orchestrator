import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';

// ── Module-level mocks ────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test'), isPackaged: false },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  return { ...actual };
});

// ── Fake Worker ───────────────────────────────────────────────────────────────

type FakeWorker = EventEmitter & {
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};

function createFakeWorker(): FakeWorker {
  const emitter = new EventEmitter() as FakeWorker;
  emitter.postMessage = vi.fn();
  emitter.terminate = vi.fn().mockResolvedValue(0);
  return emitter;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeInstance(overrides: Partial<{
  id: string;
  sessionId: string;
  parentId: string | null;
  contextUsage: { used: number; total: number; percentage: number };
  outputBuffer: unknown[];
}> = {}) {
  return {
    id: 'inst-1',
    sessionId: 'sess-1',
    parentId: null,
    contextUsage: { used: 0, total: 0, percentage: 0 },
    outputBuffer: [],
    ...overrides,
  } as unknown as import('../../shared/types/instance.types').Instance;
}

function makeOutputMessage(overrides: Partial<{
  id: string;
  type: string;
  content: string;
  timestamp: number;
}> = {}) {
  return {
    id: 'msg-1',
    type: 'assistant',
    content: 'hello world',
    timestamp: 1000,
    ...overrides,
  } as unknown as import('../../shared/types/instance.types').OutputMessage;
}

function makeMcpSnapshot() {
  return {
    tools: [
      {
        id: 'tool-1',
        name: 'search_docs',
        description: 'Search project docs',
        serverId: 'server-1',
        serverName: 'Docs',
        inputSchema: {},
        tags: ['docs'],
        metadata: {},
      },
    ],
    serverSummaries: [
      {
        serverId: 'server-1',
        serverName: 'Docs',
        toolCount: 1,
        resourceCount: 0,
        promptCount: 0,
        searchHint: 'Search docs',
      },
    ],
    loadedToolIds: [],
    usageStats: {},
    indices: {
      byCategory: {},
      byServer: { 'server-1': ['tool-1'] },
      byTag: { docs: ['tool-1'] },
      termIndex: { search: ['tool-1'], docs: ['tool-1'] },
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ContextWorkerClient', () => {
  let fakeWorker: FakeWorker;
  let client: import('../context-worker-client').ContextWorkerClient;

  beforeEach(async () => {
    const { _resetContextWorkerClientForTesting } = await import('../context-worker-client');
    _resetContextWorkerClientForTesting();

    fakeWorker = createFakeWorker();
    const { ContextWorkerClient } = await import('../context-worker-client');
    client = new ContextWorkerClient({
      workerFactory: () => fakeWorker as unknown as Worker,
      rpcTimeoutMs: 50,
      userDataPath: '/tmp/test',
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── RPC resolution ──────────────────────────────────────────────────────────

  it('resolves RPC response by matching id', async () => {
    const initPromise = client.initializeRlm(makeInstance());

    const postedMsg = fakeWorker.postMessage.mock.calls[0]?.[0] as { id: number };
    expect(postedMsg).toBeDefined();
    expect(typeof postedMsg.id).toBe('number');

    fakeWorker.emit('message', { type: 'rpc-response', id: postedMsg.id, result: undefined });

    await expect(initPromise).resolves.toBeUndefined();
  });

  it('returns null and cleans up pending map on RPC timeout', async () => {
    const result = await client.buildRlmContext('inst-1', 'what is the plan?');
    expect(result).toBeNull();
    expect(client.getMetrics().inFlight).toBe(0);
    expect(client.getMetrics().dropped).toBeGreaterThan(0);
  });

  it('resolves buildRlmContext with worker result', async () => {
    const contextResult = {
      context: 'some rlm context',
      tokens: 10,
      sectionsAccessed: ['s1'],
      durationMs: 5,
      source: 'semantic' as const,
    };

    const promise = client.buildRlmContext('inst-1', 'query');
    const postedMsg = fakeWorker.postMessage.mock.calls[0]?.[0] as { id: number };
    fakeWorker.emit('message', { type: 'rpc-response', id: postedMsg.id, result: contextResult });

    const result = await promise;
    expect(result).toEqual(contextResult);
  });

  it('posts wake-context RPC and resolves string results', async () => {
    const promise = client.buildWakeContextText('/tmp/project');
    const postedMsg = fakeWorker.postMessage.mock.calls[0]?.[0] as {
      id: number;
      type: string;
      wing: string;
      bypassCache: boolean;
    };

    expect(postedMsg.type).toBe('build-wake-context-text');
    expect(postedMsg.wing).toBe('/tmp/project');
    expect(postedMsg.bypassCache).toBe(true);

    fakeWorker.emit('message', {
      type: 'rpc-response',
      id: postedMsg.id,
      result: 'wake text',
    });

    await expect(promise).resolves.toBe('wake text');
  });

  it('posts MCP runtime-tool selection RPC and resolves snapshot results', async () => {
    const snapshot = makeMcpSnapshot();
    const selection = {
      serverSummaries: snapshot.serverSummaries,
      selectedToolIds: ['tool-1'],
      deferredToolCount: 0,
      query: 'docs',
    };

    const promise = client.buildMcpRuntimeToolContextSelection(snapshot, 'docs', 6);
    const postedMsg = fakeWorker.postMessage.mock.calls[0]?.[0] as {
      id: number;
      type: string;
      query: string;
      maxTools: number;
      snapshot: unknown;
    };

    expect(postedMsg.type).toBe('build-mcp-runtime-tool-context');
    expect(postedMsg.query).toBe('docs');
    expect(postedMsg.maxTools).toBe(6);
    expect(postedMsg.snapshot).toEqual(snapshot);

    fakeWorker.emit('message', {
      type: 'rpc-response',
      id: postedMsg.id,
      result: selection,
    });

    await expect(promise).resolves.toEqual(selection);
  });

  it('posts project-memory brief RPC and resolves worker results', async () => {
    const brief = {
      text: 'Relevant prior project memory',
      sections: [{ title: 'Recent context', items: [] }],
      sources: [],
      stats: {
        projectKey: '/repo',
        candidatesScanned: 2,
        candidatesIncluded: 1,
        truncated: false,
      },
    };

    const promise = client.buildProjectMemoryBrief({
      projectPath: '/repo',
      instanceId: 'inst-1',
      initialPrompt: 'continue auth work',
      provider: 'claude',
      model: 'claude-opus-4-20250514',
    });
    const postedMsg = fakeWorker.postMessage.mock.calls[0]?.[0] as {
      id: number;
      type: string;
      request: unknown;
    };

    expect(postedMsg.type).toBe('build-project-memory-brief');
    expect(postedMsg.request).toEqual({
      projectPath: '/repo',
      instanceId: 'inst-1',
      initialPrompt: 'continue auth work',
      provider: 'claude',
      model: 'claude-opus-4-20250514',
    });

    fakeWorker.emit('message', {
      type: 'rpc-response',
      id: postedMsg.id,
      result: brief,
    });

    await expect(promise).resolves.toEqual(brief);
  });

  it('falls back to in-process MCP runtime-tool selection when the worker is degraded', async () => {
    const snapshot = makeMcpSnapshot();

    fakeWorker.emit('error', new Error('worker crashed'));

    await expect(client.buildMcpRuntimeToolContextSelection(snapshot, 'docs', 6)).resolves.toEqual({
      serverSummaries: snapshot.serverSummaries,
      selectedToolIds: ['tool-1'],
      deferredToolCount: 0,
      query: 'docs',
    });
    expect(fakeWorker.postMessage).not.toHaveBeenCalled();
  });

  it('returns null for project-memory brief when the worker is degraded', async () => {
    fakeWorker.emit('error', new Error('worker crashed'));

    await expect(client.buildProjectMemoryBrief({ projectPath: '/repo' })).resolves.toBeNull();
    expect(fakeWorker.postMessage).not.toHaveBeenCalled();
  });

  it('falls back to in-process MCP runtime-tool selection when the worker times out', async () => {
    const snapshot = makeMcpSnapshot();

    await expect(client.buildMcpRuntimeToolContextSelection(snapshot, 'docs', 6)).resolves.toEqual({
      serverSummaries: snapshot.serverSummaries,
      selectedToolIds: ['tool-1'],
      deferredToolCount: 0,
      query: 'docs',
    });
    expect(fakeWorker.postMessage).toHaveBeenCalledTimes(1);
  });

  // ── No non-cloneable objects posted ────────────────────────────────────────

  it('does not include EventEmitter or functions in fire-and-forget message', () => {
    const instance = makeInstance();
    // Attach a non-cloneable field to verify it is stripped
    (instance as unknown as Record<string, unknown>)._emitter = new EventEmitter();

    client.ingestToRLM('inst-1', makeOutputMessage());

    const posted = fakeWorker.postMessage.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(posted).toBeDefined();
    expect(posted['_emitter']).toBeUndefined();
    // Only allowed fields reach the worker
    expect(posted['type']).toBe('ingest-rlm');
    expect(posted['instanceId']).toBe('inst-1');
  });

  it('snapshot posted to worker contains only clone-safe fields', () => {
    client.ingestToUnifiedMemory(makeInstance(), makeOutputMessage());

    const posted = fakeWorker.postMessage.mock.calls[0]?.[0] as {
      snapshot: { id: string; sessionId?: string; parentId?: unknown };
    };
    expect(Object.keys(posted.snapshot)).toEqual(
      expect.arrayContaining(['id', 'sessionId', 'parentId', 'contextUsage']),
    );
    // No full Instance fields like outputBuffer, childrenIds, etc.
    expect((posted.snapshot as Record<string, unknown>)['outputBuffer']).toBeUndefined();
    expect((posted.snapshot as Record<string, unknown>)['childrenIds']).toBeUndefined();
  });

  // ── Degradation ─────────────────────────────────────────────────────────────

  it('drops ingestion and returns null for RPC when degraded', async () => {
    fakeWorker.emit('error', new Error('worker crashed'));

    client.ingestToRLM('inst-1', makeOutputMessage());
    const rpcResult = await client.buildRlmContext('inst-1', 'query');

    expect(rpcResult).toBeNull();
    const { dropped } = client.getMetrics();
    expect(dropped).toBeGreaterThan(0);
    expect(client.getMetrics().degraded).toBe(true);
  });

  it('fails all pending RPCs on worker error', async () => {
    const slow1 = client.buildRlmContext('inst-1', 'q1');
    const slow2 = client.buildUnifiedMemoryContext(makeInstance(), 'q2', 'task-1');

    fakeWorker.emit('error', new Error('crash'));

    // Both pending RPCs resolve to null (not reject) after worker crash because
    // worker crash calls failAllPending which rejects, but buildRlmContext /
    // buildUnifiedMemoryContext catch and return null via degraded check.
    // Actually they reject because failAllPending rejects. Let's check they settle.
    const [r1, r2] = await Promise.allSettled([slow1, slow2]);
    // Either rejected or resolved-null are both acceptable outcomes
    expect(r1.status === 'rejected' || (r1.status === 'fulfilled' && r1.value === null)).toBe(true);
    expect(r2.status === 'rejected' || (r2.status === 'fulfilled' && r2.value === null)).toBe(true);
  });

  it('restarts repeatedly across a session when the worker recovers between crashes', async () => {
    // Regression guard: a healthy RPC response must reset the consecutive-crash
    // counter so a worker that crashes, recovers, then crashes again later is
    // still restarted instead of being permanently disabled. Without the reset
    // the client would stay degraded after MAX_RESTART_ATTEMPTS lifetime crashes,
    // silently killing memory/RLM context for the rest of the session.
    vi.useFakeTimers();
    try {
      const { _resetContextWorkerClientForTesting, ContextWorkerClient } = await import('../context-worker-client');
      _resetContextWorkerClientForTesting();

      const workers: FakeWorker[] = [];
      const recoveringClient = new ContextWorkerClient({
        workerFactory: () => {
          const w = createFakeWorker();
          workers.push(w);
          return w as unknown as Worker;
        },
        rpcTimeoutMs: 50,
        userDataPath: '/tmp/test',
      });

      // Five crash/recover cycles — far beyond MAX_RESTART_ATTEMPTS (3).
      for (let cycle = 0; cycle < 5; cycle++) {
        const before = workers.length;
        workers[before - 1].emit('error', new Error(`crash ${cycle}`));
        expect(recoveringClient.getMetrics().degraded).toBe(true);

        // Restart fires after the backoff and spawns a fresh worker.
        await vi.advanceTimersByTimeAsync(2_000);
        expect(workers.length).toBe(before + 1);
        expect(recoveringClient.getMetrics().degraded).toBe(false);

        // The new worker answers an RPC → client treats it as recovered.
        const pending = recoveringClient.buildRlmContext('inst-1', 'q');
        const posted = workers[workers.length - 1].postMessage.mock.calls.at(-1)?.[0] as { id: number };
        workers[workers.length - 1].emit('message', { type: 'rpc-response', id: posted.id, result: null });
        await pending;
      }

      // Still healthy after 5 crashes because each was followed by a recovery.
      expect(recoveringClient.getMetrics().degraded).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not restart after shutdown while a crash restart backoff is pending', async () => {
    vi.useFakeTimers();
    try {
      const { _resetContextWorkerClientForTesting, ContextWorkerClient } = await import('../context-worker-client');
      _resetContextWorkerClientForTesting();

      const workers: FakeWorker[] = [];
      const shuttingDownClient = new ContextWorkerClient({
        workerFactory: () => {
          const w = createFakeWorker();
          workers.push(w);
          return w as unknown as Worker;
        },
        rpcTimeoutMs: 50,
        userDataPath: '/tmp/test',
      });

      workers[0].emit('error', new Error('crash before shutdown'));
      await shuttingDownClient.shutdown();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(workers).toHaveLength(1);
      expect(shuttingDownClient.getMetrics().degraded).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // ── Synchronous in-process methods ──────────────────────────────────────────

  it('calculateContextBudget runs in-process without posting to worker', () => {
    const budget = client.calculateContextBudget(
      makeInstance({ contextUsage: { used: 0, total: 100, percentage: 0 } }),
      'what should I do next?',
    );
    expect(budget.rlmMaxTokens).toBeGreaterThan(0);
    expect(budget.rlmTopK).toBeGreaterThanOrEqual(1);
    expect(fakeWorker.postMessage).not.toHaveBeenCalled();
  });

  it('calculateContextBudget returns zero budget when context usage is critical', () => {
    const budget = client.calculateContextBudget(
      makeInstance({ contextUsage: { used: 90, total: 100, percentage: 91 } }),
      'query',
    );
    expect(budget.rlmMaxTokens).toBe(0);
    expect(budget.totalTokens).toBe(0);
  });

  it('formatRlmContextBlock returns null for null input', () => {
    expect(client.formatRlmContextBlock(null)).toBeNull();
  });

  it('formatUnifiedMemoryContextBlock returns null for null input', () => {
    expect(client.formatUnifiedMemoryContextBlock(null)).toBeNull();
  });

  it('formatRlmContextBlock wraps context with source label', () => {
    const result = client.formatRlmContextBlock({
      context: 'some context text',
      tokens: 5,
      sectionsAccessed: ['s1'],
      durationMs: 3,
      source: 'hybrid',
    });
    expect(result).toContain('[Retrieved Context]');
    expect(result).toContain('RLM hybrid search');
    expect(result).toContain('some context text');
  });

  // ── compactContext buffer trim ───────────────────────────────────────────────

  it('compactContext trims outputBuffer in main process after RPC', async () => {
    const instance = makeInstance({
      outputBuffer: Array.from({ length: 60 }, (_, i) => ({ id: `m${i}` })),
    });

    const promise = client.compactContext('inst-1', instance);
    const postedMsg = fakeWorker.postMessage.mock.calls[0]?.[0] as { id: number };
    fakeWorker.emit('message', { type: 'rpc-response', id: postedMsg.id });

    await promise;
    expect(instance.outputBuffer.length).toBe(50);
    expect((instance.outputBuffer[0] as { id: string }).id).toBe('m10');
  });

  it('compactContext does not trim if buffer is under 50 messages', async () => {
    const instance = makeInstance({
      outputBuffer: Array.from({ length: 30 }, (_, i) => ({ id: `m${i}` })),
    });

    const promise = client.compactContext('inst-1', instance);
    const postedMsg = fakeWorker.postMessage.mock.calls[0]?.[0] as { id: number };
    fakeWorker.emit('message', { type: 'rpc-response', id: postedMsg.id });

    await promise;
    expect(instance.outputBuffer.length).toBe(30);
  });

  // ── Metrics ─────────────────────────────────────────────────────────────────

  it('increments processed count on successful RPC', async () => {
    const p = client.initializeRlm(makeInstance());
    const msg = fakeWorker.postMessage.mock.calls[0]?.[0] as { id: number };
    fakeWorker.emit('message', { type: 'rpc-response', id: msg.id });
    await p;
    expect(client.getMetrics().processed).toBe(1);
  });
});

describe('ContextWorkerClient default process isolation', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:worker_threads');
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('starts the production context worker as a child process instead of a worker_thread', async () => {
    vi.resetModules();
    const child = Object.assign(new EventEmitter(), {
      send: vi.fn((message: { type?: string; id?: number }) => {
        if (message.type === 'shutdown') {
          queueMicrotask(() => child.emit('message', { type: 'rpc-response', id: message.id }));
        }
      }),
      kill: vi.fn(),
      connected: true,
      exitCode: null,
    });
    const fork = vi.fn(() => child);
    const Worker = vi.fn(() => createFakeWorker());

    vi.doMock('node:child_process', () => ({ default: { fork }, fork }));
    vi.doMock('node:worker_threads', () => ({ default: { Worker }, Worker }));
    vi.doMock('node:fs', () => ({ default: { existsSync: vi.fn(() => true) }, existsSync: vi.fn(() => true) }));

    const { ContextWorkerClient } = await import('../context-worker-client');
    const isolated = new ContextWorkerClient({ userDataPath: '/tmp/test', rpcTimeoutMs: 50 });

    expect(fork).toHaveBeenCalledWith(
      expect.stringContaining('context-worker-main.js'),
      [],
      expect.objectContaining({
        env: expect.objectContaining({ AIO_USER_DATA_PATH: '/tmp/test' }),
      }),
    );
    expect(Worker).not.toHaveBeenCalled();

    await isolated.shutdown();
  });
});
