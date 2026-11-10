import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { remoteContextDetails } from '../../remote-node/instance-interaction-schemas';
import { evaluateLoopContextDiscipline } from '../../orchestration/loop-context-discipline-runtime';
import { observeAdapterRuntimeEvents, type NormalizedAdapterRuntimeEvent } from '../../providers/adapter-runtime-event-bridge';
import type { WorkerNodeConnectionServer } from '../../remote-node/worker-node-connection';
import type { CliType } from '../cli-detection';
import { RemoteCliAdapter } from './remote-cli-adapter';

const registry = Object.assign(new EventEmitter(), { getNode: () => ({ capabilities: { codexHelperPolicy: 1 } }) });
vi.mock('../../remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => registry }));
vi.mock('../../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));

function makeAdapter(provider: CliType = 'copilot', sendRpc = vi.fn().mockResolvedValue({ instanceId: 'remote-owner' })) {
  const connection = { sendRpc, isNodeConnected: () => true } as unknown as WorkerNodeConnectionServer;
  return { adapter: new RemoteCliAdapter(connection, 'worker', provider, { sessionId: 'remote-owner', workingDirectory: '/synthetic/remote' }), sendRpc };
}
function recycle(adapter: RemoteCliAdapter): boolean {
  return evaluateLoopContextDiscipline({ adapter, enabled: false, resetAtUtilization: 0.95,
    cumulativeTokens: 9999999, alreadyNotifiedUnavailable: false }).decision.recycle;
}
function context(usage: unknown, nodeId = 'worker', instanceId = 'remote-owner') {
  registry.emit('remote:instance-context', { nodeId, instanceId, usage });
}
const rootUsage = { premiumRequests: 0, compactions: 1, postCompactionTokens: 901, tokenLimit: 1000 };

beforeEach(() => registry.removeAllListeners());

describe('remote Copilot numeric context integration', () => {
  it.each([[900, false], [901, true]])('worker projection reaches the real loop evaluator at %s tokens', async (tokens, expected) => {
    const { adapter } = makeAdapter();
    await adapter.spawn();
    const events: NormalizedAdapterRuntimeEvent[] = [];
    const stop = observeAdapterRuntimeEvents(adapter, event => events.push(event));
    // Same projection used by LocalInstanceManager before the remote notification.
    context({ used: tokens, total: 1000, percentage: tokens / 10, ...remoteContextDetails({
      copilotUsage: { ...rootUsage, postCompactionTokens: tokens, message: 'SYNTHETIC_BODY' },
      content: 'SYNTHETIC_BODY',
    }) });
    expect(recycle(adapter)).toBe(expected);
    expect(adapter.getCopilotUsage?.()).toEqual({ ...rootUsage, postCompactionTokens: tokens });
    expect(events[0]?.event).toEqual({ kind: 'context', used: tokens, total: 1000, percentage: tokens / 10,
      copilotUsage: { ...rootUsage, postCompactionTokens: tokens } });
    expect(JSON.stringify(events[0]?.event)).not.toContain('SYNTHETIC_BODY');
    stop();
    await adapter.terminate();
  });

  it('keeps zero measured, copies the snapshot, and makes older or invalid evidence unavailable', async () => {
    const { adapter } = makeAdapter();
    await adapter.spawn();
    context({ copilotUsage: rootUsage });
    expect(adapter.getCopilotUsage?.()?.premiumRequests).toBe(0);
    const copy = adapter.getCopilotUsage?.();
    if (copy) copy.compactions = 999;
    expect(adapter.getCopilotUsage?.()?.compactions).toBe(1);
    for (const usage of [
      { used: 999, total: 1000 },
      { copilotUsage: { ...rootUsage, premiumRequests: '0' } },
      { copilotUsage: { ...rootUsage, postCompactionTokens: Infinity } },
      { copilotUsage: { ...rootUsage, compactions: -1 } },
    ]) {
      context(usage);
      expect(adapter.getCopilotUsage?.()).toBeUndefined();
      expect(recycle(adapter)).toBe(false);
    }
    await adapter.terminate();
  });

  it('ignores other owners/providers and never substitutes helper counters for root evidence', async () => {
    const { adapter } = makeAdapter();
    await adapter.spawn();
    context({ copilotUsage: rootUsage }, 'other-worker');
    context({ copilotUsage: rootUsage }, 'worker', 'old-provider-session');
    expect(adapter.getCopilotUsage?.()).toBeUndefined();
    context({ copilotUsage: { premiumRequests: 15, compactions: 0, helper: rootUsage } });
    expect(adapter.getCopilotUsage?.()).toEqual({ premiumRequests: 15, compactions: 0 });
    expect(recycle(adapter)).toBe(false);
    const { adapter: other } = makeAdapter('codex');
    await other.spawn();
    context({ copilotUsage: rootUsage });
    expect(other.getCopilotUsage?.()).toBeUndefined();
    expect(recycle(other)).toBe(false);
    await other.terminate();
    await adapter.terminate();
  });

  it.each(['terminate', 'exit', 'forceCleanup'] as const)('clears evidence immediately on %s and rejects late context', async action => {
    let release!: (value: unknown) => void;
    const sendRpc = vi.fn().mockResolvedValueOnce({ instanceId: 'remote-owner' })
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const { adapter } = makeAdapter('copilot', sendRpc);
    await adapter.spawn();
    context({ copilotUsage: rootUsage });
    expect(recycle(adapter)).toBe(true);
    const stopping = action === 'terminate' ? adapter.terminate()
      : action === 'exit' ? adapter.handleRemoteExit(0, null) : adapter.forceCleanup();
    expect(adapter.getCopilotUsage?.()).toBeUndefined();
    context({ copilotUsage: rootUsage });
    adapter.handleRemoteContext({ copilotUsage: rootUsage });
    expect(adapter.getCopilotUsage?.()).toBeUndefined();
    expect(recycle(adapter)).toBe(false);
    if (action === 'terminate') release(undefined);
    await stopping;
  });

  it.each(['spawn', 'sendInput'] as const)('refuses %s until a pending stop has completed', async action => {
    let release!: (value: unknown) => void;
    const sendRpc = vi.fn().mockResolvedValueOnce({ instanceId: 'remote-owner' })
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValue({ instanceId: 'remote-owner' });
    const { adapter } = makeAdapter('copilot', sendRpc);
    await adapter.spawn();
    const stopping = adapter.terminate();
    try {
      await expect(action === 'spawn' ? adapter.spawn() : adapter.sendInput('Fixture input')).rejects.toThrow(/stopping/);
      expect(sendRpc).toHaveBeenCalledTimes(2);
      release(undefined); await stopping;
      await adapter.spawn(); context({ copilotUsage: rootUsage });
      expect(adapter.getCopilotUsage?.()).toEqual(rootUsage);
    } finally { release(undefined); await stopping; await adapter.terminate(); }
  });

  it('clears on spawn and ignores a late failed spawn after a replacement has supplied evidence', async () => {
    let rejectOld!: (error: Error) => void;
    const sendRpc = vi.fn().mockResolvedValueOnce({ instanceId: 'remote-owner' })
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectOld = reject; }))
      .mockResolvedValue({ instanceId: 'replacement' });
    const { adapter } = makeAdapter('copilot', sendRpc);
    await adapter.spawn();
    context({ copilotUsage: rootUsage });
    expect(recycle(adapter)).toBe(true);
    const oldSpawn = adapter.spawn();
    expect(adapter.getCopilotUsage?.()).toBeUndefined();
    await adapter.spawn();
    context({ copilotUsage: rootUsage }, 'worker', 'replacement');
    rejectOld(new Error('old spawn failed'));
    await expect(oldSpawn).rejects.toThrow('old spawn failed');
    expect(adapter.getRemoteInstanceId()).toBe('replacement');
    expect(recycle(adapter)).toBe(true);
    await adapter.terminate();
  });

  it('keeps a replacement with the same remote ID when the preceding stop is acknowledged after its exit', async () => {
    let release!: (value: unknown) => void;
    const sendRpc = vi.fn().mockResolvedValueOnce({ instanceId: 'remote-owner' })
      .mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValue({ instanceId: 'remote-owner' });
    const { adapter } = makeAdapter('copilot', sendRpc);
    await adapter.spawn();
    const stopping = adapter.terminate();
    try {
      adapter.handleRemoteExit(0, null);
      await adapter.spawn();
      expect(adapter.isRunning()).toBe(true);
      release(undefined); await stopping;
      expect(adapter.getRemoteInstanceId()).toBe('remote-owner');
      expect(adapter.isRunning()).toBe(true);
      context({ copilotUsage: rootUsage });
      expect(adapter.getCopilotUsage()).toEqual(rootUsage);
    } finally { release(undefined); await stopping; await adapter.terminate(); }
  });

  it('does not resurrect evidence or publish a spawn acknowledged after stop', async () => {
    let acknowledge!: (value: unknown) => void;
    const sendRpc = vi.fn().mockImplementationOnce(() => new Promise(resolve => { acknowledge = resolve; }))
      .mockResolvedValue(undefined);
    const { adapter } = makeAdapter('copilot', sendRpc);
    const spawned = vi.fn();
    adapter.on('spawned', spawned);
    const pending = adapter.spawn();
    context({ copilotUsage: rootUsage });
    expect(recycle(adapter)).toBe(true);
    await adapter.terminate();
    acknowledge({ instanceId: 'remote-owner' });
    await expect(pending).rejects.toThrow('Remote instance changed before spawn acknowledgement.');
    context({ copilotUsage: rootUsage });
    expect(adapter.isRunning()).toBe(false);
    expect(adapter.getCopilotUsage?.()).toBeUndefined();
    expect(spawned).not.toHaveBeenCalled();
  });

  it('drops early worker counters when the spawn RPC fails', async () => {
    let reject!: (error: Error) => void;
    const sendRpc = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const { adapter } = makeAdapter('copilot', sendRpc);
    const pending = adapter.spawn();
    context({ copilotUsage: rootUsage });
    expect(recycle(adapter)).toBe(true);
    reject(new Error('spawn failed'));
    await expect(pending).rejects.toThrow('spawn failed');
    context({ copilotUsage: rootUsage });
    expect(adapter.getCopilotUsage?.()).toBeUndefined();
    expect(recycle(adapter)).toBe(false);
    expect(adapter.isRunning()).toBe(true);
    expect(adapter.getRemoteInstanceId()).toBe('remote-owner');
    sendRpc.mockResolvedValueOnce(undefined);
    await adapter.terminate(false);
    expect(sendRpc).toHaveBeenLastCalledWith('worker', 'instance.terminate', { instanceId: 'remote-owner' });
    expect(adapter.isRunning()).toBe(false);
  });
});
