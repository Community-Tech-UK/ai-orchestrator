import { EventEmitter } from 'node:events';
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
    pruneUnreferencedChunks: ReturnType<typeof vi.fn>;
    clearLegacyMerkleNodes: ReturnType<typeof vi.fn>;
    optimizeSearchIndex: ReturnType<typeof vi.fn>;
    vacuumFreelistPages: ReturnType<typeof vi.fn>;
  };
  let indexManager: EventEmitter & {
    coldIndex: ReturnType<typeof vi.fn>;
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
      pruneUnreferencedChunks: vi.fn(() => 0),
      clearLegacyMerkleNodes: vi.fn(() => 0),
      optimizeSearchIndex: vi.fn(),
      vacuumFreelistPages: vi.fn(),
    };
    indexManager = Object.assign(new EventEmitter(), {
      coldIndex: vi.fn().mockResolvedValue(undefined),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    });

    vi.doMock('node:worker_threads', () => ({
      default: {
        parentPort,
        isMainThread: false,
        workerData: { userDataPath: '/tmp/aio-index-worker-test' },
      },
      parentPort,
      isMainThread: false,
      workerData: { userDataPath: '/tmp/aio-index-worker-test' },
    }));
    vi.doMock('../../db/better-sqlite3-driver', () => ({
      defaultDriverFactory: vi.fn(() => db),
    }));
    vi.doMock('../cas-schema', () => ({
      migrate: vi.fn(),
    }));
    vi.doMock('../cas-store', () => ({
      CasStore: vi.fn(() => store),
    }));
    vi.doMock('../code-index-manager', () => ({
      CodeIndexManager: vi.fn(() => indexManager),
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
    store.pruneUnreferencedChunks.mockReturnValue(3);
    store.clearLegacyMerkleNodes.mockReturnValue(2);

    await importWorker();
    store.pruneUnreferencedChunks.mockClear();
    store.clearLegacyMerkleNodes.mockClear();
    store.optimizeSearchIndex.mockClear();
    store.vacuumFreelistPages.mockClear();
    parentPort.emit('message', {
      type: 'run-maintenance',
      id: 77,
    });
    await flushMicrotasks();

    expect(store.pruneUnreferencedChunks).toHaveBeenCalledTimes(1);
    expect(store.clearLegacyMerkleNodes).toHaveBeenCalledTimes(1);
    expect(store.optimizeSearchIndex).toHaveBeenCalledTimes(1);
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

  it('accepts child-process IPC when launched outside worker_threads', async () => {
    vi.resetModules();
    vi.doMock('node:worker_threads', () => ({
      default: {
        parentPort: null,
        isMainThread: true,
        workerData: null,
      },
      parentPort: null,
      isMainThread: true,
      workerData: null,
    }));

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
    process.env.AIO_USER_DATA_PATH = '/tmp/aio-index-child-test';
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
      delete process.env.AIO_USER_DATA_PATH;
      if (originalSendDescriptor) {
        Object.defineProperty(process, 'send', originalSendDescriptor);
      } else {
        Reflect.deleteProperty(process, 'send');
      }
    }
  });
});
