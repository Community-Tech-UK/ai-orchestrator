import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerNodeConnectionServer } from '../main/remote-node/worker-node-connection';
import type { SpawnParams } from './local-instance-manager';

const holder = vi.hoisted(() => ({ native: undefined as unknown, registry: undefined as unknown }));
vi.mock('../main/cli/adapters/adapter-factory', () => ({ createCliAdapter: () => holder.native }));
vi.mock('../main/remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => holder.registry }));
vi.mock('../main/logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../main/pause/pause-coordinator', () => ({ getPauseCoordinator: () => ({ isPaused: () => false }) }));
import { LocalInstanceManager } from './local-instance-manager';
import { RemoteCliAdapter } from '../main/cli/adapters/remote-cli-adapter';

afterEach(() => vi.useRealTimers());

describe('actual worker activity to remote provider-turn lease', () => {
  it.each(['heartbeat', 'output'])('renews during continuous %s activity without a frame on every event', async (activity) => {
    vi.useFakeTimers();
    const registry = new EventEmitter(); holder.registry = registry;
    const makeNative = () => Object.assign(new EventEmitter(), {
      active: true, spawn: async () => 1, terminate: async () => undefined,
      sendInput: async () => undefined, interrupt: () => undefined,
      hasActiveTurn() { return this.active; }, hasActiveToolCalls: () => false, getSessionId: () => 'native',
    });
    let native = makeNative(); holder.native = native;
    const manager = new LocalInstanceManager(['/tmp']);
    const frames: { at: number; info: unknown }[] = [];
    manager.on('instance:stateChange', (instanceId: string, state: string, info: unknown) => {
      if (state === 'provider_turn') frames.push({ at: Date.now(), info });
      registry.emit('remote:instance-state-change', { nodeId: 'worker', instanceId, state, info });
    });
    manager.on('instance:heartbeat', instanceId => registry.emit('remote:instance-heartbeat', { nodeId: 'worker', instanceId }));
    const connected = vi.fn(() => true);
    const sendRpc = vi.fn(async (_node: string, method: string, params: SpawnParams) => {
      if (method === 'instance.spawn') await manager.spawn(params);
      if (method === 'instance.terminate') await manager.terminate(params.instanceId);
      return { instanceId: 'routing' };
    });
    const remote = new RemoteCliAdapter({ sendRpc, isNodeConnected: connected } as unknown as WorkerNodeConnectionServer,
      'worker', 'opencode', { sessionId: 'routing', workingDirectory: '/tmp' });
    const emitActivity = () => native.emit(activity, ...(activity === 'output' ? ['streaming activity'] : []));
    let beat: ReturnType<typeof setInterval> | undefined;
    try {
      await remote.spawn(); native.emit('status', 'busy'); await Promise.resolve();
      expect(remote.hasActiveTurn()).toBe(true);
      beat = setInterval(emitActivity, 1_000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(native.hasActiveTurn()).toBe(true);
      expect(remote.hasActiveTurn()).toBe(true);
      expect(frames.length).toBeGreaterThanOrEqual(12);
      expect(frames.length).toBeLessThanOrEqual(14);
      expect(frames.slice(1).every((frame, index) => frame.at - frames[index].at <= 5_000)).toBe(true);
      connected.mockReturnValue(false); expect(remote.hasActiveTurn()).toBe(false);
      connected.mockReturnValue(true); expect(remote.hasActiveTurn()).toBe(true);
      clearInterval(beat); beat = undefined;
      native.active = false; native.emit('complete', { id: 'done', role: 'assistant', content: '' });
      await Promise.resolve(); expect(remote.hasActiveTurn()).toBe(false);
      await manager.terminate('routing'); remote.forceCleanup();
      const oldNative = native;
      native = makeNative(); native.active = false; holder.native = native;
      await remote.spawn();
      const afterReplacement = frames.length;
      oldNative.emit('heartbeat'); oldNative.emit('status', 'busy'); await Promise.resolve();
      expect(frames).toHaveLength(afterReplacement);
      expect(remote.hasActiveTurn()).toBe(false);
      native.active = true; native.emit('status', 'busy'); await Promise.resolve();
      expect(remote.hasActiveTurn()).toBe(true);
      // A lost transport cannot keep renewing the controller's last lease.
      registry.removeAllListeners();
      await vi.advanceTimersByTimeAsync(15_001);
      expect(remote.hasActiveTurn()).toBe(false);
    } finally {
      if (beat) clearInterval(beat);
      remote.forceCleanup(); await manager.terminateAll();
      const beforeCleanupActivity = frames.length;
      emitActivity(); await vi.advanceTimersByTimeAsync(10_000);
      expect(frames).toHaveLength(beforeCleanupActivity);
    }
  });
});
