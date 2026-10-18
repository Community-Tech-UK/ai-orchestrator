import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CliSpawnWorkerGateway,
  type CliSpawnWorkerLike,
} from './cli-spawn-worker-gateway';
import { killProcessGroup } from '../adapters/base-cli-process-utils';
import type { SpawnWorkerInboundMsg, SpawnWorkerOutboundMsg } from './cli-spawn-worker-protocol';

vi.mock('../adapters/base-cli-process-utils', () => ({ killProcessGroup: vi.fn(() => true) }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

class FakeWorker extends EventEmitter implements CliSpawnWorkerLike {
  readonly posted: SpawnWorkerInboundMsg[] = [];
  terminated = false;

  postMessage(msg: SpawnWorkerInboundMsg): void {
    this.posted.push(msg);
  }

  terminate(): Promise<number> {
    this.terminated = true;
    this.emit('exit', 0);
    return Promise.resolve(0);
  }

  send(msg: SpawnWorkerOutboundMsg): void {
    this.emit('message', msg);
  }
}

describe('CliSpawnWorkerGateway', () => {
  it('spawns through worker RPC and routes lifecycle events by instance id', async () => {
    const worker = new FakeWorker();
    const events = {
      stdout: vi.fn(),
      stderr: vi.fn(),
      spawned: vi.fn(),
      exited: vi.fn(),
    };
    const gateway = new CliSpawnWorkerGateway({
      workerFactory: () => worker,
      rpcTimeoutMs: 500,
    });

    gateway.registerInstance('inst-1', events);
    const spawnPromise = gateway.spawnInstance({
      instanceId: 'inst-1',
      command: 'node',
      args: ['fixture.js'],
      cwd: '/tmp/project',
      env: { A: 'B' },
      streamIdleTimeoutMs: 1000,
    });

    expect(worker.posted[0]).toMatchObject({
      type: 'spawn',
      id: 1,
      instanceId: 'inst-1',
      command: 'node',
      args: ['fixture.js'],
      cwd: '/tmp/project',
      env: { A: 'B' },
      streamIdleTimeoutMs: 1000,
    });

    worker.send({ type: 'spawned', instanceId: 'inst-1', pid: 4242 });
    worker.send({ type: 'stdout-chunk', instanceId: 'inst-1', chunk: 'hello' });
    worker.send({ type: 'stderr-chunk', instanceId: 'inst-1', chunk: 'warn' });
    worker.send({ type: 'rpc-response', id: 1, result: { pid: 4242 } });

    await expect(spawnPromise).resolves.toEqual({ pid: 4242 });
    expect(events.spawned).toHaveBeenCalledWith(4242);
    expect(events.stdout).toHaveBeenCalledWith('hello');
    expect(events.stderr).toHaveBeenCalledWith('warn');

    worker.send({ type: 'exited', instanceId: 'inst-1', code: 0, signal: null });
    worker.send({ type: 'stream-idle', instanceId: 'inst-1', timeoutMs: 1000 });

    expect(events.exited).toHaveBeenCalledWith(0, null);
  });

  it('serializes stdin writes per instance to preserve ordering', async () => {
    const worker = new FakeWorker();
    const gateway = new CliSpawnWorkerGateway({
      workerFactory: () => worker,
      rpcTimeoutMs: 500,
    });

    const first = gateway.writeStdin('inst-1', 'first\n');
    const second = gateway.writeStdin('inst-1', 'second\n');

    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]).toMatchObject({
      type: 'stdin-write',
      id: 1,
      instanceId: 'inst-1',
      data: 'first\n',
    });

    worker.send({ type: 'rpc-response', id: 1 });
    await first;

    expect(worker.posted).toHaveLength(2);
    expect(worker.posted[1]).toMatchObject({
      type: 'stdin-write',
      id: 2,
      instanceId: 'inst-1',
      data: 'second\n',
    });

    worker.send({ type: 'rpc-response', id: 2 });
    await second;
  });

  it('sends shutdown before terminating the worker', async () => {
    const worker = new FakeWorker();
    const gateway = new CliSpawnWorkerGateway({
      workerFactory: () => worker,
      rpcTimeoutMs: 500,
    });

    const closed = gateway.close();
    expect(worker.posted[0]).toMatchObject({ type: 'shutdown', id: 1 });
    worker.send({ type: 'rpc-response', id: 1 });

    await closed;
    expect(worker.terminated).toBe(true);
  });

  it('rejects spawn RPCs that report worker spawn errors', async () => {
    const worker = new FakeWorker();
    const gateway = new CliSpawnWorkerGateway({
      workerFactory: () => worker,
      rpcTimeoutMs: 500,
    });

    const spawnPromise = gateway.spawnInstance({
      instanceId: 'inst-missing',
      command: 'missing-cli',
      args: [],
      cwd: '/tmp/project',
      env: {},
    });

    worker.send({ type: 'rpc-response', id: 1, error: 'spawn missing-cli ENOENT' });

    await expect(spawnPromise).rejects.toThrow('spawn missing-cli ENOENT');
  });
});


describe('worker ownership after thread failure', () => {
  it('drains queued usage before notifying owners and isolates throwing callbacks', async () => {
    const worker = new FakeWorker();
    let finish!: (code: number) => void;
    vi.spyOn(worker, 'terminate').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const gateway = new CliSpawnWorkerGateway({ workerFactory: () => worker });
    const order: string[] = [];
    gateway.registerInstance('one', { stdout: () => order.push('paid-output'),
      failed: () => { order.push('failure'); throw new Error('Fixture callback failure'); }, exited: () => order.push('exit-one') });
    const other = { failed: vi.fn(), exited: vi.fn() };
    gateway.registerInstance('two', other);
    worker.send({ type: 'spawned', instanceId: 'one', pid: 101 });
    worker.send({ type: 'spawned', instanceId: 'two', pid: 102 });
    worker.emit('error', new Error('Fixture worker loss'));
    await expect(gateway.writeStdin('one', 'late')).rejects.toThrow('unavailable');
    expect(order).toEqual([]);
    worker.send({ type: 'stdout-chunk', instanceId: 'one', chunk: 'paid fixture' });
    worker.emit('exit', 1); finish(1);
    await Promise.resolve();
    expect(order).toEqual(['paid-output', 'failure', 'exit-one']);
    expect(other.failed).toHaveBeenCalledOnce(); expect(other.exited).toHaveBeenCalledOnce();
    expect(killProcessGroup).toHaveBeenCalledTimes(2);
    await gateway.close();
  });

  it('ignores stale worker events after one restart and never restarts after close', async () => {
    vi.useFakeTimers();
    const first = new FakeWorker(); const next = new FakeWorker();
    const factory = vi.fn().mockReturnValueOnce(first).mockReturnValue(next);
    const gateway = new CliSpawnWorkerGateway({ workerFactory: factory });
    const owner = { failed: vi.fn(), exited: vi.fn(), stdout: vi.fn() };
    gateway.registerInstance('one', owner);
    first.send({ type: 'spawned', instanceId: 'one', pid: 101 });
    first.emit('error', new Error('Fixture worker loss')); first.emit('exit', 1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(owner.exited).toHaveBeenCalledOnce();
    first.send({ type: 'stdout-chunk', instanceId: 'one', chunk: 'stale' }); first.emit('exit', 1);
    expect(owner.stdout).not.toHaveBeenCalled();
    const closing = gateway.close();
    const shutdown = next.posted.find(message => message.type === 'shutdown')!;
    next.send({ type: 'rpc-response', id: shutdown.id }); await closing;
    await vi.advanceTimersByTimeAsync(10000);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('does not kill or notify a child that already reported exit', async () => {
    const worker = new FakeWorker();
    const gateway = new CliSpawnWorkerGateway({ workerFactory: () => worker });
    const owner = { failed: vi.fn(), exited: vi.fn() }; gateway.registerInstance('one', owner);
    worker.send({ type: 'spawned', instanceId: 'one', pid: 101 });
    worker.send({ type: 'exited', instanceId: 'one', code: 0, signal: null });
    worker.emit('exit', 0);
    expect(owner.failed).not.toHaveBeenCalled(); expect(owner.exited).toHaveBeenCalledOnce();
    expect(killProcessGroup).not.toHaveBeenCalled(); await gateway.close();
  });
});
