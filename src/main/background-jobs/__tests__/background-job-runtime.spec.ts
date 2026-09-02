import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BackgroundJobRuntime } from '../background-job-runtime';
import { ProcessLaneGateway } from '../process-lane-gateway';
import type {
  BackgroundJobRecord,
  LaneGateway,
  LaneGatewayMetrics,
} from '../lane-gateway';

type FakeProcess = EventEmitter & {
  postMessage: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
};

function createFakeProcess(): FakeProcess {
  const process = new EventEmitter() as FakeProcess;
  process.postMessage = vi.fn();
  process.kill = vi.fn();
  process.terminate = vi.fn().mockResolvedValue(undefined);
  return process;
}

class FakeLaneGateway extends EventEmitter implements LaneGateway {
  readonly lane = 'indexing' as const;
  readonly started: BackgroundJobRecord[] = [];
  readonly cancelled: string[] = [];
  starts = 0;
  stops = 0;
  private completions: Array<{
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> = [];

  async start(): Promise<void> {
    this.starts++;
  }

  async stop(): Promise<void> {
    this.stops++;
  }

  async runJob(job: BackgroundJobRecord): Promise<unknown> {
    this.started.push(job);
    return new Promise<unknown>((resolve, reject) => {
      this.completions.push({ resolve, reject });
    });
  }

  async cancelJob(jobId: string): Promise<void> {
    this.cancelled.push(jobId);
  }

  getMetrics(): LaneGatewayMetrics {
    return {
      degraded: false,
      inFlight: this.started.length,
      processed: 0,
      failed: 0,
      restarted: 0,
      lastHeartbeatAt: null,
      lastError: null,
    };
  }

  completeNext(result: unknown = { ok: true }): void {
    const next = this.completions.shift();
    if (!next) throw new Error('No running fake lane job');
    next.resolve(result);
  }

  completeLatest(result: unknown = { ok: true }): void {
    const next = this.completions.pop();
    if (!next) throw new Error('No running fake lane job');
    next.resolve(result);
  }

  failNext(error = new Error('lane failed')): void {
    const next = this.completions.shift();
    if (!next) throw new Error('No running fake lane job');
    next.reject(error);
  }
}

async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('BackgroundJobRuntime', () => {
  let fakeLane: FakeLaneGateway;
  let runtime: BackgroundJobRuntime;

  beforeEach(() => {
    vi.useFakeTimers();
    fakeLane = new FakeLaneGateway();
    runtime = new BackgroundJobRuntime({
      lanes: { indexing: fakeLane },
      maxPendingPerLane: { indexing: 2 },
      laneHeartbeatTimeoutMs: { indexing: 1_000 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces pending jobs by lane, type, and coalesceKey', () => {
    const first = runtime.enqueue({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'background',
      coalesceKey: '/repo',
      payload: { rootPath: '/repo' },
    });

    const second = runtime.enqueue({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'background',
      coalesceKey: '/repo',
      payload: { rootPath: '/repo' },
    });

    expect(second.jobId).toBe(first.jobId);
    expect(runtime.getJob(first.jobId)?.status).toBe('queued');
    expect(runtime.snapshot().queued).toHaveLength(1);
  });

  it('dispatches higher priority jobs before background jobs', async () => {
    const background = runtime.enqueue({
      lane: 'indexing',
      type: 'background-work',
      priority: 'background',
      payload: { n: 1 },
    });
    const urgent = runtime.enqueue({
      lane: 'indexing',
      type: 'urgent-work',
      priority: 'user-blocking',
      payload: { n: 2 },
    });

    await flushMicrotasks();

    expect(fakeLane.started.map((job) => job.id)).toEqual([urgent.jobId]);
    fakeLane.completeNext();
    await flushMicrotasks();
    expect(fakeLane.started.map((job) => job.id)).toEqual([urgent.jobId, background.jobId]);
  });

  it('rejects when a lane exceeds its max pending count', () => {
    runtime.enqueue({ lane: 'indexing', type: 'one', priority: 'normal', payload: {} });
    runtime.enqueue({ lane: 'indexing', type: 'two', priority: 'normal', payload: {} });

    expect(() => {
      runtime.enqueue({ lane: 'indexing', type: 'three', priority: 'normal', payload: {} });
    }).toThrow(/pending limit/i);
  });

  it('captures status snapshots and lane progress', async () => {
    const queued = runtime.enqueue({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'normal',
      payload: {},
    });

    await flushMicrotasks();
    fakeLane.emit('progress', {
      jobId: queued.jobId,
      progress: { phase: 'chunking', completed: 3, total: 10 },
    });

    expect(runtime.getJob(queued.jobId)).toEqual(expect.objectContaining({
      status: 'running',
      progress: { phase: 'chunking', completed: 3, total: 10 },
    }));
    expect(runtime.snapshot().running).toHaveLength(1);
  });

  it('cancels queued and running jobs cooperatively', async () => {
    const running = runtime.enqueue({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'normal',
      payload: {},
    });
    const queued = runtime.enqueue({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'normal',
      payload: {},
    });

    await expect(runtime.cancel(queued.jobId)).resolves.toBe(true);
    expect(runtime.getJob(queued.jobId)?.status).toBe('cancelled');

    await flushMicrotasks();
    await expect(runtime.cancel(running.jobId)).resolves.toBe(true);
    expect(fakeLane.cancelled).toEqual([running.jobId]);
    expect(runtime.getJob(running.jobId)?.status).toBe('running');

    fakeLane.completeNext();
    await flushMicrotasks();

    expect(runtime.getJob(running.jobId)?.status).toBe('cancelled');
  });

  it('does not dispatch another lane job until a cancelled running job settles', async () => {
    const running = runtime.enqueue({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'normal',
      payload: {},
    });
    const queued = runtime.enqueue({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'normal',
      payload: {},
    });

    await flushMicrotasks();
    expect(fakeLane.started.map((job) => job.id)).toEqual([running.jobId]);

    await expect(runtime.cancel(running.jobId)).resolves.toBe(true);
    await flushMicrotasks();

    expect(fakeLane.cancelled).toEqual([running.jobId]);
    expect(runtime.getJob(running.jobId)?.status).toBe('running');
    expect(fakeLane.started.map((job) => job.id)).toEqual([running.jobId]);

    fakeLane.completeNext();
    await flushMicrotasks();

    expect(runtime.getJob(running.jobId)?.status).toBe('cancelled');
    expect(fakeLane.started.map((job) => job.id)).toEqual([running.jobId, queued.jobId]);
  });

  it('does not submit work cancelled while the lane start boundary is pending', async () => {
    let releaseStart: (() => void) | undefined;
    const startBarrier = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    vi.spyOn(fakeLane, 'start').mockReturnValue(startBarrier);

    const cancelled = runtime.enqueue({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'normal',
      payload: {},
    });
    await flushMicrotasks();

    await expect(runtime.cancel(cancelled.jobId)).resolves.toBe(true);
    expect(fakeLane.cancelled).toEqual([cancelled.jobId]);
    releaseStart?.();
    await flushMicrotasks();

    expect(fakeLane.started).toHaveLength(0);
    expect(runtime.getJob(cancelled.jobId)?.status).toBe('cancelled');
  });

  it('cancels a healthy real transient job before it can create an owner or post work', async () => {
    const child = createFakeProcess();
    const processFactory = vi.fn(() => child);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory,
      transient: true,
    });
    const transientRuntime = new BackgroundJobRuntime({
      lanes: { indexing: gateway },
      laneHeartbeatTimeoutMs: { indexing: 1_000 },
    });
    let cancellation: Promise<boolean> | undefined;
    transientRuntime.on('status', (record: BackgroundJobRecord) => {
      if (record.status === 'running' && !cancellation) {
        cancellation = transientRuntime.cancel(record.id);
      }
    });

    const cancelled = transientRuntime.enqueue({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'normal',
      payload: { cancelled: true },
    });
    await flushMicrotasks(20);
    await cancellation;
    await flushMicrotasks(20);

    expect(transientRuntime.getJob(cancelled.jobId)?.status).toBe('cancelled');
    expect(processFactory).not.toHaveBeenCalled();
    expect(child.postMessage).not.toHaveBeenCalled();
    expect(gateway.getMetrics()).toMatchObject({ inFlight: 0, restarted: 0 });

    const recovered = transientRuntime.enqueue({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'normal',
      payload: { rootPath: '/repo' },
    });
    await flushMicrotasks();

    expect(processFactory).toHaveBeenCalledOnce();
    expect(child.postMessage).toHaveBeenCalledTimes(1);
    expect(child.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'run-job',
      jobId: recovered.jobId,
    }));

    child.emit('message', {
      type: 'job-succeeded',
      jobId: recovered.jobId,
      result: { recovered: true },
    });
    child.emit('exit', 0);
    await flushMicrotasks();

    expect(transientRuntime.getJob(recovered.jobId)?.status).toBe('succeeded');
    await transientRuntime.stop();
    expect(processFactory).toHaveBeenCalledOnce();
  });

  it('cancels a real transient lane job during recovery backoff without spawning it', async () => {
    const first = createFakeProcess();
    const second = createFakeProcess();
    const processFactory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory,
      transient: true,
      restartBackoffMs: 10,
      maxRestarts: 1,
    });
    const transientRuntime = new BackgroundJobRuntime({
      lanes: { indexing: gateway },
      laneHeartbeatTimeoutMs: { indexing: 1_000 },
    });

    const seed = transientRuntime.enqueueAndWait({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'normal',
      payload: {},
    });
    void seed.catch(() => undefined);
    await flushMicrotasks();
    first.emit('exit', 1);
    await expect(seed).rejects.toThrow(/exited with code 1/i);

    const cancelled = transientRuntime.enqueue({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'normal',
      payload: {},
    });
    await flushMicrotasks();

    expect(transientRuntime.getJob(cancelled.jobId)?.status).toBe('running');
    await expect(transientRuntime.cancel(cancelled.jobId)).resolves.toBe(true);
    await flushMicrotasks();

    expect(transientRuntime.getJob(cancelled.jobId)?.status).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(100);
    expect(processFactory).toHaveBeenCalledOnce();

    const recovered = transientRuntime.enqueue({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'normal',
      payload: { rootPath: '/repo' },
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);

    expect(processFactory).toHaveBeenCalledTimes(2);
    expect(second.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'run-job',
      jobId: recovered.jobId,
    }));

    second.emit('message', {
      type: 'job-succeeded',
      jobId: recovered.jobId,
      result: { recovered: true },
    });
    second.emit('exit', 0);
    await flushMicrotasks();

    expect(transientRuntime.getJob(recovered.jobId)?.status).toBe('succeeded');
  });

  it('cancels a real transient successor while timeout retirement is pending', async () => {
    const first = createFakeProcess();
    first.terminate = vi.fn(() => new Promise<unknown>(() => undefined));
    const second = createFakeProcess();
    const processFactory = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const gateway = new ProcessLaneGateway({
      lane: 'indexing',
      entrypoint: '/tmp/index-lane.js',
      processFactory,
      transient: true,
      requestTimeoutMs: 25,
      restartBackoffMs: 10,
      maxRestarts: 1,
      shutdownTimeoutMs: 80,
    });
    const transientRuntime = new BackgroundJobRuntime({
      lanes: { indexing: gateway },
      laneHeartbeatTimeoutMs: { indexing: 1_000 },
    });

    const timedOut = transientRuntime.enqueueAndWait({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'normal',
      payload: {},
    });
    void timedOut.catch(() => undefined);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(26);
    await expect(timedOut).rejects.toThrow(/timed out/i);

    const cancelled = transientRuntime.enqueue({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'normal',
      payload: {},
    });
    await flushMicrotasks();
    await expect(transientRuntime.cancel(cancelled.jobId)).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(80);
    await flushMicrotasks(20);

    expect(first.kill).toHaveBeenCalledOnce();
    expect(transientRuntime.getJob(cancelled.jobId)?.status).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(100);
    expect(processFactory).toHaveBeenCalledOnce();
    expect(second.postMessage).not.toHaveBeenCalled();
    expect(gateway.getMetrics().restarted).toBe(0);

    const recovered = transientRuntime.enqueue({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'normal',
      payload: { rootPath: '/repo' },
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);

    expect(processFactory).toHaveBeenCalledTimes(2);
    expect(second.postMessage).toHaveBeenCalledTimes(1);
    expect(second.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'run-job',
      jobId: recovered.jobId,
    }));

    second.emit('message', {
      type: 'job-succeeded',
      jobId: recovered.jobId,
      result: { recovered: true },
    });
    second.emit('exit', 0);
    await flushMicrotasks();

    expect(transientRuntime.getJob(recovered.jobId)?.status).toBe('succeeded');
    await transientRuntime.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(processFactory).toHaveBeenCalledTimes(2);
  });

  it('settles queued and running waiters when stopped', async () => {
    const runningPromise = runtime.enqueueAndWait({
      lane: 'indexing',
      type: 'running-work',
      priority: 'normal',
      payload: {},
    });
    const queuedPromise = runtime.enqueueAndWait({
      lane: 'indexing',
      type: 'queued-work',
      priority: 'normal',
      payload: {},
    });
    const runningRejected = vi.fn();
    const queuedRejected = vi.fn();
    void runningPromise.catch(runningRejected);
    void queuedPromise.catch(queuedRejected);

    await flushMicrotasks();
    expect(fakeLane.started).toHaveLength(1);

    await runtime.stop();
    await flushMicrotasks();

    expect(runtime.getJob(fakeLane.started[0].id)?.status).toBe('cancelled');
    expect(runtime.snapshot().queued).toHaveLength(0);
    expect(runningRejected).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/stopped/i) }),
    );
    expect(queuedRejected).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/stopped/i) }),
    );
  });

  it('does not dispatch queued work after stop races a scheduled drain', async () => {
    const promise = runtime.enqueueAndWait({
      lane: 'indexing',
      type: 'queued-work',
      priority: 'normal',
      payload: {},
    });
    const rejected = vi.fn();
    void promise.catch(rejected);

    await runtime.stop();
    await flushMicrotasks();

    expect(fakeLane.started).toHaveLength(0);
    expect(runtime.snapshot().queued).toHaveLength(0);
    expect(rejected).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/stopped/i) }),
    );
    expect(() => {
      runtime.enqueue({
        lane: 'indexing',
        type: 'after-stop',
        priority: 'normal',
        payload: {},
      });
    }).toThrow(/stopped/i);
  });

  it('honours a configured max in-flight count per lane', async () => {
    runtime = new BackgroundJobRuntime({
      lanes: { indexing: fakeLane },
      maxPendingPerLane: { indexing: 5 },
      maxInFlightPerLane: { indexing: 2 },
      laneHeartbeatTimeoutMs: { indexing: 1_000 },
    });
    const first = runtime.enqueue({
      lane: 'indexing',
      type: 'first',
      priority: 'normal',
      payload: {},
    });
    const second = runtime.enqueue({
      lane: 'indexing',
      type: 'second',
      priority: 'normal',
      payload: {},
    });
    const third = runtime.enqueue({
      lane: 'indexing',
      type: 'third',
      priority: 'normal',
      payload: {},
    });

    await flushMicrotasks();

    expect(fakeLane.started.map((job) => job.id)).toEqual([first.jobId, second.jobId]);

    fakeLane.completeNext();
    await flushMicrotasks();

    expect(fakeLane.started.map((job) => job.id)).toEqual([
      first.jobId,
      second.jobId,
      third.jobId,
    ]);
  });

  it('marks running jobs stale when lane heartbeat times out', async () => {
    const job = runtime.enqueue({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'normal',
      payload: {},
    });
    await flushMicrotasks();

    fakeLane.emit('heartbeat', { lane: 'indexing', timestamp: Date.now() });
    vi.advanceTimersByTime(1_001);

    expect(runtime.getJob(job.jobId)?.status).toBe('stale');
  });

  it('requeues idempotent running jobs after a stale lane restart and keeps waiters attached', async () => {
    const promise = runtime.enqueueAndWait({
      lane: 'indexing',
      type: 'index-codebase',
      priority: 'normal',
      payload: {},
      idempotent: true,
      maxAttempts: 2,
    });
    await flushMicrotasks();

    const jobId = fakeLane.started[0]?.id;
    expect(jobId).toBeDefined();

    vi.advanceTimersByTime(1_001);
    await flushMicrotasks();

    expect(fakeLane.stops).toBe(1);
    expect(fakeLane.started.map((job) => job.id)).toEqual([jobId, jobId]);
    expect(runtime.getJob(jobId)?.status).toBe('running');

    fakeLane.completeLatest({ retried: true });
    await expect(promise).resolves.toEqual({ retried: true });
    expect(runtime.getJob(jobId)?.status).toBe('succeeded');
  });

  it('stops an unhealthy lane after a heartbeat timeout before dispatching more work', async () => {
    const stale = runtime.enqueue({
      lane: 'indexing',
      type: 'stale-work',
      priority: 'normal',
      payload: {},
    });
    const queued = runtime.enqueue({
      lane: 'indexing',
      type: 'queued-work',
      priority: 'normal',
      payload: {},
    });
    await flushMicrotasks();

    vi.advanceTimersByTime(1_001);
    await flushMicrotasks();

    expect(runtime.getJob(stale.jobId)?.status).toBe('stale');
    expect(fakeLane.stops).toBe(1);
    expect(fakeLane.started.map((job) => job.id)).toEqual([stale.jobId, queued.jobId]);
  });
});
