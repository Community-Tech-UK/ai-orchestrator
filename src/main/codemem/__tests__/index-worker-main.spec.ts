import { EventEmitter } from 'node:events';
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

    expect(indexManager.coldIndex).toHaveBeenCalledWith('/repo');
    expect(indexManager.start).not.toHaveBeenCalled();
    expect(rpcResult(1)).toEqual({
      indexed: false,
      absPath: '/repo',
      primaryLanguage: 'typescript',
    });
  });

  it('serializes heavy indexing messages while handling cancellation immediately', async () => {
    const firstColdIndex = makeDeferred<void>();
    indexManager.coldIndex
      .mockImplementationOnce(() => firstColdIndex.promise)
      .mockResolvedValueOnce(undefined);
    store.getWorkspaceRootByPath
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ absPath: '/repo-a', primaryLanguage: 'typescript' })
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ absPath: '/repo-b', primaryLanguage: 'typescript' });

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

    expect(store.requestCancel).toHaveBeenCalledWith('hash:/repo-a');
    expect(indexManager.coldIndex).toHaveBeenCalledTimes(1);

    firstColdIndex.resolve(undefined);
    await flushMicrotasks();

    expect(indexManager.coldIndex).toHaveBeenCalledTimes(2);
    expect(rpcResult(1)).toEqual(expect.objectContaining({ indexed: true, absPath: '/repo-a' }));
    expect(rpcResult(2)).toEqual(expect.objectContaining({ indexed: true, absPath: '/repo-b' }));
  });
});
