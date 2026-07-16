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

        async indexCodebase(storeId: string, rootPath: string, options: { force?: boolean }): Promise<IndexingStats> {
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

  it('reloads persisted RLM stores before each background indexing job', async () => {
    const parentPort = installParentPort();
    const events: string[] = [];

    vi.doMock('../rlm/context-manager', () => ({
      RLMContextManager: {
        getInstance: () => ({ reloadFromPersistence: () => events.push('reload') }),
      },
    }));
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
});
