import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { CodebaseIndexingLaneGateway, type CodebaseIndexingLaneGatewayOptions } from './codebase-indexing-lane-gateway';
import type {
  BackgroundJobProgress,
  BackgroundJobRecord,
  BackgroundJobSnapshot,
  BackgroundJobSubmission,
} from '../background-jobs';

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
