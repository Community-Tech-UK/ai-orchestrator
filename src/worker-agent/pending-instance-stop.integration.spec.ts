import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerNodeConnectionServer } from '../main/remote-node/worker-node-connection';

const fixture = vi.hoisted(() => ({ adapter: undefined as unknown, registry: undefined as unknown }));
vi.mock('../main/cli/adapters/adapter-factory', () => ({ createCliAdapter: () => fixture.adapter }));
vi.mock('../main/remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => fixture.registry }));
vi.mock('../main/logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));

import { RemoteCliAdapter } from '../main/cli/adapters/remote-cli-adapter';
import { LocalInstanceManager } from './local-instance-manager';
import { WorkerRpcDispatcher } from './worker-rpc-dispatcher';

class PendingAdapter extends EventEmitter {
  running = false;
  resolveStartup!: (pid: number) => void;
  readonly startup = new Promise<number>(resolve => { this.resolveStartup = resolve; });
  spawn = vi.fn(() => { this.running = true; return this.startup; });
  terminate = vi.fn<() => Promise<void>>(async () => { throw new Error('Synthetic pending stop refusal'); });
  sendInput = vi.fn(async () => undefined);
  interrupt = vi.fn(async () => undefined);
}

describe('pending worker cancellation over the controller RPC path', () => {
  let manager: LocalInstanceManager;
  let adapter: PendingAdapter;
  let remote: RemoteCliAdapter;
  let rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  let spawning: Promise<unknown> | undefined;

  beforeEach(() => {
    adapter = new PendingAdapter(); fixture.adapter = adapter;
    fixture.registry = new EventEmitter();
    manager = new LocalInstanceManager(['/tmp'], 1);
    let nextId = 0;
    const replies = new Map<string | number, { result?: unknown; error?: Error }>();
    const unused = (): never => { throw new Error('Unexpected external dependency'); };
    const dispatcher = new WorkerRpcDispatcher({ config: {} as never, instanceManager: manager,
      getFilesystemHandler: unused, getSyncHandler: unused, getTerminalHandler: unused,
      applyConfigUpdate: unused, getCdpTunnel: unused, stopManagedBrowser: unused, localAiHealth: {} as never,
      sendResult: (id, result) => { replies.set(id, { result }); },
      sendError: (id, code, message) => { replies.set(id, { error: Object.assign(new Error(message), { code }) }); },
    });
    rpc = async (method, params) => {
      const id = ++nextId;
      await dispatcher.handleRpcRequest({ jsonrpc: '2.0', id, method, scope: 'instance', params: JSON.parse(JSON.stringify(params)) });
      const reply = replies.get(id); replies.delete(id);
      if (!reply) throw new Error('Missing worker RPC reply');
      if (reply.error) throw reply.error;
      return reply.result;
    };
    remote = new RemoteCliAdapter({ sendRpc: (_node: string, method: string, params: Record<string, unknown>) => rpc(method, params) } as unknown as WorkerNodeConnectionServer,
      'synthetic-worker', 'claude', { sessionId: 'pending-session', workingDirectory: '/tmp' });
    spawning = undefined;
  });

  afterEach(async () => {
    adapter.terminate.mockImplementation(async () => { adapter.running = false; });
    adapter.resolveStartup(1);
    await spawning;
    await manager.terminateAll();
    remote.forceCleanup();
  });

  async function start(): Promise<void> {
    // Handle rejection immediately so cancellation cannot create an unhandled rejection.
    spawning = remote.spawn().catch((error: unknown) => error);
    await vi.waitFor(() => expect(adapter.spawn).toHaveBeenCalledOnce());
  }

  it('rejects a refused pending stop at the controller instead of acknowledging success', async () => {
    await start();
    // Let startup finish even on the buggy implementation that waits for it.
    const stopped = remote.terminate();
    adapter.resolveStartup(1);
    await expect(stopped).rejects.toThrow('Synthetic pending stop refusal');
    expect(adapter.running).toBe(true);
  });

  it('retains the same adapter and its capacity after both cancellation stop attempts fail', async () => {
    await start();
    const stopped = rpc('instance.terminate', { instanceId: 'pending-session' }).catch((error: unknown) => error);
    adapter.resolveStartup(1);
    await stopped; await spawning;
    expect(adapter.terminate).toHaveBeenCalledTimes(2);
    expect(manager.getInstance('pending-session')?.adapter).toBe(adapter);
    await expect(rpc('instance.spawn', { instanceId: 'pending-session', cliType: 'claude', workingDirectory: '/tmp' })).rejects.toThrow('Instance already exists');
    await expect(rpc('instance.spawn', { instanceId: 'another-session', cliType: 'claude', workingDirectory: '/tmp' })).rejects.toThrow('at capacity');

    adapter.terminate.mockImplementation(async () => { adapter.running = false; });
    await expect(rpc('instance.terminate', { instanceId: 'pending-session' })).resolves.toEqual({ ok: true });
    expect(adapter.terminate).toHaveBeenCalledTimes(3);
    expect(adapter.running).toBe(false);
    expect(manager.getAllInstanceIds()).toEqual([]);
  });

  it('rejects cancellation if only the stop after startup fails, then allows an exact-adapter retry', async () => {
    await start();
    adapter.terminate.mockResolvedValueOnce(undefined);
    const stopped = rpc('instance.terminate', { instanceId: 'pending-session' });
    adapter.resolveStartup(1);
    await expect(stopped).rejects.toThrow('Synthetic pending stop refusal');
    await spawning;
    expect(manager.getInstance('pending-session')?.adapter).toBe(adapter);
    adapter.terminate.mockImplementation(async () => { adapter.running = false; });
    await rpc('instance.terminate', { instanceId: 'pending-session' });
    expect(adapter.running).toBe(false);
    expect(manager.getInstanceCount()).toBe(0);
  });

  it('retains controller ownership after the cancelled spawn rejects so a controller retry reaches the same worker adapter', async () => {
    await start();
    const stopped = remote.terminate();
    adapter.resolveStartup(1);
    await expect(stopped).rejects.toThrow('Synthetic pending stop refusal');
    await spawning;
    expect(remote.getRemoteInstanceId()).toBe('pending-session');
    expect(adapter.running).toBe(true);
    await expect(remote.sendInput('Do not start more work')).rejects.toThrow(/stopping/);
    adapter.terminate.mockImplementation(async () => { adapter.running = false; });
    await remote.terminate(false);
    expect(adapter.terminate).toHaveBeenCalledTimes(3);
    expect(adapter.running).toBe(false);
    expect(manager.getAllInstanceIds()).toEqual([]);
    expect(remote.getRemoteInstanceId()).toBeNull();
  });

  it('keeps final usage observation after failed pending and retained stops until termination succeeds', async () => {
    const completed = vi.fn(); manager.on('instance:complete', completed);
    await start();
    const stopped = remote.terminate(); adapter.resolveStartup(1);
    await expect(stopped).rejects.toThrow('Synthetic pending stop refusal'); await spawning;
    const response = { id: 'late-usage', role: 'assistant', content: '', usage: { inputTokens: 7 } };
    adapter.emit('complete', response);
    expect(completed).toHaveBeenCalledWith('pending-session', response, true);
    await expect(remote.terminate()).rejects.toThrow('Synthetic pending stop refusal');
    adapter.emit('complete', { ...response, id: 'later-usage' });
    expect(completed).toHaveBeenCalledTimes(2);
    adapter.terminate.mockImplementation(async () => { adapter.running = false; });
    await remote.terminate();
    adapter.emit('complete', { ...response, id: 'after-stop' });
    expect(completed).toHaveBeenCalledTimes(2);
  });
});
