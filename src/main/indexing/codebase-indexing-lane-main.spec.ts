import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexingStats } from '../../shared/types/codebase.types';

type ElectronParentPort = EventEmitter & {
  postMessage: ReturnType<typeof vi.fn>;
};

function processWithParentPort(): NodeJS.Process & { parentPort?: ElectronParentPort } {
  return process as NodeJS.Process & { parentPort?: ElectronParentPort };
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('codebase indexing lane main entrypoint', () => {
  const originalParentPort = processWithParentPort().parentPort;
  let originalProcessMessageListeners: NodeJS.MessageListener[];

  beforeEach(() => {
    originalProcessMessageListeners = process.listeners('message') as NodeJS.MessageListener[];
  });

  afterEach(() => {
    processWithParentPort().parentPort = originalParentPort;
    for (const listener of process.listeners('message')) {
      if (!originalProcessMessageListeners.includes(listener as NodeJS.MessageListener)) {
        process.off('message', listener as NodeJS.MessageListener);
      }
    }
    vi.restoreAllMocks();
    vi.resetModules();
    vi.doUnmock('./indexing-service');
    vi.doUnmock('../rlm/context-manager');
    vi.doUnmock('../persistence/rlm-database');
  });

  function installParentPort(): ElectronParentPort {
    const parentPort = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(),
    }) as ElectronParentPort;
    processWithParentPort().parentPort = parentPort;
    return parentPort;
  }

  it('receives and replies over Electron utilityProcess process.parentPort', async () => {
    const parentPort = installParentPort();

    await import('./codebase-indexing-lane-main');
    parentPort.emit('message', {
      data: {
        type: 'run-job',
        jobId: 'job-unsupported',
        jobType: 'unsupported-job',
        payload: { type: 'unsupported-job' },
      },
    });
    await flushMicrotasks();

    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ready', lane: 'indexing' }),
    );
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: 'job-failed',
      jobId: 'job-unsupported',
      errorMessage: 'Unsupported indexing lane job: unsupported-job',
    });
  });

  it('runs index-codebase jobs and returns only summary results', async () => {
    const parentPort = installParentPort();
    const instances: EventEmitter[] = [];

    vi.doMock('./indexing-service', () => ({
      CodebaseIndexingService: class FakeCodebaseIndexingService extends EventEmitter {
        cancel = vi.fn();

        constructor() {
          super();
          instances.push(this);
        }

        async indexCodebase(storeId: string, rootPath: string, _options: { force?: boolean }): Promise<IndexingStats> {
          this.emit('progress', {
            status: 'chunking',
            totalFiles: 10,
            processedFiles: 4,
            totalChunks: 12,
            currentFile: `${rootPath}/src/main.ts`,
          });
          return {
            filesIndexed: 10,
            chunksCreated: 30,
            tokensProcessed: 400,
            duration: 12,
            errors: [],
          };
        }
      },
    }));

    await import('./codebase-indexing-lane-main');
    parentPort.emit('message', {
      data: {
        type: 'run-job',
        jobId: 'job-1',
        jobType: 'index-codebase',
        payload: {
          type: 'index-codebase',
          rootPath: '/repo',
          storeId: 'codebase:test',
          force: true,
        },
      },
    });
    await flushMicrotasks();

    expect(instances).toHaveLength(1);
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: 'job-started',
      jobId: 'job-1',
      startedAt: expect.any(Number),
    });
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: 'job-progress',
      jobId: 'job-1',
      progress: {
        phase: 'chunking',
        completed: 4,
        total: 10,
        message: '/repo/src/main.ts',
      },
    });
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: 'job-succeeded',
      jobId: 'job-1',
      result: {
        rootPath: '/repo',
        filesIndexed: 10,
        chunksCreated: 30,
        tokensProcessed: 400,
        duration: 12,
        errors: [],
        completedAt: expect.any(Number),
      },
    });
  });

  it('LT-207: forwards a section:added fired by this lane\'s own RLMContextManager to main over the transport', async () => {
    const parentPort = installParentPort();

    // The lane worker owns a process-local `RLMContextManager` singleton
    // (see codebase-indexing-lane-main.ts's own `RLMContextManager` import).
    // Stub it as a real EventEmitter so `registerWorkerEventForwarding`
    // (called from `ensureWorkerEventForwarding`) can subscribe to it for
    // real, and so the fake indexing service below can emit on the exact
    // same instance the way `CodebaseIndexingService.addSection()` does in
    // production.
    vi.doMock('../rlm/context-manager', () => {
      const instance = Object.assign(new EventEmitter(), {
        reloadFromPersistence: vi.fn(),
      });
      return { RLMContextManager: { getInstance: () => instance } };
    });
    vi.doMock('./indexing-service', () => ({
      CodebaseIndexingService: class FakeCodebaseIndexingService extends EventEmitter {
        cancel = vi.fn();

        async indexCodebase(storeId: string): Promise<IndexingStats> {
          // Simulates CodebaseIndexingService.addSection() calling
          // `this.contextManager.addSection(...)`, which emits
          // 'section:added' on this worker's own RLMContextManager instance.
          const { RLMContextManager } = await import('../rlm/context-manager');
          const section = {
            id: 'sec-lt207',
            type: 'file' as const,
            name: 'lt207-sample.ts',
            content: 'private-index-content',
            tokens: 4,
            startOffset: 0,
            endOffset: 21,
            checksum: 'checksum-lt207',
            depth: 0,
          };
          RLMContextManager.getInstance().emit('section:added', {
            store: {
              id: storeId,
              instanceId: 'indexing-lane',
              sections: [section],
              totalTokens: 4,
              totalSize: 21,
              createdAt: 1,
              lastAccessed: 2,
              accessCount: 3,
              config: { kind: 'codebase-auto' },
            },
            section,
          });
          return {
            filesIndexed: 1,
            chunksCreated: 1,
            tokensProcessed: 0,
            duration: 1,
            errors: [],
          };
        }
      },
    }));

    await import('./codebase-indexing-lane-main');
    parentPort.emit('message', {
      data: {
        type: 'run-job',
        jobId: 'job-lt207',
        jobType: 'index-codebase',
        payload: {
          type: 'index-codebase',
          rootPath: '/repo',
          storeId: 'codebase:lt207-test',
          force: true,
        },
      },
    });
    await flushMicrotasks();

    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: 'worker-event',
      message: {
        type: 'worker-event',
        source: 'rlm-context',
        event: 'section:added',
        payload: {
          storeId: 'codebase:lt207-test',
          section: {
            id: 'sec-lt207',
            type: 'file',
            name: 'lt207-sample.ts',
            content: '',
            tokens: 4,
            startOffset: 0,
            endOffset: 21,
            checksum: 'checksum-lt207',
            depth: 0,
            summarizes: undefined,
          },
          highVolume: true,
          store: {
            id: 'codebase:lt207-test',
            instanceId: 'indexing-lane',
            sections: [{
              id: 'sec-lt207',
              type: 'file',
              name: 'lt207-sample.ts',
              content: '',
              tokens: 4,
              startOffset: 0,
              endOffset: 21,
              checksum: 'checksum-lt207',
              depth: 0,
              summarizes: undefined,
            }],
            totalTokens: 4,
            totalSize: 21,
            createdAt: 1,
            lastAccessed: 2,
            accessCount: 3,
            config: {
              kind: 'codebase-auto',
              ipcSectionCount: 1,
              ipcSectionsTruncated: false,
            },
          },
        },
      },
    });
  });

  it('reloads persisted RLM stores before each background indexing job', async () => {
    const parentPort = installParentPort();
    const events: string[] = [];

    vi.doMock('../rlm/context-manager', () => {
      // LT-207: `ensureWorkerEventForwarding()` resolves this worker-local
      // manager and injects it as the event source before the first reload.
      // The mock must therefore provide the EventEmitter surface used by the
      // forwarding subscription.
      const instance = Object.assign(new EventEmitter(), {
        reloadFromPersistence: () => events.push('reload'),
      });
      return { RLMContextManager: { getInstance: () => instance } };
    });
    vi.doMock('../persistence/rlm-database', () => ({
      RLMDatabase: {
        getInstance: (config: { dbPath: string; contentDir: string }) => {
          events.push(`database:${config.dbPath}:${config.contentDir}`);
          return {};
        },
      },
    }));
    vi.doMock('./indexing-service', () => ({
      CodebaseIndexingService: class FakeCodebaseIndexingService extends EventEmitter {
        cancel = vi.fn();

        async indexCodebase(): Promise<IndexingStats> {
          events.push('index');
          return {
            filesIndexed: 0,
            chunksCreated: 0,
            tokensProcessed: 0,
            duration: 1,
            errors: [],
          };
        }
      },
    }));

    await import('./codebase-indexing-lane-main');
    parentPort.emit('message', {
      data: {
        type: 'run-job',
        jobId: 'job-reload',
        jobType: 'index-codebase',
        payload: {
          type: 'index-codebase',
          rootPath: '/repo',
          storeId: 'codebase:created-after-lane-start',
          force: true,
          userDataPath: '/user-data',
        },
      },
    });
    await flushMicrotasks();

    expect(events).toEqual([
      // Production joins these with path.join, so match the host separator.
      `database:${join('/user-data', 'rlm', 'rlm.db')}:${join('/user-data', 'rlm', 'content')}`,
      'reload',
      'index',
    ]);
  });

  it('cancels an active index-codebase job cooperatively', async () => {
    const parentPort = installParentPort();
    let resolveStats!: (stats: IndexingStats) => void;
    const cancelCalls: string[] = [];

    vi.doMock('./indexing-service', () => ({
      CodebaseIndexingService: class FakeCodebaseIndexingService extends EventEmitter {
        private cancelled = false;

        cancel(): void {
          this.cancelled = true;
          cancelCalls.push('cancelled');
        }

        getProgress(): { status: string } {
          return { status: this.cancelled ? 'cancelled' : 'chunking' };
        }

        async indexCodebase(): Promise<IndexingStats> {
          return new Promise<IndexingStats>((resolve) => {
            resolveStats = resolve;
          });
        }
      },
    }));

    await import('./codebase-indexing-lane-main');
    parentPort.emit('message', {
      data: {
        type: 'run-job',
        jobId: 'job-cancel',
        jobType: 'index-codebase',
        payload: {
          type: 'index-codebase',
          rootPath: '/repo',
          storeId: 'codebase:test',
          force: false,
        },
      },
    });
    await flushMicrotasks();

    parentPort.emit('message', {
      data: {
        type: 'cancel-job',
        jobId: 'job-cancel',
      },
    });
    expect(cancelCalls).toEqual(['cancelled']);

    resolveStats({
      filesIndexed: 2,
      chunksCreated: 4,
      tokensProcessed: 0,
      duration: 1,
      errors: [],
    });
    await flushMicrotasks();

    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: 'job-cancelled',
      jobId: 'job-cancel',
    });
  });

  it('waits for active index-codebase jobs to acknowledge cancellation before shutdown exit', async () => {
    const parentPort = installParentPort();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    let resolveStats!: (stats: IndexingStats) => void;
    const cancelCalls: string[] = [];

    vi.doMock('./indexing-service', () => ({
      CodebaseIndexingService: class FakeCodebaseIndexingService extends EventEmitter {
        private cancelled = false;

        cancel(): void {
          this.cancelled = true;
          cancelCalls.push('cancelled');
        }

        getProgress(): { status: string } {
          return { status: this.cancelled ? 'cancelled' : 'chunking' };
        }

        async indexCodebase(): Promise<IndexingStats> {
          return new Promise<IndexingStats>((resolve) => {
            resolveStats = resolve;
          });
        }
      },
    }));

    await import('./codebase-indexing-lane-main');
    parentPort.emit('message', {
      data: {
        type: 'run-job',
        jobId: 'job-shutdown',
        jobType: 'index-codebase',
        payload: {
          type: 'index-codebase',
          rootPath: '/repo',
          storeId: 'codebase:test',
          force: false,
        },
      },
    });
    await flushMicrotasks();

    parentPort.emit('message', {
      data: { type: 'shutdown' },
    });

    expect(cancelCalls).toEqual(['cancelled']);
    expect(exitSpy).not.toHaveBeenCalled();

    resolveStats({
      filesIndexed: 2,
      chunksCreated: 4,
      tokensProcessed: 0,
      duration: 1,
      errors: [],
    });
    await flushMicrotasks();

    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: 'job-cancelled',
      jobId: 'job-shutdown',
    });
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it('exhaustively dispatches bounded maintenance and file jobs with deletions before upserts', async () => {
    const parentPort = installParentPort();
    const calls: string[] = [];

    vi.doMock('../rlm/context-manager', () => {
      const instance = Object.assign(new EventEmitter(), {
        reloadFromPersistence: vi.fn(),
      });
      return { RLMContextManager: { getInstance: () => instance } };
    });
    vi.doMock('./indexing-service', () => ({
      CodebaseIndexingService: class FakeCodebaseIndexingService extends EventEmitter {
        cancel = vi.fn();

        async indexFile(storeId: string, filePath: string): Promise<void> {
          calls.push(`index:${storeId}:${filePath}`);
          if (filePath.endsWith('bad.ts')) throw new Error('parse failed');
        }

        async removeFile(storeId: string, filePath: string): Promise<void> {
          calls.push(`remove:${storeId}:${filePath}`);
        }

        async getStats(storeId: string): Promise<{
          storeId: string;
          totalFiles: number;
          totalChunks: number;
          totalTokens: number;
          lastIndexedAt: number;
          indexSize: number;
        }> {
          calls.push(`stats:${storeId}`);
          return {
            storeId,
            totalFiles: 2,
            totalChunks: 4,
            totalTokens: 20,
            lastIndexedAt: 100,
            indexSize: 200,
          };
        }

        async clearLegacyCodebaseStore(storeId: string): Promise<void> {
          calls.push(`clear:${storeId}`);
        }
      },
    }));

    await import('./codebase-indexing-lane-main');
    const jobs = [
      {
        jobId: 'job-index-file',
        jobType: 'index-file',
        payload: { type: 'index-file', storeId: 'store', filePath: '/repo/one.ts' },
      },
      {
        jobId: 'job-remove-file',
        jobType: 'remove-file',
        payload: { type: 'remove-file', storeId: 'store', filePath: '/repo/old.ts' },
      },
      {
        jobId: 'job-stats',
        jobType: 'get-stats',
        payload: { type: 'get-stats', storeId: 'store' },
      },
      {
        jobId: 'job-clear',
        jobType: 'clear-legacy-store',
        payload: { type: 'clear-legacy-store', storeId: 'store' },
      },
      {
        jobId: 'job-sync',
        jobType: 'sync-files',
        payload: {
          type: 'sync-files',
          storeId: 'store',
          deletions: ['/repo/delete-a.ts', '/repo/delete-b.ts'],
          upserts: ['/repo/good.ts', '/repo/bad.ts'],
        },
      },
    ];

    for (const job of jobs) {
      parentPort.emit('message', { data: { type: 'run-job', ...job } });
      await flushMicrotasks();
    }

    expect(calls).toEqual([
      'index:store:/repo/one.ts',
      'remove:store:/repo/old.ts',
      'stats:store',
      'clear:store',
      'remove:store:/repo/delete-a.ts',
      'remove:store:/repo/delete-b.ts',
      'index:store:/repo/good.ts',
      'index:store:/repo/bad.ts',
    ]);
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: 'job-succeeded',
      jobId: 'job-stats',
      result: {
        storeId: 'store',
        totalFiles: 2,
        totalChunks: 4,
        totalTokens: 20,
        lastIndexedAt: 100,
        indexSize: 200,
      },
    });
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      type: 'job-succeeded',
      jobId: 'job-sync',
      result: {
        outcomes: [
          { operation: 'removed', filePath: '/repo/delete-a.ts', success: true },
          { operation: 'removed', filePath: '/repo/delete-b.ts', success: true },
          { operation: 'indexed', filePath: '/repo/good.ts', success: true },
          {
            operation: 'indexed',
            filePath: '/repo/bad.ts',
            success: false,
            error: 'parse failed',
          },
        ],
      },
    });
  });

  it('rejects oversized or job-type-mismatched payloads before constructing an owner', async () => {
    const parentPort = installParentPort();
    const managerFactory = vi.fn();
    const serviceFactory = vi.fn();
    vi.doMock('../rlm/context-manager', () => ({
      RLMContextManager: { getInstance: managerFactory },
    }));
    vi.doMock('./indexing-service', () => ({
      CodebaseIndexingService: serviceFactory,
    }));

    await import('./codebase-indexing-lane-main');
    parentPort.emit('message', {
      data: {
        type: 'run-job',
        jobId: 'job-too-large',
        jobType: 'sync-files',
        payload: {
          type: 'sync-files',
          storeId: 'store',
          deletions: [],
          upserts: Array.from({ length: 257 }, (_, index) => `/repo/${index}.ts`),
        },
      },
    });
    parentPort.emit('message', {
      data: {
        type: 'run-job',
        jobId: 'job-mismatch',
        jobType: 'remove-file',
        payload: { type: 'index-file', storeId: 'store', filePath: '/repo/file.ts' },
      },
    });
    await flushMicrotasks();

    expect(parentPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'job-failed',
      jobId: 'job-too-large',
      errorMessage: expect.stringMatching(/at most 256/i),
    }));
    expect(parentPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'job-failed',
      jobId: 'job-mismatch',
      errorMessage: expect.stringMatching(/does not match/i),
    }));
    expect(serviceFactory).not.toHaveBeenCalled();
    expect(managerFactory).not.toHaveBeenCalled();
  });

  it('rejects duplicate and overlapping sync paths before owner construction or file effects', async () => {
    const parentPort = installParentPort();
    const databaseFactory = vi.fn(() => ({}));
    const managerFactory = vi.fn(() => Object.assign(new EventEmitter(), {
      reloadFromPersistence: vi.fn(),
    }));
    const serviceFactory = vi.fn();
    const removeFile = vi.fn(async () => undefined);
    const indexFile = vi.fn(async () => undefined);
    vi.doMock('../persistence/rlm-database', () => ({
      RLMDatabase: { getInstance: databaseFactory },
    }));
    vi.doMock('../rlm/context-manager', () => ({
      RLMContextManager: { getInstance: managerFactory },
    }));
    vi.doMock('./indexing-service', () => ({
      CodebaseIndexingService: class FakeCodebaseIndexingService extends EventEmitter {
        cancel = vi.fn();
        removeFile = removeFile;
        indexFile = indexFile;

        constructor() {
          super();
          serviceFactory();
        }
      },
    }));

    await import('./codebase-indexing-lane-main');
    const invalidPayloads = [
      { deletions: ['/repo/a.ts', '/repo/a.ts'], upserts: [] },
      { deletions: [], upserts: ['/repo/a.ts', '/repo/a.ts'] },
      { deletions: ['/repo/a.ts'], upserts: ['/repo/a.ts'] },
    ];
    for (const [index, payload] of invalidPayloads.entries()) {
      parentPort.emit('message', {
        data: {
          type: 'run-job',
          jobId: `job-invalid-paths-${index}`,
          jobType: 'sync-files',
          payload: {
            type: 'sync-files',
            storeId: 'store',
            userDataPath: '/user-data',
            ...payload,
          },
        },
      });
    }
    await flushMicrotasks(12);

    for (const index of invalidPayloads.keys()) {
      expect(parentPort.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        type: 'job-failed',
        jobId: `job-invalid-paths-${index}`,
        errorMessage: expect.stringMatching(/duplicate|overlap|unique/i),
      }));
    }
    expect(databaseFactory).not.toHaveBeenCalled();
    expect(managerFactory).not.toHaveBeenCalled();
    expect(serviceFactory).not.toHaveBeenCalled();
    expect(removeFile).not.toHaveBeenCalled();
    expect(indexFile).not.toHaveBeenCalled();
  });
});
