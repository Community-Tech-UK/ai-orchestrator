import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';
const worker = vi.hoisted(() => ({ capability: 1 as number | undefined }));
const registry = Object.assign(new EventEmitter(), {
  getNode: () => ({ capabilities: { instanceModelChange: worker.capability } }),
});
vi.mock('../../remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => registry }));
vi.mock('../../pause/pause-coordinator', () => ({ getPauseCoordinator: () => ({ isPaused: () => false }) }));
import { RemoteCliAdapter } from './remote-cli-adapter';
import { RPC_ERROR_CODES } from '../../remote-node/worker-node-rpc';

describe('remote model replacement transport', () => {
  beforeEach(() => { worker.capability = 1; registry.removeAllListeners(); });
  function harness() {
    const sendRpc = vi.fn().mockImplementation(async (_node, _method, params) => ({ instanceId: params.replacement?.instanceId ?? params.instanceId }));
    const connection = { sendRpc, isNodeConnected: () => true } as unknown as WorkerNodeConnectionServer;
    const old = new RemoteCliAdapter(connection, 'worker', 'codex', { sessionId: 'old', workingDirectory: '/tmp', model: 'before' });
    const next = new RemoteCliAdapter(connection, 'worker', 'codex', { sessionId: 'next', workingDirectory: '/tmp', model: 'after', reasoningEffort: 'high', resume: true });
    return { old, next, sendRpc, connection };
  }
  it('replaces over one RPC and keeps early output on the new adapter', async () => {
    const { old, next, sendRpc } = harness();
    await old.spawn();
    const output = vi.fn(); next.on('output', output);
    sendRpc.mockImplementationOnce(async (_node, method, params) => {
      expect(method).toBe('instance.changeModel');
      registry.emit('remote:instance-output', { nodeId: 'worker', instanceId: 'next', message: { type: 'assistant', content: 'ready' } });
      return { instanceId: params.replacement.instanceId };
    });
    await expect(old.changeModel(next)).resolves.toBe(-1);
    expect(sendRpc).toHaveBeenLastCalledWith('worker', 'instance.changeModel', {
      previousInstanceId: 'old', replacement: expect.objectContaining({ instanceId: 'next', model: 'after', reasoningEffort: 'high', resume: true }),
    });
    expect(output).toHaveBeenCalledOnce();
    expect(old.isRunning()).toBe(false);
    expect(next.isRunning()).toBe(true);
    expect(sendRpc.mock.calls.map(call => call[1])).toEqual(['instance.spawn', 'instance.changeModel']);
    next.forceCleanup();
  });
  it('refuses an older worker before altering the old adapter', async () => {
    const { old, next, sendRpc } = harness(); await old.spawn(); worker.capability = undefined;
    await expect(old.changeModel(next)).rejects.toThrow(/Update the worker/);
    expect(sendRpc).toHaveBeenCalledOnce(); expect(old.isRunning()).toBe(true); old.forceCleanup();
  });
  it('keeps the old attachment and drops the unacknowledged replacement on refusal', async () => {
    const { old, next, sendRpc } = harness(); await old.spawn();
    sendRpc.mockRejectedValueOnce(new Error(`RPC error ${RPC_ERROR_CODES.MODEL_CHANGE_REJECTED}: A turn is still running.`));
    await expect(old.changeModel(next)).rejects.toThrow(/still running/);
    expect(old.getRemoteInstanceId()).toBe('old'); expect(next.isRunning()).toBe(false);
    expect(registry.listenerCount('remote:instance-output')).toBe(1); old.forceCleanup();
  });
  it('refuses a model change while stopping the old runtime is unconfirmed', async () => {
    const { old, next, sendRpc } = harness(); await old.spawn();
    sendRpc.mockRejectedValueOnce(new Error('stop transport failed'));
    await expect(old.terminate()).rejects.toThrow('stop transport failed');
    await expect(old.changeModel(next)).rejects.toThrow(/stopping/);
    expect(sendRpc.mock.calls.map(call => call[1])).toEqual(['instance.spawn', 'instance.terminate']);
    old.forceCleanup();
  });
  it('rejects invalid metadata before attaching a same-ID replacement or sending an RPC', async () => {
    const { old, sendRpc, connection } = harness(); await old.spawn();
    const invalid = new RemoteCliAdapter(connection, 'worker', 'codex', {
      sessionId: 'old', workingDirectory: '/tmp', model: 'after', trialKey: 'x'.repeat(4097),
    });
    await expect(old.changeModel(invalid)).rejects.toThrow('Invalid remote spawn ownership metadata');
    expect(invalid.isRunning()).toBe(false);
    expect(registry.listenerCount('remote:instance-output')).toBe(1);
    await invalid.terminate();
    await old.sendInput('Continue the retained conversation.');
    expect(sendRpc.mock.calls.map(call => call[1])).toEqual(['instance.spawn', 'instance.sendInput']);
    old.forceCleanup();
  });
  it('forgets the old runtime when a successful replacement acknowledgement arrives after stop', async () => {
    const { old, next, sendRpc } = harness(); await old.spawn();
    let acknowledge!: (response: { instanceId: string }) => void;
    sendRpc.mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }));
    const changing = old.changeModel(next);
    const outcome = changing.catch(error => error);
    await vi.waitFor(() => expect(acknowledge).toBeTypeOf('function'));
    await next.terminate();
    acknowledge({ instanceId: 'next' });
    expect(await outcome).toMatchObject({ message: expect.stringMatching(/before spawn acknowledgement/) });
    expect(old.isRunning()).toBe(false);
    expect(next.isRunning()).toBe(false);
    old.forceCleanup(); next.forceCleanup();
  });
  it('keeps uncertain original cleanup reachable after the proposed replacement exits', async () => {
    const { old, next, sendRpc } = harness(); await old.spawn();
    sendRpc.mockRejectedValueOnce(new Error('connection lost'));
    await expect(old.changeModel(next)).rejects.toThrow('connection lost');
    const exited = vi.fn(); next.on('exit', exited);
    next.handleRemoteExit(0, null);
    expect(exited).not.toHaveBeenCalled(); expect(next.isRunning()).toBe(true);
    await next.terminate();
    expect(sendRpc).toHaveBeenLastCalledWith('worker', 'instance.terminate', { instanceId: 'old' });
    expect(old.isRunning()).toBe(false); expect(next.isRunning()).toBe(false);
    expect(registry.eventNames()).toEqual([]);
  });
  it('rejects replacing an adapter with itself before changing ownership', async () => {
    const { old, sendRpc } = harness(); await old.spawn();
    await expect(old.changeModel(old)).rejects.toThrow(/separate replacement/);
    expect(sendRpc).toHaveBeenCalledOnce(); expect(old.isRunning()).toBe(true); old.forceCleanup();
  });
});
