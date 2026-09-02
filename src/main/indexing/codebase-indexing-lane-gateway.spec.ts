import { EventEmitter } from 'node:events';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { CodebaseIndexingLaneGateway, type CodebaseIndexingLaneGatewayOptions } from './codebase-indexing-lane-gateway';
import type {
  BackgroundJobProgress,
  BackgroundJobRecord,
  BackgroundJobSnapshot,
  BackgroundJobSubmission,
} from '../background-jobs';
import {
  _resetContextWorkerEventRelayForTesting,
  getContextWorkerEventRelay,
} from '../instance/context-worker-event-relay';
import {
  setupRlmEventForwarding,
  teardownRlmEventForwarding,
} from '../ipc/ipc-main-runtime-wiring';
import { IPC_CHANNELS } from '@contracts/channels';
import type { WindowManager } from '../window-manager';

class FakeRuntime extends EventEmitter {
  enqueueAndWait = vi.fn<(submission: BackgroundJobSubmission) => Promise<unknown>>(async () => ({
    rootPath: '/repo',
    filesIndexed: 7,
    chunksCreated: 21,
    tokensProcessed: 400,
    duration: 12,
    errors: [{ file: '/repo/src/bad.ts', error: 'bad import', recoverable: true }],
    completedAt: 1_000,
  }));
  snapshot = vi.fn((): BackgroundJobSnapshot => ({ queued: [], running: [], terminal: [] }));
  cancel = vi.fn(async () => true);
}

type FakeRuntimeOption = CodebaseIndexingLaneGatewayOptions['runtime'];

describe('CodebaseIndexingLaneGateway', () => {
  afterEach(() => {
    teardownRlmEventForwarding();
    _resetContextWorkerEventRelayForTesting();
  });

  it('enqueues legacy index-codebase work on the indexing lane', async () => {
    const runtime = new FakeRuntime();
    const gateway = new CodebaseIndexingLaneGateway({
      runtime: runtime as unknown as FakeRuntimeOption,
    });

    const result = await gateway.runIndexCodebase({
      type: 'index-codebase',
      rootPath: '/repo',
      storeId: 'codebase:test',
      force: true,
    });

    expect(runtime.enqueueAndWait).toHaveBeenCalledWith(expect.objectContaining({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'background',
      coalesceKey: '/repo',
      idempotent: true,
      payload: {
        type: 'index-codebase',
        rootPath: '/repo',
        storeId: 'codebase:test',
        force: true,
      },
    }));
    expect(result).toEqual({
      rootPath: '/repo',
      filesIndexed: 7,
      chunksCreated: 21,
      tokensProcessed: 400,
      duration: 12,
      errors: [{ file: '/repo/src/bad.ts', error: 'bad import', recoverable: true }],
      completedAt: 1_000,
    });
  });

  it('passes the Harness user-data path to the indexing lane', async () => {
    const runtime = new FakeRuntime();
    const gateway = new CodebaseIndexingLaneGateway({
      runtime: runtime as unknown as FakeRuntimeOption,
      userDataPath: '/user-data',
    });

    await gateway.runIndexCodebase({
      type: 'index-codebase',
      rootPath: '/repo',
      storeId: 'codebase:test',
    });

    expect(runtime.enqueueAndWait).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ userDataPath: '/user-data' }),
    }));
  });

  it('rejects malformed indexing lane results', async () => {
    const runtime = new FakeRuntime();
    runtime.enqueueAndWait.mockResolvedValueOnce({
      rootPath: '/repo',
      filesIndexed: '7',
      chunksCreated: 21,
      completedAt: 1_000,
    });
    const gateway = new CodebaseIndexingLaneGateway({
      runtime: runtime as unknown as FakeRuntimeOption,
    });

    await expect(gateway.runIndexCodebase({
      type: 'index-codebase',
      rootPath: '/repo',
      storeId: 'codebase:test',
      force: true,
    })).rejects.toThrow(/invalid indexing lane result/i);
  });

  it('maps runtime progress to legacy indexing progress events', () => {
    const runtime = new FakeRuntime();
    const gateway = new CodebaseIndexingLaneGateway({
      runtime: runtime as unknown as FakeRuntimeOption,
    });
    const listener = vi.fn();
    gateway.on('progress', listener);

    runtime.emit('progress', {
      job: {
        id: 'job-1',
        lane: 'indexing',
        type: 'index-codebase',
        priority: 'background',
        createdAt: 1,
        status: 'running',
        coalesceKey: '/repo',
      },
      progress: {
        phase: 'chunking',
        completed: 3,
        total: 9,
        message: '/repo/src/auth.ts',
      } satisfies BackgroundJobProgress,
    });

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      status: 'chunking',
      processedFiles: 3,
      totalFiles: 9,
      currentFile: '/repo/src/auth.ts',
      rootPath: '/repo',
    }));
  });

  it('LT-207: dispatches a worker-event broadcast from the indexing lane onto the RLM relay', () => {
    const received: unknown[] = [];
    const listener = (payload: unknown) => received.push(payload);
    getContextWorkerEventRelay().on('section:added', listener);

    const runtime = new FakeRuntime();
    new CodebaseIndexingLaneGateway({ runtime: runtime as unknown as FakeRuntimeOption });

    const payload = {
      storeId: 'codebase:lt207-gateway-test',
      section: {
        id: 'sec-lt207-gw',
        type: 'file' as const,
        name: 'lt207-gateway.ts',
        content: '',
        tokens: 1,
        startOffset: 0,
        endOffset: 1,
        checksum: 'checksum-gateway',
        depth: 0,
      },
      highVolume: true,
      store: {
        id: 'codebase:lt207-gateway-test',
        instanceId: 'indexing-lane',
        sections: [],
        totalTokens: 1,
        totalSize: 1,
        createdAt: 1,
        lastAccessed: 2,
        accessCount: 3,
      },
    };
    runtime.emit('worker-event', {
      type: 'worker-event',
      source: 'rlm-context',
      event: 'section:added',
      payload,
    });

    expect(received).toEqual([payload]);
  });

  it('delivers an indexing-lane RLM DTO through the relay to the existing renderer channel', () => {
    const runtime = new FakeRuntime();
    const windowManager = {
      sendToRenderer: vi.fn(),
    } as unknown as WindowManager;
    setupRlmEventForwarding(windowManager);
    new CodebaseIndexingLaneGateway({ runtime: runtime as unknown as FakeRuntimeOption });

    const payload = {
      storeId: 'store-indexing',
      section: {
        id: 'section-indexing',
        type: 'file' as const,
        name: 'indexing.ts',
        content: '',
        tokens: 1,
        startOffset: 0,
        endOffset: 1,
        checksum: 'checksum-indexing',
        depth: 0,
      },
      highVolume: false,
      store: {
        id: 'store-indexing',
        instanceId: 'indexing-lane',
        sections: [],
        totalTokens: 1,
        totalSize: 1,
        createdAt: 1,
        lastAccessed: 2,
        accessCount: 3,
      },
    };
    runtime.emit('worker-event', {
      type: 'worker-event',
      source: 'rlm-context',
      event: 'section:added',
      payload,
    });

    expect(windowManager.sendToRenderer).toHaveBeenNthCalledWith(
      1,
      IPC_CHANNELS.RLM_SECTION_ADDED,
      { storeId: payload.storeId, section: payload.section },
    );
    expect(windowManager.sendToRenderer).toHaveBeenNthCalledWith(
      2,
      IPC_CHANNELS.RLM_STORE_UPDATED,
      { storeId: payload.storeId, store: payload.store },
    );
  });

  it('implements AutoIndexingTarget.indexCodebase for the auto coordinator', async () => {
    const runtime = new FakeRuntime();
    const gateway = new CodebaseIndexingLaneGateway({
      runtime: runtime as unknown as FakeRuntimeOption,
    });

    await expect(gateway.indexCodebase('codebase:test', '/repo', { force: false }))
      .resolves.toEqual(expect.objectContaining({
        filesIndexed: 7,
        chunksCreated: 21,
        tokensProcessed: 400,
        duration: 12,
        errors: [{ file: '/repo/src/bad.ts', error: 'bad import', recoverable: true }],
      }));
  });

  it('routes single-file, removal, stats, and legacy-clear operations through typed lane jobs', async () => {
    const runtime = new FakeRuntime();
    runtime.enqueueAndWait
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({
        storeId: 'codebase:test',
        totalFiles: 4,
        totalChunks: 12,
        totalTokens: 90,
        lastIndexedAt: 1_000,
        indexSize: 2_048,
      })
      .mockResolvedValueOnce(undefined);
    const gateway = new CodebaseIndexingLaneGateway({
      runtime: runtime as unknown as FakeRuntimeOption,
      userDataPath: '/user-data',
    });

    await gateway.indexFile('codebase:test', '/repo/src/add.ts');
    await gateway.removeFile('codebase:test', '/repo/src/remove.ts');
    await expect(gateway.getStats('codebase:test')).resolves.toEqual({
      storeId: 'codebase:test',
      totalFiles: 4,
      totalChunks: 12,
      totalTokens: 90,
      lastIndexedAt: 1_000,
      indexSize: 2_048,
    });
    await gateway.clearLegacyCodebaseStore('codebase:test');

    expect(runtime.enqueueAndWait.mock.calls.map(([submission]) => submission)).toEqual([
      expect.objectContaining({
        lane: 'indexing',
        type: 'index-file',
        payload: {
          type: 'index-file',
          storeId: 'codebase:test',
          filePath: '/repo/src/add.ts',
          userDataPath: '/user-data',
        },
      }),
      expect.objectContaining({
        lane: 'indexing',
        type: 'remove-file',
        payload: {
          type: 'remove-file',
          storeId: 'codebase:test',
          filePath: '/repo/src/remove.ts',
          userDataPath: '/user-data',
        },
      }),
      expect.objectContaining({
        lane: 'indexing',
        type: 'get-stats',
        payload: {
          type: 'get-stats',
          storeId: 'codebase:test',
          userDataPath: '/user-data',
        },
      }),
      expect.objectContaining({
        lane: 'indexing',
        type: 'clear-legacy-store',
        payload: {
          type: 'clear-legacy-store',
          storeId: 'codebase:test',
          userDataPath: '/user-data',
        },
      }),
    ]);
  });

  it('submits one bounded sync-files lane job and validates its per-file outcomes', async () => {
    const runtime = new FakeRuntime();
    runtime.enqueueAndWait.mockResolvedValueOnce({
      outcomes: [
        { operation: 'removed', filePath: '/repo/old.ts', success: true },
        { operation: 'indexed', filePath: '/repo/new.ts', success: false, error: 'parse failed' },
      ],
    });
    const gateway = new CodebaseIndexingLaneGateway({
      runtime: runtime as unknown as FakeRuntimeOption,
    });

    await expect(gateway.syncFiles(
      'codebase:test',
      ['/repo/old.ts'],
      ['/repo/new.ts'],
    )).resolves.toEqual({
      outcomes: [
        { operation: 'removed', filePath: '/repo/old.ts', success: true },
        { operation: 'indexed', filePath: '/repo/new.ts', success: false, error: 'parse failed' },
      ],
    });

    expect(runtime.enqueueAndWait).toHaveBeenCalledWith(expect.objectContaining({
      lane: 'indexing',
      type: 'sync-files',
      priority: 'background',
      payload: {
        type: 'sync-files',
        storeId: 'codebase:test',
        deletions: ['/repo/old.ts'],
        upserts: ['/repo/new.ts'],
      },
    }));
    expect(runtime.enqueueAndWait.mock.calls[0]?.[0]).not.toHaveProperty('coalesceKey');
  });

  it('rejects sync-files results that do not exactly match every requested operation and path', async () => {
    const invalidResults = [
      {
        outcomes: [
          { operation: 'removed', filePath: '/repo/old.ts', success: true },
        ],
      },
      {
        outcomes: [
          { operation: 'removed', filePath: '/repo/old.ts', success: true },
          { operation: 'indexed', filePath: '/repo/new.ts', success: true },
          { operation: 'indexed', filePath: '/repo/extra.ts', success: true },
        ],
      },
      {
        outcomes: [
          { operation: 'removed', filePath: '/repo/old.ts', success: true },
          { operation: 'removed', filePath: '/repo/old.ts', success: false, error: 'duplicate' },
        ],
      },
      {
        outcomes: [
          { operation: 'indexed', filePath: '/repo/old.ts', success: true },
          { operation: 'indexed', filePath: '/repo/new.ts', success: true },
        ],
      },
    ];

    for (const invalidResult of invalidResults) {
      const runtime = new FakeRuntime();
      runtime.enqueueAndWait.mockResolvedValueOnce(invalidResult);
      const gateway = new CodebaseIndexingLaneGateway({
        runtime: runtime as unknown as FakeRuntimeOption,
      });

      await expect(gateway.syncFiles(
        'codebase:test',
        ['/repo/old.ts'],
        ['/repo/new.ts'],
      )).rejects.toThrow(/does not exactly match requested files/i);
    }
  });

  it('rejects oversized sync-files batches before they enter the runtime', async () => {
    const runtime = new FakeRuntime();
    const gateway = new CodebaseIndexingLaneGateway({
      runtime: runtime as unknown as FakeRuntimeOption,
    });
    const tooManyPaths = Array.from({ length: 257 }, (_, index) => `/repo/file-${index}.ts`);

    await expect(gateway.syncFiles('codebase:test', [], tooManyPaths))
      .rejects.toThrow(/at most 256/i);
    expect(runtime.enqueueAndWait).not.toHaveBeenCalled();
  });

  it('rejects duplicate and overlapping sync paths before runtime enqueue', async () => {
    const invalidRequests = [
      { deletions: ['/repo/a.ts', '/repo/a.ts'], upserts: [] },
      { deletions: [], upserts: ['/repo/a.ts', '/repo/a.ts'] },
      { deletions: ['/repo/a.ts'], upserts: ['/repo/a.ts'] },
    ];

    for (const request of invalidRequests) {
      const runtime = new FakeRuntime();
      const gateway = new CodebaseIndexingLaneGateway({
        runtime: runtime as unknown as FakeRuntimeOption,
      });

      await expect(gateway.syncFiles(
        'codebase:test',
        request.deletions,
        request.upserts,
      )).rejects.toThrow(/duplicate|overlap|unique/i);
      expect(runtime.enqueueAndWait).not.toHaveBeenCalled();
    }
  });

  it('rejects non-void results for file mutation jobs', async () => {
    const runtime = new FakeRuntime();
    runtime.enqueueAndWait.mockResolvedValueOnce({ unexpected: true });
    const gateway = new CodebaseIndexingLaneGateway({
      runtime: runtime as unknown as FakeRuntimeOption,
    });

    await expect(gateway.indexFile('codebase:test', '/repo/file.ts'))
      .rejects.toThrow(/invalid indexing lane void result/i);
  });

  it('cancels queued and running legacy indexing lane jobs for a root path', async () => {
    const runtime = new FakeRuntime();
    const queuedJob = makeJob('queued-job', '/repo', 'queued');
    const runningJob = makeJob('running-job', '/repo', 'running');
    const otherJob = makeJob('other-job', '/other', 'running');
    runtime.snapshot.mockReturnValue({
      queued: [queuedJob],
      running: [runningJob, otherJob],
      terminal: [],
    });
    const gateway = new CodebaseIndexingLaneGateway({
      runtime: runtime as unknown as FakeRuntimeOption,
    });

    await expect(gateway.cancelIndexCodebase('/repo')).resolves.toBe(2);

    expect(runtime.cancel).toHaveBeenCalledTimes(2);
    expect(runtime.cancel).toHaveBeenCalledWith('queued-job');
    expect(runtime.cancel).toHaveBeenCalledWith('running-job');
    expect(runtime.cancel).not.toHaveBeenCalledWith('other-job');
  });

  it('reports legacy indexing progress from runtime snapshots', () => {
    const runtime = new FakeRuntime();
    runtime.snapshot.mockReturnValue({
      queued: [],
      running: [{
        ...makeJob('running-job', '/repo', 'running'),
        progress: {
          phase: 'scanning',
          completed: 5,
          total: 10,
          message: '/repo/src/auth.ts',
        },
      }],
      terminal: [],
    });
    const gateway = new CodebaseIndexingLaneGateway({
      runtime: runtime as unknown as FakeRuntimeOption,
    });

    expect(gateway.getIndexCodebaseProgress('/repo')).toEqual(expect.objectContaining({
      status: 'scanning',
      rootPath: '/repo',
      processedFiles: 5,
      totalFiles: 10,
      currentFile: '/repo/src/auth.ts',
    }));
  });
});

function makeJob(
  id: string,
  rootPath: string,
  status: BackgroundJobRecord['status'],
): BackgroundJobRecord {
  return {
    id,
    lane: 'indexing',
    type: 'index-codebase',
    priority: 'background',
    coalesceKey: rootPath,
    createdAt: 1,
    status,
  };
}
