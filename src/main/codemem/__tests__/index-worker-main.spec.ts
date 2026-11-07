import { EventEmitter } from 'node:events';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WarmWorkspaceResult } from '../index-worker-protocol';

type FakeParentPort = EventEmitter & {
  postMessage: ReturnType<typeof vi.fn>;
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolveFn!: (value: T) => void;
  let rejectFn!: (error: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  return { promise, resolve: resolveFn, reject: rejectFn };
}

async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('codemem index worker main', () => {
  let parentPort: FakeParentPort;
  let workerThreads: {
    parentPort: FakeParentPort | null;
    isMainThread: boolean;
    workerData: { userDataPath: string } | null;
  };
  let db: {
    pragma: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  let store: {
    getWorkspaceRootByPath: ReturnType<typeof vi.fn>;
    getIndexStatus: ReturnType<typeof vi.fn>;
    requestCancel: ReturnType<typeof vi.fn>;
    clearCancel: ReturnType<typeof vi.fn>;
    listWorkspaceIndexStats: ReturnType<typeof vi.fn>;
    deleteWorkspaceIndex: ReturnType<typeof vi.fn>;
    pruneAbandonedWorkspaces: ReturnType<typeof vi.fn>;
    releaseDeletedSpace: ReturnType<typeof vi.fn>;
    clearLegacyMerkleNodes: ReturnType<typeof vi.fn>;
    vacuumFreelistPages: ReturnType<typeof vi.fn>;
  };
  let indexManager: EventEmitter & {
    coldIndex: ReturnType<typeof vi.fn>;
    reconcileIndex: ReturnType<typeof vi.fn>;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.resetModules();
    parentPort = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
    }) as FakeParentPort;
    db = {
      pragma: vi.fn(),
      close: vi.fn(),
    };
    store = {
      getWorkspaceRootByPath: vi.fn(),
      getIndexStatus: vi.fn(() => null),
      requestCancel: vi.fn(),
      clearCancel: vi.fn(),
      listWorkspaceIndexStats: vi.fn(() => []),
      deleteWorkspaceIndex: vi.fn(),
      pruneAbandonedWorkspaces: vi.fn(() => ({ deletedWorkspaces: 0, deletedChunks: 0, remainingWorkspaces: 0 })),
      releaseDeletedSpace: vi.fn(() => ({ deletedChunks: 0, finished: true })),
      clearLegacyMerkleNodes: vi.fn(() => 0),
      vacuumFreelistPages: vi.fn(() => ({ freedPages: 0, remainingFreePages: 0, stoppedReason: 'done' })),
    };
    indexManager = Object.assign(new EventEmitter(), {
      coldIndex: vi.fn().mockResolvedValue(undefined),
      reconcileIndex: vi.fn().mockResolvedValue({
        workspaceHash: 'hash',
        scannedFiles: 0,
        changedFiles: 0,
        removedFiles: 0,
        cancelled: false,
      }),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    });

    workerThreads = {
      parentPort,
      isMainThread: false,
      workerData: { userDataPath: '/tmp/aio-index-worker-test' },
    };
    // The factory reads `workerThreads` lazily. Under heavy parallel load Vitest
    // has been seen to hand the worker the mock registered here even after a
    // test re-registered `node:worker_threads`, so a test changes the transport
    // by reassigning `workerThreads` instead of mocking the module again.
    vi.doMock('node:worker_threads', () => ({
      default: {
        get parentPort() { return workerThreads.parentPort; },
        get isMainThread() { return workerThreads.isMainThread; },
        get workerData() { return workerThreads.workerData; },
      },
      get parentPort() { return workerThreads.parentPort; },
      get isMainThread() { return workerThreads.isMainThread; },
      get workerData() { return workerThreads.workerData; },
    }));
    vi.doMock('../../db/better-sqlite3-driver', () => ({
      defaultDriverFactory: vi.fn(() => db),
    }));
    vi.doMock('../cas-schema', () => ({
      migrate: vi.fn(),
    }));
    vi.doMock('../cas-store', () => ({
      CasStore: vi.fn(function () { return store; }),
    }));
    vi.doMock('../code-index-manager', () => ({
      CodeIndexManager: vi.fn(function () { return indexManager; }),
    }));
    vi.doMock('../symbol-id', () => ({
      workspaceHashForPath: (workspacePath: string) => `hash:${workspacePath}`,
    }));
  });

  afterEach(() => {
    parentPort.removeAllListeners();
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('node:worker_threads');
    vi.doUnmock('../../db/better-sqlite3-driver');
    vi.doUnmock('../cas-schema');
    vi.doUnmock('../cas-store');
    vi.doUnmock('../code-index-manager');
    vi.doUnmock('../symbol-id');
  });

  async function importWorker(): Promise<void> {
    await import('../index-worker-main');
    await flushMicrotasks();
  }

  function rpcResult(id: number): WarmWorkspaceResult | undefined {
    const response = parentPort.postMessage.mock.calls
      .map(([message]) => message as { type?: string; id?: number; result?: WarmWorkspaceResult })
      .find((message) => message.type === 'rpc-response' && message.id === id);
    return response?.result;
  }

  it('does not start a watcher when warm indexing finishes without a workspace root', async () => {
    store.getWorkspaceRootByPath.mockReturnValue(null);

    await importWorker();
    parentPort.emit('message', {
      type: 'warm-workspace',
      id: 1,
      workspacePath: '/repo',
    });
    await flushMicrotasks();

    expect(indexManager.coldIndex).toHaveBeenCalledWith(path.resolve('/repo'));
    expect(indexManager.start).not.toHaveBeenCalled();
    expect(rpcResult(1)).toEqual({
      indexed: false,
      absPath: path.resolve('/repo'),
      primaryLanguage: 'typescript',
    });
  });

  it('reconciles an existing index once after warm, but never after a cold index', async () => {
    const repo = path.resolve('/repo');
    store.getWorkspaceRootByPath.mockReturnValue({ absPath: repo, primaryLanguage: 'typescript' });

    await importWorker();
    parentPort.emit('message', {
      type: 'warm-workspace',
      id: 1,
      workspacePath: '/repo',
    });
    await flushMicrotasks();

    expect(indexManager.coldIndex).not.toHaveBeenCalled();
    expect(indexManager.reconcileIndex).toHaveBeenCalledTimes(1);
    expect(indexManager.reconcileIndex).toHaveBeenCalledWith(repo);
    expect(store.clearCancel).toHaveBeenCalledWith(`hash:${repo}`);
    // The warm response must not wait for the reconcile result.
    expect(rpcResult(1)).toEqual(expect.objectContaining({ indexed: true, absPath: repo }));

    parentPort.emit('message', {
      type: 'warm-workspace',
      id: 2,
      workspacePath: '/repo',
    });
    await flushMicrotasks();

    expect(indexManager.reconcileIndex).toHaveBeenCalledTimes(1);
  });

  it('reconciles again on the next warm when the reconcile was cancelled part-way', async () => {
    const repo = path.resolve('/repo');
    store.getWorkspaceRootByPath.mockReturnValue({ absPath: repo, primaryLanguage: 'typescript' });
    indexManager.reconcileIndex.mockResolvedValueOnce({
      workspaceHash: 'hash',
      scannedFiles: 0,
      changedFiles: 0,
      removedFiles: 0,
      cancelled: true,
    });

    await importWorker();
    for (const id of [1, 2, 3]) {
      parentPort.emit('message', { type: 'warm-workspace', id, workspacePath: '/repo' });
      await flushMicrotasks();
    }

    // Cancelled, then completed; the third warm finds it already reconciled.
    expect(indexManager.reconcileIndex).toHaveBeenCalledTimes(2);
  });

  it('re-arms warm reconcile after the workspace watcher is stopped', async () => {
    const repo = path.resolve('/repo');
    store.getWorkspaceRootByPath.mockReturnValue({ absPath: repo, primaryLanguage: 'typescript' });

    await importWorker();
    parentPort.emit('message', {
      type: 'warm-workspace',
      id: 1,
      workspacePath: '/repo',
    });
    await flushMicrotasks();
    parentPort.emit('message', {
      type: 'stop-workspace-watcher',
      id: 2,
      workspacePath: '/repo',
    });
    await flushMicrotasks();
    parentPort.emit('message', {
      type: 'warm-workspace',
      id: 3,
      workspacePath: '/repo',
    });
    await flushMicrotasks();

    expect(indexManager.reconcileIndex).toHaveBeenCalledTimes(2);
  });

  it('serializes heavy indexing messages while handling cancellation immediately', async () => {
    const firstColdIndex = makeDeferred<void>();
    indexManager.coldIndex
      .mockImplementationOnce(() => firstColdIndex.promise)
      .mockResolvedValueOnce(undefined);
    const repoA = path.resolve('/repo-a');
    const repoB = path.resolve('/repo-b');
    store.getWorkspaceRootByPath
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ absPath: repoA, primaryLanguage: 'typescript' })
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ absPath: repoB, primaryLanguage: 'typescript' });

    await importWorker();
    parentPort.emit('message', {
      type: 'warm-workspace',
      id: 1,
      workspacePath: '/repo-a',
    });
    parentPort.emit('message', {
      type: 'warm-workspace',
      id: 2,
      workspacePath: '/repo-b',
    });
    await flushMicrotasks();

    expect(indexManager.coldIndex).toHaveBeenCalledTimes(1);

    parentPort.emit('message', {
      type: 'cancel-index',
      id: 3,
      workspacePath: '/repo-a',
    });
    await flushMicrotasks();

    expect(store.requestCancel).toHaveBeenCalledWith(`hash:${repoA}`);
    expect(indexManager.coldIndex).toHaveBeenCalledTimes(1);

    firstColdIndex.resolve(undefined);
    await flushMicrotasks();

    expect(indexManager.coldIndex).toHaveBeenCalledTimes(2);
    expect(rpcResult(1)).toEqual(expect.objectContaining({ indexed: true, absPath: repoA }));
    expect(rpcResult(2)).toEqual(expect.objectContaining({ indexed: true, absPath: repoB }));
  });

  it('runs codemem maintenance in the index worker', async () => {
    store.releaseDeletedSpace.mockReturnValue({ deletedChunks: 3, finished: true });
    store.clearLegacyMerkleNodes.mockReturnValue(2);

    await importWorker();
    store.releaseDeletedSpace.mockClear();
    store.clearLegacyMerkleNodes.mockClear();
    store.vacuumFreelistPages.mockClear();
    parentPort.emit('message', {
      type: 'run-maintenance',
      id: 77,
    });
    await flushMicrotasks();

    expect(store.releaseDeletedSpace).toHaveBeenCalledTimes(1);
    expect(store.clearLegacyMerkleNodes).toHaveBeenCalledTimes(1);
    expect(store.vacuumFreelistPages).toHaveBeenCalledTimes(1);
    expect(parentPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'rpc-response',
      id: 77,
      result: expect.objectContaining({
        deletedOrphanChunks: 3,
        deletedLegacyMerkleNodes: 2,
      }),
    }));
  });

  it('removes a retired worktree index after stopping its watcher', async () => {
    const workspacePath = path.resolve('/repo/.worktrees/queue/retired');
    await importWorker();
    parentPort.emit('message', { type: 'remove-workspace-index', id: 88, workspacePath });
    await flushMicrotasks();
    expect(indexManager.stop).toHaveBeenCalledWith(`hash:${workspacePath}`);
    expect(store.deleteWorkspaceIndex).toHaveBeenCalledWith(`hash:${workspacePath}`);
    expect(parentPort.postMessage).toHaveBeenCalledWith({ type: 'rpc-response', id: 88, result: true, error: undefined });
  });

  it('keeps vacuum bursts short at startup and for requested maintenance', async () => {
    await importWorker();
    expect(store.vacuumFreelistPages).toHaveBeenCalledWith({ timeBudgetMs: 10_000 });
    store.vacuumFreelistPages.mockClear();

    parentPort.emit('message', { type: 'run-maintenance', id: 79 });
    await flushMicrotasks();

    expect(store.vacuumFreelistPages).toHaveBeenCalledWith({ timeBudgetMs: 10_000 });
  });

  it('checks for free space on a timer, in a short step that never starts a full VACUUM', async () => {
    vi.useFakeTimers();
    try {
      await importWorker();
      await vi.advanceTimersByTimeAsync(1_250);
      store.vacuumFreelistPages.mockClear();

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

      expect(store.vacuumFreelistPages).toHaveBeenCalledTimes(1);
      expect(store.vacuumFreelistPages).toHaveBeenCalledWith({
        timeBudgetMs: 500,
        stepPages: 1_024,
        allowFullVacuum: false,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps returning free space in short bursts until none is left', async () => {
    vi.useFakeTimers();
    try {
      await importWorker();
      store.vacuumFreelistPages.mockClear();
      store.vacuumFreelistPages
        .mockReturnValueOnce({ freedPages: 1_024, remainingFreePages: 2_000, stoppedReason: 'time-budget' })
        .mockReturnValueOnce({ freedPages: 1_024, remainingFreePages: 976, stoppedReason: 'time-budget' })
        .mockReturnValueOnce({ freedPages: 976, remainingFreePages: 0, stoppedReason: 'done' });

      await vi.advanceTimersByTimeAsync(3 * 1_250);
      expect(store.vacuumFreelistPages).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.vacuumFreelistPages).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops returning free space while another connection is reading, until the next check', async () => {
    vi.useFakeTimers();
    try {
      await importWorker();
      store.vacuumFreelistPages.mockClear();
      store.vacuumFreelistPages.mockReturnValueOnce({ freedPages: 0, remainingFreePages: 500, stoppedReason: 'checkpoint-busy' });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.vacuumFreelistPages).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(store.vacuumFreelistPages).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns free space only after abandoned workspaces and their release are finished', async () => {
    vi.useFakeTimers();
    try {
      await importWorker();
      store.vacuumFreelistPages.mockClear();
      store.pruneAbandonedWorkspaces.mockReturnValueOnce({ deletedWorkspaces: 1, deletedChunks: 10, remainingWorkspaces: 1 });
      store.releaseDeletedSpace.mockReturnValueOnce({ deletedChunks: 0, finished: false });

      await vi.advanceTimersByTimeAsync(3 * 1_250);
      expect(store.vacuumFreelistPages).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_250);
      expect(store.vacuumFreelistPages).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drains abandoned workspaces in short bursts, then releases their space in short bursts', async () => {
    vi.useFakeTimers();
    try {
      await importWorker();
      store.pruneAbandonedWorkspaces.mockClear();
      store.releaseDeletedSpace.mockClear();
      store.pruneAbandonedWorkspaces
        .mockReturnValueOnce({ deletedWorkspaces: 2, deletedChunks: 2_000, remainingWorkspaces: 3 })
        .mockReturnValueOnce({ deletedWorkspaces: 3, deletedChunks: 3_000, remainingWorkspaces: 0 });
      store.releaseDeletedSpace
        .mockReturnValueOnce({ deletedChunks: 10, finished: false })
        .mockReturnValueOnce({ deletedChunks: 0, finished: true });

      await vi.advanceTimersByTimeAsync(1_250);
      expect(store.pruneAbandonedWorkspaces).toHaveBeenCalledTimes(1);
      expect(store.releaseDeletedSpace).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_250);
      expect(store.pruneAbandonedWorkspaces).toHaveBeenCalledTimes(2);
      expect(store.releaseDeletedSpace).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_250);
      expect(store.releaseDeletedSpace).toHaveBeenCalledTimes(2);

      // One more burst finds no free pages left to return, and the chain stops.
      await vi.advanceTimersByTimeAsync(1_250);
      store.pruneAbandonedWorkspaces.mockClear();
      store.releaseDeletedSpace.mockClear();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.pruneAbandonedWorkspaces).not.toHaveBeenCalled();
      expect(store.releaseDeletedSpace).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('carries on in bursts when startup maintenance stops before releasing everything', async () => {
    vi.useFakeTimers();
    try {
      store.releaseDeletedSpace.mockReturnValueOnce({ deletedChunks: 5, finished: false });

      await importWorker();
      expect(store.releaseDeletedSpace).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_250);
      expect(store.releaseDeletedSpace).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.releaseDeletedSpace).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases a removed workspace\'s space in a later burst, not while the caller waits', async () => {
    vi.useFakeTimers();
    try {
      await importWorker();
      store.releaseDeletedSpace.mockClear();

      parentPort.emit('message', {
        type: 'remove-workspace-index',
        id: 89,
        workspacePath: path.resolve('/repo/.worktrees/queue/retired'),
      });
      await flushMicrotasks();

      expect(parentPort.postMessage).toHaveBeenCalledWith({ type: 'rpc-response', id: 89, result: true, error: undefined });
      expect(store.releaseDeletedSpace).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1_250);
      expect(store.releaseDeletedSpace).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a failed cleanup burst at the next space reclaim', async () => {
    vi.useFakeTimers();
    try {
      store.releaseDeletedSpace.mockReturnValueOnce({ deletedChunks: 0, finished: false });
      await importWorker();
      store.releaseDeletedSpace.mockClear();
      store.releaseDeletedSpace.mockImplementationOnce(() => {
        throw new Error('database is locked');
      });

      await vi.advanceTimersByTimeAsync(1_250);
      expect(store.releaseDeletedSpace).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      expect(store.releaseDeletedSpace).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps maintenance from failing when startup leaves abandoned workspaces behind', async () => {
    store.pruneAbandonedWorkspaces.mockReturnValue({ deletedWorkspaces: 1, deletedChunks: 10, remainingWorkspaces: 4 });

    await importWorker();

    expect(store.releaseDeletedSpace).toHaveBeenCalled();
    expect(store.vacuumFreelistPages).toHaveBeenCalledWith({ timeBudgetMs: 10_000 });
  });

  it('passes the automatic-context filter through to the search', async () => {
    const searchHydratedChunks = vi.fn(() => ({ indexed: true, results: [] }));
    vi.doMock('../workspace-chunk-search', () => ({ searchHydratedChunks }));
    try {
      await importWorker();
      parentPort.emit('message', {
        type: 'search-workspace-chunks',
        id: 91,
        workspacePath: '/repo',
        query: 'hello',
        limit: 3,
        strongMatchOnly: true,
      });
      await flushMicrotasks();

      expect(searchHydratedChunks).toHaveBeenCalledWith(store, path.resolve('/repo'), 'hello', 3, {
        strongMatchOnly: true,
      });
    } finally {
      vi.doUnmock('../workspace-chunk-search');
    }
  });

  it('reports maintenance that could not truncate the WAL because a read was open', async () => {
    db.pragma.mockImplementation((source: string) => (
      source === 'wal_checkpoint(TRUNCATE)' ? [{ busy: 1, log: 10, checkpointed: 0 }] : undefined
    ));

    await importWorker();
    parentPort.emit('message', {
      type: 'run-maintenance',
      id: 78,
    });
    await flushMicrotasks();

    expect(parentPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'rpc-response',
      id: 78,
      result: expect.objectContaining({ walTruncated: false }),
    }));
  });

  it('refuses to rebuild an index for the home folder', async () => {
    await importWorker();
    parentPort.emit('message', {
      type: 'rebuild-index',
      id: 6,
      workspacePath: os.homedir(),
    });
    await flushMicrotasks();

    expect(indexManager.coldIndex).not.toHaveBeenCalled();
    expect(rpcResult(6)).toEqual(expect.objectContaining({ indexed: false }));
  });

  it.each([
    ['the filesystem root', path.parse(process.cwd()).root],
    ['the home folder', os.homedir()],
  ])('refuses to index %s on warm-up', async (_label, workspacePath) => {
    await importWorker();
    parentPort.emit('message', {
      type: 'warm-workspace',
      id: 5,
      workspacePath,
    });
    await flushMicrotasks();

    expect(indexManager.coldIndex).not.toHaveBeenCalled();
    expect(indexManager.start).not.toHaveBeenCalled();
    expect(rpcResult(5)).toEqual(expect.objectContaining({ indexed: false }));
  });

  it('accepts child-process IPC when launched outside worker_threads', async () => {
    vi.resetModules();
    workerThreads = { parentPort: null, isMainThread: true, workerData: null };

    const send = vi.fn();
    const messageHandlers: ((message: unknown) => void)[] = [];
    const originalSendDescriptor = Object.getOwnPropertyDescriptor(process, 'send');
    const originalOn = process.on.bind(process);
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: send,
    });
    vi.spyOn(process, 'on').mockImplementation((eventName, listener) => {
      if (eventName === 'message') {
        messageHandlers.push(listener as (message: unknown) => void);
        return process;
      }
      return originalOn(eventName, listener);
    });
    process.env['AIO_USER_DATA_PATH'] = '/tmp/aio-index-child-test';
    const repo = path.resolve('/repo');
    store.getIndexStatus.mockReturnValue({
      workspaceHash: `hash:${repo}`,
      absPath: repo,
      state: 'complete',
      phase: 'watching',
      totalFiles: 2,
      processedFiles: 2,
      totalChunks: 4,
      processedChunks: 4,
      currentPath: null,
      startedAt: 100,
      updatedAt: 200,
      completedAt: 200,
      errorMessage: null,
      cancelRequested: false,
    });

    try {
      await importWorker();
      expect(messageHandlers).toHaveLength(1);

      messageHandlers[0]?.({
        type: 'get-index-status',
        id: 99,
        workspacePath: '/repo',
      });
      await flushMicrotasks();

      expect(send).toHaveBeenCalledWith({ type: 'ready' });
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        type: 'rpc-response',
        id: 99,
        result: expect.objectContaining({
          workspacePath: repo,
          state: 'complete',
        }),
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
