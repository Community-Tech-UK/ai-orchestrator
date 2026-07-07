import { EventEmitter } from 'node:events';
import Module from 'node:module';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  childProcessFork: vi.fn(),
  utilityProcessFork: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  default: { fork: mocks.childProcessFork },
  fork: mocks.childProcessFork,
}));

import { ProcessLaneGateway } from '../process-lane-gateway';
import type { BackgroundJobRecord } from '../types';

type FakeChild = EventEmitter & {
  postMessage: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  terminate?: ReturnType<typeof vi.fn>;
};

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.postMessage = vi.fn();
  child.send = vi.fn();
  child.kill = vi.fn();
  child.terminate = vi.fn().mockResolvedValue(undefined);
  return child;
}

function makeJob(id = 'job-1'): BackgroundJobRecord {
  return {
    id,
    lane: 'indexing',
    type: 'index-codebase',
    priority: 'normal',
    createdAt: 100,
    status: 'running',
  };
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('lane gateways', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.childProcessFork.mockReset();
    mocks.utilityProcessFork.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('ProcessLaneGateway sends compact run-job messages and resolves job-succeeded results', async () => {
    const child = createFakeChild();
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: () => child,
      requestTimeoutMs: 1_000,
    });

    await gateway.start();
    const promise = gateway.runJob(makeJob(), { rootPath: '/repo', force: false });
    const message = child.postMessage.mock.calls[0]?.[0] as {
      type: string;
      jobId: string;
      jobType: string;
      payload: unknown;
    };

    expect(message.type).toBe('run-job');
    expect(message.jobId).toBe('job-1');
    expect(message.jobType).toBe('index-codebase');
    expect(message.payload).toEqual({ rootPath: '/repo', force: false });

    child.emit('message', {
      type: 'job-succeeded',
      jobId: message.jobId,
      result: { filesIndexed: 2 },
    });

    await expect(promise).resolves.toEqual({ filesIndexed: 2 });
  });

  it('rejects pending jobs from job-failed and job-cancelled lane messages', async () => {
    const child = createFakeChild();
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: () => child,
    });

    await gateway.start();
    const failed = gateway.runJob(makeJob('failed-job'), {});
    child.emit('message', {
      type: 'job-failed',
      jobId: 'failed-job',
      errorMessage: 'index blew up',
    });
    await expect(failed).rejects.toThrow('index blew up');

    const cancelled = gateway.runJob(makeJob('cancelled-job'), {});
    child.emit('message', {
      type: 'job-cancelled',
      jobId: 'cancelled-job',
    });
    await expect(cancelled).rejects.toThrow(/cancelled/i);
  });

  it('emits progress messages from process lanes', async () => {
    const child = createFakeChild();
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: () => child,
    });
    const listener = vi.fn();
    gateway.on('progress', listener);

    await gateway.start();
    child.emit('message', {
      type: 'job-progress',
      jobId: 'job-1',
      progress: { phase: 'chunking', completed: 1, total: 5 },
    });

    expect(listener).toHaveBeenCalledWith({
      jobId: 'job-1',
      lane: 'indexing',
      progress: { phase: 'chunking', completed: 1, total: 5 },
    });
  });

  it('marks the process lane degraded when a request times out', async () => {
    const child = createFakeChild();
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: () => child,
      requestTimeoutMs: 25,
    });

    await gateway.start();
    const promise = gateway.runJob(makeJob(), {});
    vi.advanceTimersByTime(26);

    await expect(promise).rejects.toThrow(/timed out/i);
    expect(gateway.getMetrics().degraded).toBe(true);
  });

  it('keeps long-running jobs alive while the lane continues heartbeating', async () => {
    const child = createFakeChild();
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: () => child,
      requestTimeoutMs: 25,
    });

    await gateway.start();
    const promise = gateway.runJob(makeJob(), {});
    const rejected = vi.fn();
    void promise.catch(rejected);

    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(20);
      child.emit('message', {
        type: 'heartbeat',
        lane: 'indexing',
        timestamp: Date.now(),
      });
      await flushMicrotasks();
      expect(rejected).not.toHaveBeenCalled();
    }

    child.emit('message', {
      type: 'job-succeeded',
      jobId: 'job-1',
      result: { ok: true },
    });

    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('restarts an inactive process before accepting another job after request timeout', async () => {
    const first = createFakeChild();
    const second = createFakeChild();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      requestTimeoutMs: 25,
      restartBackoffMs: 10,
      maxRestarts: 2,
    });

    await gateway.start();
    const timedOut = gateway.runJob(makeJob('stuck-job'), {});

    vi.advanceTimersByTime(26);

    await expect(timedOut).rejects.toThrow(/timed out/i);
    expect(first.terminate).toHaveBeenCalled();
    expect(gateway.getMetrics().restarted).toBe(1);

    const nextJob = gateway.runJob(makeJob('next-job'), { rootPath: '/repo' });
    await flushMicrotasks();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(first.postMessage).toHaveBeenCalledTimes(1);
    expect(second.postMessage).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10);
    await flushMicrotasks();

    expect(factory).toHaveBeenCalledTimes(2);
    expect(second.postMessage).toHaveBeenCalledWith({
      type: 'run-job',
      jobId: 'next-job',
      jobType: 'index-codebase',
      payload: { rootPath: '/repo' },
    });

    second.emit('message', {
      type: 'job-succeeded',
      jobId: 'next-job',
      result: { ok: true },
    });

    await expect(nextJob).resolves.toEqual({ ok: true });
  });

  it('sends cancel-job messages to process lanes', async () => {
    const child = createFakeChild();
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: () => child,
    });

    await gateway.start();
    await gateway.cancelJob('job-1');

    expect(child.postMessage).toHaveBeenCalledWith({
      type: 'cancel-job',
      jobId: 'job-1',
    });
  });

  it('allows process lanes to exit after shutdown before terminating them', async () => {
    const child = createFakeChild();
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: () => child,
      shutdownTimeoutMs: 1_000,
    });

    await gateway.start();
    const stopPromise = gateway.stop();

    expect(child.postMessage).toHaveBeenCalledWith({ type: 'shutdown' });
    expect(child.terminate).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();

    child.emit('exit', 0);
    await stopPromise;

    expect(child.terminate).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('falls back to child_process with tsx for TypeScript process lane entrypoints', async () => {
    const child = createFakeChild();
    const utilityChild = createFakeChild();
    mocks.childProcessFork.mockReturnValue(child);
    mocks.utilityProcessFork.mockReturnValue(utilityChild);
    const moduleWithLoad = Module as unknown as {
      _load: (request: string, parent?: unknown, isMain?: boolean) => unknown;
    };
    const originalLoad = moduleWithLoad._load;
    const moduleLoadSpy = vi
      .spyOn(moduleWithLoad, '_load')
      .mockImplementation((request: string, parent?: unknown, isMain?: boolean) => {
        if (request === 'electron') {
          return {
            app: { isPackaged: false },
            utilityProcess: {
              fork: mocks.utilityProcessFork,
            },
          };
        }
        return originalLoad(request, parent, isMain);
      });

    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.ts',
    });

    try {
      await gateway.start();

      expect(mocks.utilityProcessFork).not.toHaveBeenCalled();
      expect(mocks.childProcessFork).toHaveBeenCalledWith('/tmp/index-lane.ts', [], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
    } finally {
      moduleLoadSpy.mockRestore();
    }
  });

  it('uses exponential backoff on repeated process crashes and exposes degraded state', async () => {
    const first = createFakeChild();
    const second = createFakeChild();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      restartBackoffMs: 10,
      maxRestarts: 1,
    });

    await gateway.start();
    first.emit('exit', 1);
    expect(gateway.getMetrics().degraded).toBe(true);

    vi.advanceTimersByTime(10);
    expect(factory).toHaveBeenCalledTimes(2);

    second.emit('exit', 1);
    expect(gateway.getMetrics().degraded).toBe(true);
    vi.advanceTimersByTime(100);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('retries process startup failures with backoff', async () => {
    const child = createFakeChild();
    const factory = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('spawn failed');
      })
      .mockReturnValueOnce(child);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      restartBackoffMs: 10,
      maxRestarts: 2,
    });

    await gateway.start();

    expect(gateway.getMetrics().degraded).toBe(true);
    expect(gateway.getMetrics().restarted).toBe(1);

    vi.advanceTimersByTime(10);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(gateway.getMetrics().degraded).toBe(false);
  });

  it('waits for a startup retry before failing a submitted job', async () => {
    const child = createFakeChild();
    const factory = vi.fn()
      .mockImplementationOnce(() => {
        throw new Error('spawn failed');
      })
      .mockReturnValueOnce(child);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      restartBackoffMs: 10,
      maxRestarts: 2,
      requestTimeoutMs: 1_000,
    });

    const promise = gateway.runJob(makeJob(), { rootPath: '/repo' });
    const rejected = vi.fn();
    void promise.catch(rejected);

    await flushMicrotasks();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(child.postMessage).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();

    vi.advanceTimersByTime(10);
    await flushMicrotasks();

    expect(factory).toHaveBeenCalledTimes(2);
    expect(child.postMessage).toHaveBeenCalledWith({
      type: 'run-job',
      jobId: 'job-1',
      jobType: 'index-codebase',
      payload: { rootPath: '/repo' },
    });

    child.emit('message', {
      type: 'job-succeeded',
      jobId: 'job-1',
      result: { ok: true },
    });

    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('handles one process crash once when error and exit both fire for the same handle', async () => {
    const first = createFakeChild();
    const second = createFakeChild();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      restartBackoffMs: 10,
      maxRestarts: 3,
    });

    await gateway.start();
    first.emit('error', new Error('lane crashed'));
    first.emit('exit', 1);

    expect(gateway.getMetrics().restarted).toBe(1);
    vi.advanceTimersByTime(10);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('cancels a scheduled process restart when the gateway stops', async () => {
    const first = createFakeChild();
    const second = createFakeChild();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      restartBackoffMs: 10,
      maxRestarts: 3,
    });

    await gateway.start();
    first.emit('exit', 1);
    expect(gateway.getMetrics().restarted).toBe(1);

    await gateway.stop();
    vi.advanceTimersByTime(10);

    expect(factory).toHaveBeenCalledTimes(1);
  });

});
