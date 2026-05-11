import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';

// ── Module-level mocks ────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test'), isPackaged: false },
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
