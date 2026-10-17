import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';

const holder = vi.hoisted(() => ({ registry: undefined as unknown }));
vi.mock('../../remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => holder.registry }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
import { RemoteCliAdapter } from './remote-cli-adapter';

function barrier() {
  let release!: () => void;
  return { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
}

describe('remote prompt checkpoint lifecycle ownership', () => {
  it('rejects retired preparation after the same routing ID is respawned and preserves the replacement owner', async () => {
    holder.registry = new EventEmitter();
    const oldCheckpoint = barrier();
    const replacementRpc = barrier();
    let checkpoints = 0;
    const sendRpc = vi.fn(async (_node: string, method: string) => {
      if (method === 'instance.sendInput') await replacementRpc.promise;
      return { instanceId: 'same-routing-id' };
    });
    const remote = new RemoteCliAdapter({ sendRpc, isNodeConnected: () => true } as unknown as WorkerNodeConnectionServer,
      'worker', 'opencode', { sessionId: 'same-routing-id', workingDirectory: '/tmp', beforeProviderPrompt: () => ++checkpoints === 1 ? oldCheckpoint.promise : Promise.resolve() });
    await remote.spawn();
    const oldSend = remote.sendInput('retired input'); void oldSend.catch(() => undefined);
    remote.forceCleanup();
    await remote.spawn();
    remote.queueNextPromptContext('Replacement context');
    const newSend = remote.sendInput('replacement input');
    await vi.waitFor(() => expect(sendRpc.mock.calls.filter((call) => call[1] === 'instance.sendInput')).toHaveLength(1));
    try {
      oldCheckpoint.release();
      await Promise.resolve();
      expect(sendRpc.mock.calls.filter((call) => call[1] === 'instance.sendInput')).toHaveLength(1);
      await expect(oldSend).rejects.toThrow('changed before provider dispatch');
      await expect(remote.sendInput('racing input')).rejects.toThrow('previous turn is still running');
    } finally { replacementRpc.release(); await newSend; remote.forceCleanup(); }
  });

  it('reserves a context-free preparation before the callback yields', async () => {
    holder.registry = new EventEmitter();
    const checkpoint = barrier();
    const sendRpc = vi.fn(async () => ({ instanceId: 'routing-id' }));
    const remote = new RemoteCliAdapter({ sendRpc, isNodeConnected: () => true } as unknown as WorkerNodeConnectionServer,
      'worker', 'opencode', { sessionId: 'routing-id', workingDirectory: '/tmp', beforeProviderPrompt: () => checkpoint.promise });
    await remote.spawn();
    const sending = remote.sendInput('first input');
    const racing = remote.sendInput('racing input'); void racing.catch(() => undefined);
    checkpoint.release();
    try { await expect(racing).rejects.toThrow('previous turn is still running'); }
    finally { checkpoint.release(); await sending; remote.forceCleanup(); }
  });

  it('honors cancellation triggered by synchronous admission before writing the RPC', async () => {
    holder.registry = new EventEmitter();
    const sendRpc = vi.fn(async () => ({ instanceId: 'routing-id' }));
    const remote = new RemoteCliAdapter({ sendRpc, isNodeConnected: () => true } as unknown as WorkerNodeConnectionServer,
      'worker', 'opencode', { sessionId: 'routing-id', workingDirectory: '/tmp' });
    const abort = new AbortController();
    await remote.spawn();
    remote.queueNextPromptContext('Context');
    try {
      await expect(remote.sendInput('cancelled', undefined, { dispatch: {
        signal: abort.signal, beforeProviderDispatch: () => abort.abort(),
      } })).rejects.toMatchObject({ name: 'AbortError' });
      expect(sendRpc).toHaveBeenCalledTimes(1);
      await remote.sendInput('next');
      expect(sendRpc).toHaveBeenLastCalledWith('worker', 'instance.sendInput', {
        instanceId: 'routing-id', message: 'Context\n\nnext', attachments: undefined,
      }, 0);
    } finally { remote.forceCleanup(); }
  });

  it('rechecks caller ownership after the durable checkpoint and retains unsent context on refusal', async () => {
    holder.registry = new EventEmitter();
    const checkpoint = barrier();
    let current = true;
    const sendRpc = vi.fn(async () => ({ instanceId: 'routing-id' }));
    const remote = new RemoteCliAdapter({ sendRpc, isNodeConnected: () => true } as unknown as WorkerNodeConnectionServer,
      'worker', 'opencode', { sessionId: 'routing-id', workingDirectory: '/tmp', beforeProviderPrompt: () => checkpoint.promise });
    await remote.spawn();
    const commit = vi.fn();
    const sending = remote.sendInput('retired', undefined, { dispatch: {
      assertCurrent: () => { if (!current) throw new Error('Request replaced'); }, beforeProviderDispatch: commit,
    } });
    void sending.catch(() => undefined);
    current = false; checkpoint.release();
    try {
      await expect(sending).rejects.toThrow('Request replaced');
      expect(commit).not.toHaveBeenCalled();
      expect(sendRpc).toHaveBeenCalledTimes(1);
      await remote.sendInput('replacement');
      expect(sendRpc).toHaveBeenCalledTimes(2);
    } finally { remote.forceCleanup(); }
  });
});
