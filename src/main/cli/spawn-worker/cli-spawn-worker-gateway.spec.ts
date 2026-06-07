import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  CliSpawnWorkerGateway,
  type CliSpawnWorkerLike,
} from './cli-spawn-worker-gateway';
import type { SpawnWorkerInboundMsg, SpawnWorkerOutboundMsg } from './cli-spawn-worker-protocol';

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
