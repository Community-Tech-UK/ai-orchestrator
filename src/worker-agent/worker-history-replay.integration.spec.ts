import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import type { WorkerNodeConnectionServer } from '../main/remote-node/worker-node-connection';
import { RemoteCliAdapter } from '../main/cli/adapters/remote-cli-adapter';
import { createInitializedAgentHarness, TestAcpCliAdapter } from '../main/cli/adapters/acp-cli-adapter.test-helpers';
import { LocalInstanceManager } from './local-instance-manager';
import { WorkerInstanceNotifier } from './worker-instance-notifier';
import { wireInstanceEvents } from './worker-event-wiring';
import { COORDINATOR_TO_NODE_PARAM_SCHEMAS } from '../main/remote-node/rpc-schemas';

const holder = vi.hoisted(() => ({ registry: undefined as unknown, adapter: undefined as unknown }));
vi.mock('../main/remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => holder.registry }));
vi.mock('../main/cli/adapters/adapter-factory', () => ({ createCliAdapter: () => holder.adapter }));
vi.mock('../main/logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));

describe('native worker history replay over actual notifier frames', () => {
  it.each([false, true])('delivers chunked native history and refuses incomplete transfer (%s)', async (dropChunk) => {
    const registry = Object.assign(new EventEmitter(), { getNode: () => ({ capabilities: { openCodeMajor: 2 } }) }); holder.registry = registry;
    const proc = createInitializedAgentHarness();
    const native = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', resume: true, sessionId: 'native-session' });
    native.configureOpenCodeV2(true); holder.adapter = native;
    vi.spyOn(native, 'terminate').mockImplementation(async () => { proc.exit(); });
    const manager = new LocalInstanceManager(['/tmp']);
    const frames: Record<string, unknown>[] = [];
    const socket = { readyState: WebSocket.OPEN, bufferedAmount: 0, send: (text: string, done?: (error?: Error) => void) => {
      const packet = JSON.parse(text) as { params: Record<string, unknown> };
      frames.push(packet.params);
      const info = packet.params['info'] as { payload?: { index?: number } } | undefined;
      if (dropChunk && packet.params['state'] === 'history_replay' && info?.payload?.index === 1) { done?.(); return; }
      registry.emit('remote:instance-state-change', { nodeId: 'worker', ...packet.params });
      done?.();
    } } as unknown as WebSocket;
    const notifier = new WorkerInstanceNotifier({ getSocket: () => socket, getToken: () => undefined });
    wireInstanceEvents(manager, new EventEmitter(), notifier);
    const sendRpc = vi.fn(async (_node: string, method: string, params: unknown) => {
      const parsed = COORDINATOR_TO_NODE_PARAM_SCHEMAS[method].parse(JSON.parse(JSON.stringify(params)));
      if (method === 'instance.spawn') { await manager.spawn(parsed as Parameters<typeof manager.spawn>[0]); return { instanceId: 'remote-session' }; }
      if (method === 'instance.terminate') { await manager.terminate('remote-session'); return {}; }
      throw new Error('Unexpected fixture RPC');
    });
    const remote = new RemoteCliAdapter({ sendRpc, isNodeConnected: () => true } as unknown as WorkerNodeConnectionServer, 'worker', 'opencode', { sessionId: 'remote-session', workingDirectory: '/tmp', resume: true });
    const histories: unknown[] = []; remote.on('history_replay', (history) => histories.push(history));
    const answer = 'Fixture recovered answer '.repeat(10_000);
    proc.onRequest('session/load', (request) => {
      proc.notify('session/update', { sessionId: 'native-session', update: { sessionUpdate: 'user_message_chunk', messageId: 'u1', content: { type: 'text', text: 'Original request' } } });
      proc.notify('session/update', { sessionId: 'native-session', update: { sessionUpdate: 'agent_message_chunk', messageId: 'a1', content: { type: 'text', text: answer } } });
      proc.respond(request.id, { configOptions: [] });
    });
    try {
      if (dropChunk) {
        await expect(remote.spawn()).rejects.toThrow('did not deliver the loaded session history');
        expect(histories).toEqual([]);
        expect(manager.getInstanceCount()).toBe(0);
        expect(sendRpc).toHaveBeenLastCalledWith('worker', 'instance.terminate', { instanceId: 'remote-session' });
        return;
      }
      await remote.spawn();
      expect(histories).toEqual([{ sessionId: 'native-session', messages: [expect.objectContaining({ id: 'u1', type: 'user', content: 'Original request' }), expect.objectContaining({ id: 'a1', type: 'assistant', content: answer })] }]);
      const chunks = frames.filter((frame) => frame['state'] === 'history_replay');
      expect(chunks.length).toBeGreaterThan(1);
      const stale = chunks[0]['info'] as Record<string, unknown>;
      registry.emit('remote:instance-state-change', { nodeId: 'worker', instanceId: 'remote-session', state: 'history_replay', info: { ...stale, interactionId: 'stale-incarnation' } });
      expect(histories).toHaveLength(1);
      expect(remote.getSessionId()).toBe('native-session');
    } finally { remote.forceCleanup(); proc.exit(); await manager.terminateAll(); }
  });

  it('awaits coordinator invalidation before remote input and keeps callbacks out of RPC parameters', async () => {
    holder.registry = new EventEmitter();
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const checkpoint = vi.fn(async () => barrier);
    const sendRpc = vi.fn(async (_node: string, _method: string, _params: unknown) => ({ instanceId: 'remote-session' }));
    const remote = new RemoteCliAdapter({ sendRpc, isNodeConnected: () => true } as unknown as WorkerNodeConnectionServer, 'worker', 'opencode', { sessionId: 'remote-session', workingDirectory: '/tmp', beforeProviderPrompt: checkpoint });
    try {
      await remote.spawn();
      const sending = remote.sendInput('Fixture user input');
      expect(checkpoint).toHaveBeenCalledOnce();
      expect(sendRpc).toHaveBeenCalledOnce();
      release(); await sending;
      expect(sendRpc).toHaveBeenCalledTimes(2);
      expect(sendRpc.mock.calls[0][2]).not.toHaveProperty('beforeProviderPrompt');
      checkpoint.mockRejectedValueOnce(new Error('Fixture checkpoint failure'));
      await expect(remote.sendInput('Refused fixture input')).rejects.toThrow('Fixture checkpoint failure');
      expect(sendRpc).toHaveBeenCalledTimes(2);
    } finally { remote.forceCleanup(); }
  });
});
