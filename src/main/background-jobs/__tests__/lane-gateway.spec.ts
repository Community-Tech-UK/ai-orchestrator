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

  it('keeps transient crash recovery demand-driven and uses one fresh process for the next job', async () => {
    const first = createFakeChild();
    const second = createFakeChild();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      transient: true,
      restartBackoffMs: 10,
      maxRestarts: 2,
    });

    const crashed = gateway.runJob(makeJob('crashed-job'), {});
    void crashed.catch(() => undefined);
    await flushMicrotasks();
    first.emit('exit', 1);

    await expect(crashed).rejects.toThrow(/exited with code 1/i);
    expect(gateway.getMetrics()).toMatchObject({
      degraded: true,
      inFlight: 0,
      restarted: 0,
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(factory).toHaveBeenCalledTimes(1);

    const next = gateway.runJob(makeJob('after-crash'), { rootPath: '/repo' });
    await flushMicrotasks();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(gateway.getMetrics().restarted).toBe(1);

    await vi.advanceTimersByTimeAsync(10);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(second.postMessage).toHaveBeenCalledWith({
      type: 'run-job',
      jobId: 'after-crash',
      jobType: 'index-codebase',
      payload: { rootPath: '/repo' },
    });

    second.emit('message', {
      type: 'job-succeeded',
      jobId: 'after-crash',
      result: { recovered: true },
    });
    second.emit('exit', 0);

    await expect(next).resolves.toEqual({ recovered: true });
  });

  it('retires an errored transient handle before a successor can own work', async () => {
    const first = createFakeChild();
    first.terminate = vi.fn(() => new Promise<unknown>(() => undefined));
    const second = createFakeChild();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      transient: true,
      restartBackoffMs: 10,
      shutdownTimeoutMs: 80,
    });

    const errored = gateway.runJob(makeJob('errored-owner'), {});
    void errored.catch(() => undefined);
    await flushMicrotasks();
    first.emit('error', new Error('ipc error without exit'));

    await expect(errored).rejects.toThrow('ipc error without exit');
    expect(first.postMessage).toHaveBeenLastCalledWith({ type: 'shutdown' });

    const recovered = gateway.runJob(makeJob('after-error-retirement'), {});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(39);

    expect(first.terminate).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(first.kill).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(39);
    expect(first.kill).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();
    expect(first.kill).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(10);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(second.postMessage).toHaveBeenCalledTimes(1);
    expect(second.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'run-job',
      jobId: 'after-error-retirement',
    }));

    const restarted = gateway.getMetrics().restarted;
    first.emit('error', new Error('stale late error'));
    first.emit('exit', 1);
    expect(gateway.getMetrics().restarted).toBe(restarted);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(second.postMessage).toHaveBeenCalledTimes(1);

    second.emit('message', {
      type: 'job-succeeded',
      jobId: 'after-error-retirement',
      result: { recovered: true },
    });
    second.emit('exit', 0);
    await expect(recovered).resolves.toEqual({ recovered: true });
  });

  it('waits for bounded errored-handle retirement when a transient lane stops', async () => {
    const first = createFakeChild();
    first.terminate = vi.fn(() => new Promise<unknown>(() => undefined));
    const second = createFakeChild();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      transient: true,
      restartBackoffMs: 10,
      shutdownTimeoutMs: 80,
    });

    const errored = gateway.runJob(makeJob('errored-before-stop'), {});
    void errored.catch(() => undefined);
    await flushMicrotasks();
    first.emit('error', new Error('ipc error before stop'));
    await expect(errored).rejects.toThrow('ipc error before stop');

    const stop = gateway.stop();
    const stopped = vi.fn();
    void stop.then(stopped);
    await flushMicrotasks();
    expect(stopped).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(79);
    expect(stopped).not.toHaveBeenCalled();
    expect(first.kill).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await stop;
    expect(first.kill).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(100);
    expect(factory).toHaveBeenCalledOnce();
    expect(second.postMessage).not.toHaveBeenCalled();
    await expect(gateway.runJob(makeJob('after-error-stop'), {})).rejects.toThrow(/stopped/i);
  });

  it('keeps transient request-timeout recovery demand-driven until the next job', async () => {
    const first = createFakeChild();
    const second = createFakeChild();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      transient: true,
      requestTimeoutMs: 25,
      restartBackoffMs: 10,
      maxRestarts: 2,
    });

    const timedOut = gateway.runJob(makeJob('timed-out-job'), {});
    void timedOut.catch(() => undefined);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(26);

    await expect(timedOut).rejects.toThrow(/timed out/i);
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(gateway.getMetrics()).toMatchObject({
      degraded: true,
      inFlight: 0,
      restarted: 0,
    });

    await vi.advanceTimersByTimeAsync(100);

    expect(factory).toHaveBeenCalledTimes(1);

    const next = gateway.runJob(makeJob('after-timeout'), { rootPath: '/repo' });
    await flushMicrotasks();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(gateway.getMetrics().restarted).toBe(1);

    await vi.advanceTimersByTimeAsync(10);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(second.postMessage).toHaveBeenCalledWith({
      type: 'run-job',
      jobId: 'after-timeout',
      jobType: 'index-codebase',
      payload: { rootPath: '/repo' },
    });

    second.emit('message', {
      type: 'job-succeeded',
      jobId: 'after-timeout',
      result: { recovered: true },
    });
    second.emit('exit', 0);

    await expect(next).resolves.toEqual({ recovered: true });
  });

  it('keeps stopped transient lanes inert after crash and request timeout failures', async () => {
    const crashedChild = createFakeChild();
    const crashFactory = vi.fn(() => crashedChild);
    const crashGateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: crashFactory,
      transient: true,
      restartBackoffMs: 10,
    });
    const crashed = crashGateway.runJob(makeJob('crash-before-stop'), {});
    void crashed.catch(() => undefined);
    await flushMicrotasks();
    crashedChild.emit('exit', 1);
    await expect(crashed).rejects.toThrow(/exited with code 1/i);

    await crashGateway.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(crashFactory).toHaveBeenCalledOnce();
    await expect(crashGateway.runJob(makeJob('after-crash-stop'), {})).rejects.toThrow(/stopped/i);

    const timedOutChild = createFakeChild();
    const timeoutFactory = vi.fn(() => timedOutChild);
    const timeoutGateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: timeoutFactory,
      transient: true,
      requestTimeoutMs: 25,
      restartBackoffMs: 10,
    });
    const timedOut = timeoutGateway.runJob(makeJob('timeout-before-stop'), {});
    void timedOut.catch(() => undefined);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(26);
    await expect(timedOut).rejects.toThrow(/timed out/i);

    await timeoutGateway.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(timeoutFactory).toHaveBeenCalledOnce();
    await expect(timeoutGateway.runJob(makeJob('after-timeout-stop'), {})).rejects.toThrow(/stopped/i);
  });

  it('keeps transient start demand-free and retries startup failure only for an active job', async () => {
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
      transient: true,
      restartBackoffMs: 10,
      maxRestarts: 2,
    });

    await gateway.start();

    expect(gateway.getMetrics()).toMatchObject({ degraded: false, restarted: 0 });
    expect(factory).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(factory).not.toHaveBeenCalled();

    const result = gateway.runJob(makeJob('after-startup-failure'), {});
    await flushMicrotasks();

    expect(factory).toHaveBeenCalledOnce();
    expect(child.postMessage).not.toHaveBeenCalled();
    expect(gateway.getMetrics().degraded).toBe(true);
    expect(gateway.getMetrics().restarted).toBe(1);

    await vi.advanceTimersByTimeAsync(10);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(child.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'run-job',
      jobId: 'after-startup-failure',
    }));

    child.emit('message', {
      type: 'job-succeeded',
      jobId: 'after-startup-failure',
      result: { recovered: true },
    });
    child.emit('exit', 0);

    await expect(result).resolves.toEqual({ recovered: true });
  });

  it('cancels exact active and queued transient requests during recovery backoff', async () => {
    const first = createFakeChild();
    const second = createFakeChild();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      transient: true,
      restartBackoffMs: 10,
      maxRestarts: 1,
    });

    const seed = gateway.runJob(makeJob('seed-crash'), {});
    void seed.catch(() => undefined);
    await flushMicrotasks();
    first.emit('exit', 1);
    await expect(seed).rejects.toThrow(/exited with code 1/i);

    const active = gateway.runJob(makeJob('active-cancel'), {});
    const queued = gateway.runJob(makeJob('queued-cancel'), {});
    const survivor = gateway.runJob(makeJob('survivor'), {});
    const activeRejected = vi.fn();
    const queuedRejected = vi.fn();
    void active.catch(activeRejected);
    void queued.catch(queuedRejected);
    await flushMicrotasks();

    expect(gateway.getMetrics().restarted).toBe(1);
    await gateway.cancelJob('queued-cancel');
    await flushMicrotasks();

    expect(queuedRejected).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/cancelled/i) }),
    );
    expect(activeRejected).not.toHaveBeenCalled();

    await gateway.cancelJob('active-cancel');
    await flushMicrotasks();

    expect(activeRejected).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/cancelled/i) }),
    );
    expect(factory).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(9);
    expect(factory).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(second.postMessage).toHaveBeenCalledTimes(1);
    expect(second.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'run-job',
      jobId: 'survivor',
    }));

    second.emit('message', {
      type: 'job-succeeded',
      jobId: 'survivor',
      result: { recovered: true },
    });
    second.emit('exit', 0);

    await expect(active).rejects.toThrow(/cancelled/i);
    await expect(queued).rejects.toThrow(/cancelled/i);
    await expect(survivor).resolves.toEqual({ recovered: true });
  });

  it('cancels the exact queued successor that owns crash recovery backoff', async () => {
    const first = createFakeChild();
    const second = createFakeChild();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      transient: true,
      restartBackoffMs: 10,
      maxRestarts: 1,
    });

    const active = gateway.runJob(makeJob('active-crash'), {});
    const queued = gateway.runJob(makeJob('queued-recovery-owner'), {});
    void active.catch(() => undefined);
    void queued.catch(() => undefined);
    await flushMicrotasks();

    first.emit('exit', 1);
    await gateway.cancelJob('queued-recovery-owner');

    await expect(active).rejects.toThrow(/exited with code 1/i);
    await expect(queued).rejects.toThrow(/cancelled/i);
    await vi.advanceTimersByTimeAsync(100);

    expect(factory).toHaveBeenCalledOnce();

    const recovered = gateway.runJob(makeJob('after-queued-cancel'), {});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(second.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'run-job',
      jobId: 'after-queued-cancel',
    }));

    second.emit('message', {
      type: 'job-succeeded',
      jobId: 'after-queued-cancel',
      result: { recovered: true },
    });
    second.emit('exit', 0);
    await expect(recovered).resolves.toEqual({ recovered: true });
  });

  it('retires a timed-out transient handle before recovery can spawn its successor', async () => {
    const first = createFakeChild();
    first.terminate = vi.fn(() => new Promise<unknown>(() => undefined));
    const second = createFakeChild();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      transient: true,
      requestTimeoutMs: 25,
      restartBackoffMs: 10,
      shutdownTimeoutMs: 80,
    });

    const timedOut = gateway.runJob(makeJob('timed-out-owner'), {});
    void timedOut.catch(() => undefined);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(26);
    await expect(timedOut).rejects.toThrow(/timed out/i);

    const next = gateway.runJob(makeJob('after-owner-retirement'), {});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(78);

    expect(first.terminate).toHaveBeenCalledOnce();
    expect(first.kill).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(first.kill).toHaveBeenCalledOnce();
    expect(factory).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(9);
    expect(factory).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(1);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(second.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'run-job',
      jobId: 'after-owner-retirement',
    }));

    second.emit('message', {
      type: 'job-succeeded',
      jobId: 'after-owner-retirement',
      result: { recovered: true },
    });
    second.emit('exit', 0);
    await expect(next).resolves.toEqual({ recovered: true });
  });

  it('keeps stop intent inert while a timed-out transient handle retires', async () => {
    const first = createFakeChild();
    first.terminate = vi.fn(() => new Promise<unknown>(() => undefined));
    const second = createFakeChild();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      transient: true,
      requestTimeoutMs: 25,
      restartBackoffMs: 10,
      shutdownTimeoutMs: 80,
    });

    const timedOut = gateway.runJob(makeJob('timeout-before-retiring-stop'), {});
    void timedOut.catch(() => undefined);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(26);
    await expect(timedOut).rejects.toThrow(/timed out/i);

    const next = gateway.runJob(makeJob('blocked-by-retiring-stop'), {});
    void next.catch(() => undefined);
    await flushMicrotasks();
    const stop = gateway.stop();
    const stopped = vi.fn();
    void stop.then(stopped);
    await flushMicrotasks();

    expect(stopped).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(78);
    expect(stopped).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await stop;

    expect(first.kill).toHaveBeenCalledOnce();
    await expect(next).rejects.toThrow(/stopped/i);

    await vi.advanceTimersByTimeAsync(100);
    expect(factory).toHaveBeenCalledOnce();
  });

  it('does not schedule a cancelled successor after timeout retirement finishes', async () => {
    const first = createFakeChild();
    first.terminate = vi.fn(() => new Promise<unknown>(() => undefined));
    const second = createFakeChild();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      transient: true,
      requestTimeoutMs: 25,
      restartBackoffMs: 10,
      maxRestarts: 1,
      shutdownTimeoutMs: 80,
    });

    const timedOut = gateway.runJob(makeJob('timed-out-before-cancel'), {});
    void timedOut.catch(() => undefined);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(26);
    await expect(timedOut).rejects.toThrow(/timed out/i);

    const cancelled = gateway.runJob(makeJob('cancelled-during-retirement'), {});
    void cancelled.catch(() => undefined);
    await flushMicrotasks();
    await gateway.cancelJob('cancelled-during-retirement');
    await vi.advanceTimersByTimeAsync(79);

    expect(first.kill).toHaveBeenCalledOnce();
    await expect(cancelled).rejects.toThrow(/cancelled/i);
    await vi.advanceTimersByTimeAsync(100);

    expect(factory).toHaveBeenCalledOnce();
    expect(second.postMessage).not.toHaveBeenCalled();
    expect(gateway.getMetrics().restarted).toBe(0);

    const recovered = gateway.runJob(makeJob('third-real-demand'), {});
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(second.postMessage).toHaveBeenCalledTimes(1);
    expect(second.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'run-job',
      jobId: 'third-real-demand',
    }));

    second.emit('message', {
      type: 'job-succeeded',
      jobId: 'third-real-demand',
      result: { recovered: true },
    });
    second.emit('exit', 0);
    await expect(recovered).resolves.toEqual({ recovered: true });

    await gateway.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('keeps a queued successor when the active retirement waiter is cancelled', async () => {
    const first = createFakeChild();
    first.terminate = vi.fn(() => new Promise<unknown>(() => undefined));
    const second = createFakeChild();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      transient: true,
      requestTimeoutMs: 25,
      restartBackoffMs: 10,
      shutdownTimeoutMs: 80,
    });

    const timedOut = gateway.runJob(makeJob('multi-timeout'), {});
    void timedOut.catch(() => undefined);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(26);
    await expect(timedOut).rejects.toThrow(/timed out/i);

    const cancelled = gateway.runJob(makeJob('multi-cancelled'), {});
    const survivor = gateway.runJob(makeJob('multi-survivor'), {});
    void cancelled.catch(() => undefined);
    await flushMicrotasks();
    await gateway.cancelJob('multi-cancelled');
    await vi.advanceTimersByTimeAsync(79);

    await expect(cancelled).rejects.toThrow(/cancelled/i);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(second.postMessage).toHaveBeenCalledTimes(1);
    expect(second.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'run-job',
      jobId: 'multi-survivor',
    }));

    second.emit('message', {
      type: 'job-succeeded',
      jobId: 'multi-survivor',
      result: { survived: true },
    });
    second.emit('exit', 0);
    await expect(survivor).resolves.toEqual({ survived: true });
  });

  it('transient lanes release the exact successful handle before resolving and spawn fresh next time', async () => {
    const first = createFakeChild();
    const second = createFakeChild();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      transient: true,
      shutdownTimeoutMs: 1_000,
    });

    const firstResult = gateway.runJob(makeJob('first-job'), { rootPath: '/first' });
    const settled = vi.fn();
    void firstResult.then(settled);
    await flushMicrotasks();
    first.emit('message', {
      type: 'job-succeeded',
      jobId: 'first-job',
      result: { filesIndexed: 1 },
    });
    await flushMicrotasks();

    expect(first.postMessage).toHaveBeenLastCalledWith({ type: 'shutdown' });
    expect(settled).not.toHaveBeenCalled();

    first.emit('exit', 0);
    await expect(firstResult).resolves.toEqual({ filesIndexed: 1 });

    const secondResult = gateway.runJob(makeJob('second-job'), { rootPath: '/second' });
    await flushMicrotasks();
    expect(factory).toHaveBeenCalledTimes(2);
    expect(second.postMessage).toHaveBeenCalledWith({
      type: 'run-job',
      jobId: 'second-job',
      jobType: 'index-codebase',
      payload: { rootPath: '/second' },
    });

    second.emit('message', {
      type: 'job-succeeded',
      jobId: 'second-job',
      result: { filesIndexed: 2 },
    });
    second.emit('exit', 0);
    await expect(secondResult).resolves.toEqual({ filesIndexed: 2 });
  });

  it('serializes concurrent direct transient jobs into distinct process generations', async () => {
    const first = createFakeChild();
    const second = createFakeChild();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      transient: true,
      shutdownTimeoutMs: 1_000,
    });

    const firstResult = gateway.runJob(makeJob('first-job'), { rootPath: '/first' });
    const secondResult = gateway.runJob(makeJob('second-job'), { rootPath: '/second' });
    void secondResult.catch(() => undefined);
    await flushMicrotasks();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(first.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'run-job',
      jobId: 'first-job',
    }));
    expect(first.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({
      type: 'run-job',
      jobId: 'second-job',
    }));

    first.emit('message', {
      type: 'job-succeeded',
      jobId: 'first-job',
      result: { generation: 1 },
    });
    first.emit('exit', 0);
    await expect(firstResult).resolves.toEqual({ generation: 1 });
    await flushMicrotasks();

    expect(factory).toHaveBeenCalledTimes(2);
    expect(second.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'run-job',
      jobId: 'second-job',
    }));

    second.emit('message', {
      type: 'job-succeeded',
      jobId: 'second-job',
      result: { generation: 2 },
    });
    second.emit('exit', 0);
    await expect(secondResult).resolves.toEqual({ generation: 2 });
  });

  it('does not let an awaiting start or transient job clear a concurrent stop intent', async () => {
    const first = createFakeChild();
    const second = createFakeChild();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      transient: true,
      shutdownTimeoutMs: 1_000,
    });

    const firstResult = gateway.runJob(makeJob('first-job'), {});
    const queuedResult = gateway.runJob(makeJob('queued-job'), {});
    void queuedResult.catch(() => undefined);
    await flushMicrotasks();
    first.emit('message', {
      type: 'job-succeeded',
      jobId: 'first-job',
      result: { ok: true },
    });
    await flushMicrotasks();

    const startWaiter = gateway.start();
    const stopWaiter = gateway.stop();
    first.emit('exit', 0);

    await expect(firstResult).resolves.toEqual({ ok: true });
    await expect(queuedResult).rejects.toThrow(/stopped/i);
    await Promise.all([startWaiter, stopWaiter]);
    await flushMicrotasks();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(second.postMessage).not.toHaveBeenCalled();
    await expect(gateway.runJob(makeJob('after-stop'), {})).rejects.toThrow(/stopped/i);
  });

  it('transient lanes force termination before rejecting failed jobs when shutdown does not exit', async () => {
    const child = createFakeChild();
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: () => child,
      transient: true,
      shutdownTimeoutMs: 25,
    });

    const failed = gateway.runJob(makeJob('failed-job'), {});
    const rejected = vi.fn();
    void failed.catch(rejected);
    await flushMicrotasks();
    child.emit('message', {
      type: 'job-failed',
      jobId: 'failed-job',
      errorMessage: 'controlled failure',
    });
    await flushMicrotasks();

    expect(child.postMessage).toHaveBeenLastCalledWith({ type: 'shutdown' });
    expect(rejected).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(25);

    expect(child.terminate).toHaveBeenCalledOnce();
    await expect(failed).rejects.toThrow('controlled failure');
  });

  it('transient lanes fall back to kill when bounded termination rejects', async () => {
    const child = createFakeChild();
    child.terminate = vi.fn().mockRejectedValue(new Error('terminate failed'));
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: () => child,
      transient: true,
      shutdownTimeoutMs: 25,
    });

    const failed = gateway.runJob(makeJob('failed-termination'), {});
    void failed.catch(() => undefined);
    await flushMicrotasks();
    child.emit('message', {
      type: 'job-failed',
      jobId: 'failed-termination',
      errorMessage: 'controlled failure',
    });
    await vi.advanceTimersByTimeAsync(25);

    expect(child.terminate).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
    await expect(failed).rejects.toThrow('controlled failure');
  });

  it('transient lanes bound a terminate call that never settles and fall back to kill', async () => {
    const child = createFakeChild();
    child.terminate = vi.fn(() => new Promise<unknown>(() => undefined));
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: () => child,
      transient: true,
      shutdownTimeoutMs: 40,
    });

    const result = gateway.runJob(makeJob('never-terminates'), {});
    await flushMicrotasks();
    child.emit('message', {
      type: 'job-succeeded',
      jobId: 'never-terminates',
      result: { ok: true },
    });
    await vi.advanceTimersByTimeAsync(40);

    expect(child.terminate).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
    await expect(result).resolves.toEqual({ ok: true });
  });

  it('transient lanes release cancelled jobs and ignore late messages from the retired handle', async () => {
    const first = createFakeChild();
    const second = createFakeChild();
    const factory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: factory,
      transient: true,
    });

    const cancelled = gateway.runJob(makeJob('cancelled-job'), {});
    void cancelled.catch(() => undefined);
    await flushMicrotasks();
    await gateway.cancelJob('cancelled-job');
    expect(first.postMessage).toHaveBeenCalledWith({
      type: 'cancel-job',
      jobId: 'cancelled-job',
    });

    first.emit('message', { type: 'job-cancelled', jobId: 'cancelled-job' });
    first.emit('exit', 0);
    await expect(cancelled).rejects.toThrow(/cancelled/i);

    const next = gateway.runJob(makeJob('next-job'), {});
    const settled = vi.fn();
    void next.then(settled);
    first.emit('message', {
      type: 'job-succeeded',
      jobId: 'next-job',
      result: { stale: true },
    });
    await flushMicrotasks();
    expect(settled).not.toHaveBeenCalled();

    second.emit('message', {
      type: 'job-succeeded',
      jobId: 'next-job',
      result: { fresh: true },
    });
    second.emit('exit', 0);
    await expect(next).resolves.toEqual({ fresh: true });
  });

  it('transient lanes handle an exit that races synchronously with the shutdown send', async () => {
    const child = createFakeChild();
    child.postMessage.mockImplementation((message: { type?: string }) => {
      if (message.type === 'shutdown') {
        child.emit('exit', 0);
      }
    });
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: () => child,
      transient: true,
      shutdownTimeoutMs: 25,
    });

    const result = gateway.runJob(makeJob('racing-exit'), {});
    await flushMicrotasks();
    child.emit('message', {
      type: 'job-succeeded',
      jobId: 'racing-exit',
      result: { ok: true },
    });

    await expect(result).resolves.toEqual({ ok: true });
    expect(child.terminate).not.toHaveBeenCalled();
  });

  it('rejects an active request when stop observes a synchronous shutdown exit', async () => {
    const child = createFakeChild();
    child.postMessage.mockImplementation((message: { type?: string }) => {
      if (message.type === 'shutdown') {
        child.emit('exit', 0);
      }
    });
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory: () => child,
      shutdownTimeoutMs: 25,
    });

    const result = gateway.runJob(makeJob('active-on-stop'), {});
    void result.catch(() => undefined);
    await flushMicrotasks();
    await gateway.stop();

    await expect(result).rejects.toThrow(/stopped before completing pending jobs/i);
  });

});
