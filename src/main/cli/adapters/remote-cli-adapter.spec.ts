/**
 * Tests for RemoteCliAdapter.spawn() cleanup invariants (Fix C).
 *
 * The core invariant: once a spawn RPC may have reached the worker,
 * `remoteInstanceId` stays set until termination or exit confirms absence, even if a
 * `spawned` listener throws synchronously. Without this, a throwing listener
 * (downstream schema validation) nulled `remoteInstanceId`, turning the
 * rollback's adapter.terminate() into a no-op and orphaning the remote child.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'events';

const registryEmitter = new EventEmitter();
const pause = { active: false };

vi.mock('../../remote-node/worker-node-registry', () => ({
  getWorkerNodeRegistry: () => registryEmitter,
}));

vi.mock('../../pause/pause-coordinator', () => ({
  getPauseCoordinator: () => ({ isPaused: () => pause.active }),
}));

import { RemoteCliAdapter } from './remote-cli-adapter';
import type { WorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';
import type { UnifiedSpawnOptions } from './adapter-factory';
import { markRemoteUsageSettlement } from './remote-response-usage-settlement';
import { deferUntilResponseUsageSettled } from './deferred-response-usage';
import type { CliResponse } from './base-cli-adapter';

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
    pause.active = false;
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

  it('RPC failure retains remote ownership and observation until a rollback stop confirms absence', async () => {
    const rpcError = new Error('node disconnected mid-spawn');
    const sendRpc = vi.fn().mockRejectedValueOnce(rpcError);
    const adapter = makeAdapter(sendRpc);

    await expect(adapter.spawn()).rejects.toThrow('node disconnected mid-spawn');

    expect(adapter.getRemoteInstanceId()).toBe('inst-remote-1');
    expect(adapter.isRunning()).toBe(true);
    expect(registryEmitter.listenerCount('remote:instance-output')).toBe(1);
    await expect(adapter.spawn()).rejects.toThrow(/stopping/);
    await expect(adapter.sendInput('more work')).rejects.toThrow(/stopping/);
    expect(sendRpc).toHaveBeenCalledTimes(1);

    sendRpc.mockResolvedValueOnce(undefined);
    await adapter.terminate(false);
    expect(sendRpc).toHaveBeenCalledTimes(2);
    expect(sendRpc).toHaveBeenLastCalledWith('windows-pc', 'instance.terminate', { instanceId: 'inst-remote-1' });
    expect(adapter.getRemoteInstanceId()).toBeNull();
    expect(adapter.isRunning()).toBe(false);
    expect(registryEmitter.listenerCount('remote:instance-output')).toBe(0);
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

  it('keeps the acknowledged remote identity and rejects failed termination so a retry still reaches the worker', async () => {
    const sendRpc = vi.fn().mockResolvedValueOnce({ instanceId: 'inst-remote-1' })
      .mockRejectedValueOnce(new Error('stop transport failed')).mockResolvedValueOnce(undefined);
    const adapter = makeAdapter(sendRpc);
    await adapter.spawn();
    await expect(adapter.terminate(false)).rejects.toThrow('stop transport failed');
    expect(adapter.getRemoteInstanceId()).toBe('inst-remote-1');
    await adapter.terminate(false);
    expect(sendRpc.mock.calls.filter(call => call[1] === 'instance.terminate')).toHaveLength(2);
    expect(adapter.getRemoteInstanceId()).toBeNull();
  });
  it('does not declare pending remote billing settled when termination RPC failed', async () => {
    const sendRpc = vi.fn().mockResolvedValueOnce({ instanceId: 'inst-remote-1' }).mockRejectedValueOnce(new Error('stop failed'));
    const adapter = makeAdapter(sendRpc); await adapter.spawn();
    let semantic!: CliResponse; adapter.on('complete', value => { semantic = value; });
    adapter.handleRemoteComplete(markRemoteUsageSettlement({ id: 'response', role: 'assistant', content: '' }, 'pending'));
    let settled = false; deferUntilResponseUsageSettled(semantic, () => { settled = true; });
    await expect(adapter.terminate(false)).rejects.toThrow('stop failed');
    expect(settled).toBe(false);
    registryEmitter.emit('remote:instance-complete', { nodeId: 'windows-pc', instanceId: 'inst-remote-1',
      response: markRemoteUsageSettlement({ id: 'response', role: 'assistant', content: '', usage: { cacheReadTokens: 42 } }, 'settled') });
    expect(settled).toBe(true); expect(semantic.usage?.cacheReadTokens).toBe(42);
    await adapter.terminate(false);
  });
});


describe('RemoteCliAdapter deferred account context', () => {
  beforeEach(() => { registryEmitter.removeAllListeners(); pause.active = false; });

  it('sends queued notices and replay history with one real prompt, then consumes them', async () => {
    const sendRpc = vi.fn().mockResolvedValueOnce({ instanceId: 'inst-remote-1' }).mockResolvedValue(undefined);
    const adapter = makeAdapter(sendRpc);
    await adapter.spawn();
    adapter.queueNextPromptContext('REPLAY');
    adapter.queueNextPromptContext('ACCOUNT');
    expect(sendRpc).toHaveBeenCalledTimes(1);
    await adapter.sendInput('work');
    await adapter.sendInput('next work');
    expect(sendRpc.mock.calls.filter((call) => call[1] === 'instance.sendInput').map((call) => call[2].message))
      .toEqual(['REPLAY\n\nACCOUNT\n\nwork', 'next work']);
  });

  it('retains context after pause and RPC refusal, without consuming later additions', async () => {
    const sendRpc = vi.fn().mockResolvedValueOnce({ instanceId: 'inst-remote-1' })
      .mockRejectedValueOnce(new Error('previous turn still running')).mockResolvedValue(undefined);
    const adapter = makeAdapter(sendRpc);
    await adapter.spawn();
    adapter.queueNextPromptContext('ACCOUNT');
    pause.active = true;
    await expect(adapter.sendInput('work')).rejects.toThrow(/paused/);
    pause.active = false;
    await expect(adapter.sendInput('work')).rejects.toThrow(/previous turn/);
    await adapter.sendInput('work');
    await adapter.sendInput('next');
    expect(sendRpc.mock.calls.filter((call) => call[1] === 'instance.sendInput').map((call) => call[2].message))
      .toEqual(['ACCOUNT\n\nwork', 'ACCOUNT\n\nwork', 'next']);
  });

  it('reserves context for one pending RPC, retaining additions for the following prompt', async () => {
    let release!: () => void;
    const sendRpc = vi.fn().mockResolvedValueOnce({ instanceId: 'inst-remote-1' })
      .mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve; })).mockResolvedValue(undefined);
    const adapter = makeAdapter(sendRpc);
    await adapter.spawn();
    adapter.queueNextPromptContext('FIRST');
    const pending = adapter.sendInput('work');
    adapter.queueNextPromptContext('SECOND');
    await expect(adapter.sendInput('collision')).rejects.toThrow(/previous turn/);
    release();
    await pending;
    await adapter.sendInput('next work');
    expect(sendRpc.mock.calls.filter((call) => call[1] === 'instance.sendInput').map((call) => call[2].message))
      .toEqual(['FIRST\n\nwork', 'SECOND\n\nnext work']);
  });
});
