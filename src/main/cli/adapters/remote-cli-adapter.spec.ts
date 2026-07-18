/**
 * Tests for RemoteCliAdapter.spawn() cleanup invariants (Fix C).
 *
 * The core invariant: once the worker has acknowledged the spawn RPC,
 * `remoteInstanceId` stays set until terminate() clears it — even if a
 * `spawned` listener throws synchronously. Without this, a throwing listener
 * (downstream schema validation) nulled `remoteInstanceId`, turning the
 * rollback's adapter.terminate() into a no-op and orphaning the remote child.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

const registryEmitter = new EventEmitter();

vi.mock('../../remote-node/worker-node-registry', () => ({
  getWorkerNodeRegistry: () => registryEmitter,
}));

vi.mock('../../pause/pause-coordinator', () => ({
  getPauseCoordinator: () => ({ isPaused: () => false }),
}));

import { RemoteCliAdapter } from './remote-cli-adapter';
import type { WorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';
import type { UnifiedSpawnOptions } from './adapter-factory';

function makeAdapter(sendRpc: ReturnType<typeof vi.fn>): RemoteCliAdapter {
  const nodeConnection = {
    sendRpc,
    isNodeConnected: vi.fn(() => true),
  } as unknown as WorkerNodeConnectionServer;
  const spawnOptions = {
    sessionId: 'inst-remote-1',
    workingDirectory: '/repo',
  } as unknown as UnifiedSpawnOptions;
  return new RemoteCliAdapter(nodeConnection, 'windows-pc', 'claude', spawnOptions);
}

describe('RemoteCliAdapter.spawn() cleanup invariants', () => {
  beforeEach(() => {
    registryEmitter.removeAllListeners();
  });

  it('RPC success + throwing `spawned` listener keeps remoteInstanceId set so terminate() reaches the worker (Fix C)', async () => {
    const sendRpc = vi.fn().mockResolvedValueOnce({ instanceId: 'inst-remote-1' });
    const adapter = makeAdapter(sendRpc);

    // Simulate the real bug: a downstream `spawned` listener throws synchronously.
    adapter.on('spawned', () => {
      throw new Error('schema validation exploded');
    });

    // The listener's throw propagates out of spawn() (emit is synchronous)...
    await expect(adapter.spawn()).rejects.toThrow('schema validation exploded');

    // ...but the adapter is NOT reset — the worker acknowledged the spawn.
    expect(adapter.getRemoteInstanceId()).toBe('inst-remote-1');
    expect(adapter.isRunning()).toBe(true);

    // The rollback's terminate() therefore actually sends the terminate RPC.
    sendRpc.mockResolvedValueOnce(undefined);
    await adapter.terminate(false);

    expect(sendRpc).toHaveBeenCalledWith(
      'windows-pc',
      'instance.terminate',
      { instanceId: 'inst-remote-1' },
    );
    expect(adapter.getRemoteInstanceId()).toBeNull();
  });

  it('RPC failure nulls remoteInstanceId, detaches listeners, rethrows; later terminate() is a no-op', async () => {
    const rpcError = new Error('node disconnected mid-spawn');
    const sendRpc = vi.fn().mockRejectedValueOnce(rpcError);
    const adapter = makeAdapter(sendRpc);

    await expect(adapter.spawn()).rejects.toThrow('node disconnected mid-spawn');

    expect(adapter.getRemoteInstanceId()).toBeNull();
    expect(adapter.isRunning()).toBe(false);
    // Registry listeners were detached on the failure path.
    expect(registryEmitter.listenerCount('remote:instance-output')).toBe(0);

    // terminate() after an RPC-failed spawn sends no terminate RPC (nothing to kill).
    await adapter.terminate(false);
    expect(sendRpc).toHaveBeenCalledTimes(1); // only the failed spawn RPC
  });

  it('regression shape: spawn → throwing listener → rollback terminate(false) sends the terminate RPC', async () => {
    const sendRpc = vi.fn().mockResolvedValueOnce({ instanceId: 'inst-remote-1' });
    const adapter = makeAdapter(sendRpc);

    adapter.on('spawned', () => {
      throw new Error('zod: event.pid Too small');
    });

    await expect(adapter.spawn()).rejects.toThrow();

    // Emulate addAdapterRollback ordering: removeAllListeners() then terminate(false).
    adapter.removeAllListeners();
    sendRpc.mockResolvedValueOnce(undefined);
    await adapter.terminate(false);

    expect(sendRpc).toHaveBeenCalledWith(
      'windows-pc',
      'instance.terminate',
      { instanceId: 'inst-remote-1' },
    );
  });

  it('clean spawn (no throwing listener) returns -1 and stays running', async () => {
    const sendRpc = vi.fn().mockResolvedValueOnce({ instanceId: 'inst-remote-1' });
    const adapter = makeAdapter(sendRpc);

    const spawnedPids: number[] = [];
    adapter.on('spawned', (pid: number) => spawnedPids.push(pid));

    const pid = await adapter.spawn();

    expect(pid).toBe(-1);
    expect(spawnedPids).toEqual([-1]);
    expect(adapter.getRemoteInstanceId()).toBe('inst-remote-1');
    expect(adapter.isRunning()).toBe(true);
  });
});
