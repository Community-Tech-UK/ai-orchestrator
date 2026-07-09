import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';

// ── Module-level mocks ────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/test'), isPackaged: false },
}));

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('IndexWorkerGateway', () => {
  let fakeWorker: FakeWorker;
  let gateway: import('../index-worker-gateway').IndexWorkerGateway;

  beforeEach(async () => {
    fakeWorker = createFakeWorker();
    const { IndexWorkerGateway } = await import('../index-worker-gateway');
    gateway = new IndexWorkerGateway({
      workerFactory: () => fakeWorker as unknown as Worker,
      rpcTimeoutMs: 50,
      userDataPath: '/tmp/test',
    });
    await gateway.start();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── Basic RPC ─────────────────────────────────────────────────────────────

  it('sends warm-workspace message and resolves with worker result', async () => {
    const expectedResult = {
      indexed: true,
      absPath: '/project',
      primaryLanguage: 'typescript',
    };

    const promise = gateway.warmWorkspace('/project');
    const posted = fakeWorker.postMessage.mock.calls[0]?.[0] as { id: number; type: string };
    expect(posted.type).toBe('warm-workspace');

    fakeWorker.emit('message', {
      type: 'rpc-response',
      id: posted.id,
      result: expectedResult,
    });

    const result = await promise;
    expect(result).toEqual(expectedResult);
    expect(gateway.getMetrics().processed).toBe(1);
  });

  it('sends search-workspace-chunks and resolves with the worker search response', async () => {
    const expectedResponse = {
      indexed: true,
      results: [
        {
          workspacePath: '/project',
          relativePath: 'src/auth.ts',
          absolutePath: '/project/src/auth.ts',
          content: 'export function f() {}',
          startLine: 1,
          endLine: 1,
          score: 2.5,
          source: 'fts' as const,
          language: 'typescript',
          symbolName: 'f',
          stale: false,
        },
      ],
    };

    const promise = gateway.searchWorkspaceChunks('/project', 'auth token', 8);
    const posted = fakeWorker.postMessage.mock.calls[0]?.[0] as {
      id: number;
      type: string;
      query: string;
      limit: number;
    };
    expect(posted.type).toBe('search-workspace-chunks');
    expect(posted.query).toBe('auth token');
    expect(posted.limit).toBe(8);

    fakeWorker.emit('message', { type: 'rpc-response', id: posted.id, result: expectedResponse });

    await expect(promise).resolves.toEqual(expectedResponse);
  });

  it('returns null from search when the RPC times out (caller falls back to ripgrep)', async () => {
    // Never respond — the 50ms gateway deadline should resolve null, not hang.
    await expect(gateway.searchWorkspaceChunks('/project', 'auth', 8, 30)).resolves.toBeNull();
  });

  it('gets codemem index status snapshots from the worker', async () => {
    const expectedStatus = {
      workspacePath: '/repo',
      workspaceHash: 'workspace-hash',
      state: 'running',
      phase: 'chunking',
      processedFiles: 10,
      totalFiles: 20,
      totalChunks: 40,
      processedChunks: 12,
      currentPath: 'src/auth.ts',
      startedAt: 100,
      updatedAt: 200,
      completedAt: null,
      etaMs: 500,
      errorMessage: null,
    };

    const promise = gateway.getIndexStatus('/repo');
    const posted = fakeWorker.postMessage.mock.calls[0]?.[0] as { id: number; type: string };
    expect(posted.type).toBe('get-index-status');

    fakeWorker.emit('message', {
      type: 'rpc-response',
      id: posted.id,
      result: expectedStatus,
    });

    await expect(promise).resolves.toEqual(expect.objectContaining({
      workspacePath: '/repo',
      state: 'running',
      phase: 'chunking',
      processedFiles: 10,
      totalFiles: 20,
    }));
  });

  it('sends cancel-index RPCs to the worker', async () => {
    const promise = gateway.cancelIndex('/repo');
    const posted = fakeWorker.postMessage.mock.calls[0]?.[0] as { id: number; type: string; workspacePath: string };
    expect(posted).toEqual(expect.objectContaining({
      type: 'cancel-index',
      workspacePath: '/repo',
    }));

    fakeWorker.emit('message', {
      type: 'rpc-response',
      id: posted.id,
      result: undefined,
    });

    await expect(promise).resolves.toBeUndefined();
  });

  it('sends rebuild-index RPCs to the worker', async () => {
    const promise = gateway.rebuildIndex('/repo');
    const posted = fakeWorker.postMessage.mock.calls[0]?.[0] as { id: number; type: string; workspacePath: string };
    expect(posted.type).toBe('rebuild-index');

    fakeWorker.emit('message', {
      type: 'rpc-response',
      id: posted.id,
      result: {
        indexed: true,
        absPath: '/repo',
        primaryLanguage: 'typescript',
      },
    });

    await expect(promise).resolves.toEqual(expect.objectContaining({
      indexed: true,
      absPath: '/repo',
    }));
  });

  it('sends run-maintenance RPCs to the worker', async () => {
    const promise = gateway.runMaintenance();
    const posted = fakeWorker.postMessage.mock.calls[0]?.[0] as { id: number; type: string };
    expect(posted.type).toBe('run-maintenance');

    fakeWorker.emit('message', {
      type: 'rpc-response',
      id: posted.id,
      result: {
        deletedWorkspaceHashes: [],
        retainedWorkspaceHashes: [],
        deletedOrphanChunks: 3,
        deletedLegacyMerkleNodes: 2,
      },
    });

    await expect(promise).resolves.toEqual(expect.objectContaining({
      deletedOrphanChunks: 3,
      deletedLegacyMerkleNodes: 2,
    }));
  });

  it('emits code-index:changed when the worker reports changed indexed files', async () => {
    const listener = vi.fn();
    gateway.on('code-index:changed', listener);

    fakeWorker.emit('message', {
      type: 'code-index-changed',
      workspacePath: '/project',
      workspaceHash: 'workspace-hash',
      paths: ['src/index.ts'],
      timestamp: 1000,
    });

    expect(listener).toHaveBeenCalledWith({
      workspacePath: '/project',
      workspaceHash: 'workspace-hash',
      paths: ['src/index.ts'],
      timestamp: 1000,
    });
  });

  it('returns degraded result on RPC timeout', async () => {
    const result = await gateway.warmWorkspace('/slow-project');
    expect(result.indexed).toBe(false);
    expect(result.absPath).toBe('/slow-project');
    expect(gateway.getMetrics().dropped).toBeGreaterThan(0);
    expect(fakeWorker.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'cancel-index',
      workspacePath: '/slow-project',
    }));
  });

  // ── Degradation ───────────────────────────────────────────────────────────

  it('marks degraded and returns fallback on worker error', async () => {
    fakeWorker.emit('error', new Error('worker crashed'));

    const result = await gateway.warmWorkspace('/project');
    expect(result.indexed).toBe(false);
    expect(gateway.getMetrics().degraded).toBe(true);
    expect(gateway.getMetrics().lastError).toContain('worker crashed');
  });

  it('fails all pending RPCs when worker crashes', async () => {
    const promise1 = gateway.warmWorkspace('/workspace-a');
    const promise2 = gateway.warmWorkspace('/workspace-b');

    fakeWorker.emit('error', new Error('crash'));

    const [r1, r2] = await Promise.allSettled([promise1, promise2]);
    // Each may settle as rejected or as resolved-null; either is acceptable.
    const settled = (r: typeof r1) =>
      r.status === 'rejected' || (r.status === 'fulfilled' && !r.value.indexed);
    expect(settled(r1)).toBe(true);
    expect(settled(r2)).toBe(true);
  });

  it('returns degraded result immediately when worker is not started', async () => {
    const { IndexWorkerGateway } = await import('../index-worker-gateway');
    const noWorkerGateway = new IndexWorkerGateway({
      workerFactory: () => { throw new Error('no worker'); },
      rpcTimeoutMs: 50,
      userDataPath: '/tmp/test',
    });
    // start() will fail and mark degraded
    await noWorkerGateway.start().catch(() => undefined);
    const result = await noWorkerGateway.warmWorkspace('/project');
    expect(result.indexed).toBe(false);
  });

  // ── Metrics ──────────────────────────────────────────────────────────────

  it('tracks inFlight count while RPC is pending', async () => {
    const promise = gateway.warmWorkspace('/project');
    expect(gateway.getMetrics().inFlight).toBeGreaterThan(0);

    const posted = fakeWorker.postMessage.mock.calls[0]?.[0] as { id: number };
    fakeWorker.emit('message', { type: 'rpc-response', id: posted.id, result: { indexed: true, absPath: '/project', primaryLanguage: 'typescript' } });
    await promise;
    expect(gateway.getMetrics().inFlight).toBe(0);
  });

  // ── Worker error response ─────────────────────────────────────────────────

  it('returns degraded result when worker responds with an error field', async () => {
    const promise = gateway.warmWorkspace('/project');
    const posted = fakeWorker.postMessage.mock.calls[0]?.[0] as { id: number };
    fakeWorker.emit('message', {
      type: 'rpc-response',
      id: posted.id,
      error: 'cold index failed',
    });
    const result = await promise;
    expect(result.indexed).toBe(false);
    expect(result.absPath).toBe('/project');
  });

  // ── Stop workspace watcher ────────────────────────────────────────────────

  it('postMessage stop-workspace-watcher for fire-and-forget', () => {
    gateway.stopWorkspaceWatcher('/some-workspace');
    const calls = fakeWorker.postMessage.mock.calls;
    const stopMsg = calls.find(([m]) => m.type === 'stop-workspace-watcher');
    expect(stopMsg).toBeDefined();
    expect(stopMsg![0].workspacePath).toBe('/some-workspace');
  });

  it('does not mark degraded when the worker exits during an intentional stop', async () => {
    const shutdownPromise = gateway.stop();
    const shutdownMsg = fakeWorker.postMessage.mock.calls
      .map(([message]) => message as { type?: string; id?: number })
      .find((message) => message.type === 'shutdown');
    expect(shutdownMsg?.id).toBeDefined();

    fakeWorker.emit('message', { type: 'rpc-response', id: shutdownMsg!.id });
    await shutdownPromise;

    fakeWorker.emit('exit', null);

    expect(gateway.getMetrics().degraded).toBe(false);
  });

  it('does not restart after stop while a crash restart backoff is pending', async () => {
    vi.useFakeTimers();
    try {
      const { IndexWorkerGateway } = await import('../index-worker-gateway');
      const workers: FakeWorker[] = [];
      const stoppingGateway = new IndexWorkerGateway({
        workerFactory: () => {
          const w = createFakeWorker();
          workers.push(w);
          return w;
        },
        rpcTimeoutMs: 50,
        userDataPath: '/tmp/test',
      });
      await stoppingGateway.start();

      workers[0].emit('error', new Error('crash before stop'));
      await stoppingGateway.stop();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(workers).toHaveLength(1);
      expect(stoppingGateway.getMetrics().degraded).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('IndexWorkerGateway default process isolation', () => {
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.doUnmock('node:worker_threads');
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('starts the production codemem worker as a child process instead of a worker_thread', async () => {
    vi.resetModules();
    const child = Object.assign(new EventEmitter(), {
      send: vi.fn((message: { type?: string; id?: number }) => {
        if (message.type === 'shutdown') {
          queueMicrotask(() => child.emit('message', { type: 'rpc-response', id: message.id }));
        }
      }),
      kill: vi.fn(),
      connected: true,
    });
    const fork = vi.fn(() => child);
    const Worker = vi.fn(() => createFakeWorker());

    vi.doMock('node:child_process', () => ({
      default: { fork },
      fork,
    }));
    vi.doMock('node:worker_threads', () => ({
      default: { Worker },
      Worker,
    }));
    vi.doMock('node:fs', () => ({
      default: { existsSync: vi.fn(() => true) },
      existsSync: vi.fn(() => true),
    }));

    const { IndexWorkerGateway } = await import('../index-worker-gateway');
    const isolatedGateway = new IndexWorkerGateway({ userDataPath: '/tmp/test', rpcTimeoutMs: 50 });

    await isolatedGateway.start();

    expect(fork).toHaveBeenCalledWith(
      expect.stringContaining('index-worker-main.js'),
      [],
      expect.objectContaining({
        env: expect.objectContaining({
          AIO_USER_DATA_PATH: '/tmp/test',
        }),
      }),
    );
    expect(Worker).not.toHaveBeenCalled();

    await isolatedGateway.stop();
  });
});
