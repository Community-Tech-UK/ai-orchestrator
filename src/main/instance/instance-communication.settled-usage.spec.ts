import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createInstance, type Instance } from '../../shared/types/instance.types';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliResponse } from '../cli/adapters/base-cli-adapter';
import type { ProviderRuntimeEvent } from '@contracts/types/provider-runtime-events';
import { deferResponseUsage } from '../cli/adapters/deferred-response-usage';
import { markRemoteUsageSettlement, RemoteResponseUsageSettlement } from '../cli/adapters/remote-response-usage-settlement';

const spies = vi.hoisted(() => ({ recordUsage: vi.fn(), attribution: vi.fn(), hook: vi.fn() }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({}) }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({}) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({}) }));
vi.mock('../core/system/cost-tracker', () => ({ getCostTracker: () => ({ recordUsage: spies.recordUsage }) }));
vi.mock('../core/system/cost-attribution', () => ({ recordInstanceTurnAttribution: spies.attribution }));
vi.mock('../context/cache-analytics-service', () => ({ getCacheAnalyticsService: () => ({ recordTurn: vi.fn() }) }));
vi.mock('./instance-lifecycle-hooks', () => ({ dispatchInstanceLifecycleHook: spies.hook }));
import { InstanceCommunicationManager } from './instance-communication';

function fixture() {
  const instances = new Map<string, Instance>();
  const adapters = new Map<string, CliAdapter>();
  const events: { instanceId: string; event: ProviderRuntimeEvent; options: unknown }[] = [];
  const order: string[] = [];
  spies.attribution.mockImplementation(({ instanceId }) => order.push(`usage:${instanceId}`));
  const manager = new InstanceCommunicationManager({
    getInstance: id => instances.get(id), getAdapter: id => adapters.get(id),
    setAdapter: (id, adapter) => { adapters.set(id, adapter); }, deleteAdapter: id => adapters.delete(id),
    queueUpdate: vi.fn(), processOrchestrationOutput: vi.fn(), onInterruptedExit: vi.fn(),
    ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn(),
    emitProviderRuntimeEvent: (instanceId, event, options) => {
      events.push({ instanceId, event, options }); order.push(`${event.kind}:${instanceId}`);
    },
  });
  const add = (id: string, parentId: string | null = null) => {
    const instance: Instance = {
      ...createInstance({ workingDirectory: '/synthetic/settled-usage', provider: 'claude',
        sessionId: `session-${id}`, parentId, agentId: 'build' }),
      id, sessionId: `session-${id}`, status: 'busy', provider: 'claude', currentModel: 'sonnet',
      restartEpoch: 0, parentId, agentId: 'build', requestCount: 1, metadata: {}, outputBuffer: [],
      contextUsage: { used: 0, total: 200000, percentage: 0 },
    };
    const adapter = new EventEmitter() as CliAdapter;
    instances.set(id, instance); adapters.set(id, adapter); manager.setupAdapterEvents(id, adapter);
    return { instance, adapter };
  };
  return { manager, add, adapters, instances, events, order };
}

// Flush queued handlers without treating elapsed time as proof of usage finality.
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
const response = (id: string): CliResponse => ({ id, role: 'assistant', content: 'Checked.' });

describe('normalized completion waits for authoritative usage', () => {
  beforeEach(() => { vi.clearAllMocks(); spies.recordUsage.mockReturnValue({ cost: 0.1 }); });

  it('books late input/output and both caches before publishing exactly one completion', async () => {
    const f = fixture();
    const { adapter, instance } = f.add('root');
    const result = response('late');
    const settle = deferResponseUsage(result);
    adapter.emit('complete', result);
    instance.requestCount = 2;
    await flush();
    expect(f.events).toEqual([]);
    expect(spies.recordUsage).not.toHaveBeenCalled();
    result.usage = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40 };
    settle(); settle();
    await flush();
    expect(f.order).toEqual(['usage:root', 'complete:root']);
    expect(f.events[0].event).toMatchObject({
      kind: 'complete', requestCountAtCompletion: 1,
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40,
    });
    expect(spies.recordUsage).toHaveBeenCalledTimes(1);
    expect(spies.attribution.mock.calls[0][0].usage).toMatchObject({
      inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40,
    });
  });

  it('holds root completion while an idle descendant still has unsettled processed usage', async () => {
    const f = fixture();
    const root = f.add('root'); const child = f.add('child', 'root');
    const result = response('child-late');
    const settle = deferResponseUsage(result);
    child.adapter.emit('complete', result);
    child.instance.status = 'idle';
    root.adapter.emit('complete', response('root-turn'));
    await flush();
    expect(f.events).toEqual([]);
    expect(f.order).toEqual(['usage:root']);
    result.usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 1000, cacheWriteTokens: 2000 };
    settle(); await flush();
    expect(f.order).toEqual(['usage:root', 'usage:child', 'complete:child', 'complete:root']);
  });

  it('still books the captured session if the adapter is replaced during settlement', async () => {
    const f = fixture(); const { adapter, instance } = f.add('root');
    const result = response('superseded'); const settle = deferResponseUsage(result);
    adapter.emit('complete', result); await flush();
    instance.sessionId = 'replacement-session'; instance.currentModel = 'opus';
    f.adapters.set('root', new EventEmitter() as CliAdapter);
    result.usage = { inputTokens: 42, outputTokens: 1 };
    settle(); await flush();
    expect(spies.recordUsage.mock.calls[0].slice(0, 3)).toEqual(['root', 'session-root', 'sonnet']);
    expect(f.events).toEqual([]);
  });

  it('allows cleanup to settle usage through adapter termination without waiting on itself', async () => {
    const f = fixture(); const { adapter } = f.add('root');
    const result = response('teardown-finality'); const settle = deferResponseUsage(result);
    adapter.terminate = vi.fn(async () => {
      result.usage = { inputTokens: 10, cacheReadTokens: 500 };
      settle();
    });
    adapter.emit('complete', result); await flush();
    const cleanup = f.manager.forceCleanupAdapter('root');
    await flush();
    expect(adapter.terminate).toHaveBeenCalledOnce();
    await cleanup;
    expect(spies.recordUsage).toHaveBeenCalledTimes(1);
    expect(f.events.filter(({ event }) => event.kind === 'complete')).toHaveLength(1);
  });

  it('publishes one completion after the real remote pending/finalization protocol', async () => {
    const f = fixture(); const { adapter } = f.add('root');
    const remote = new RemoteResponseUsageSettlement();
    const result = response('remote-turn');
    const semantic = remote.accept(markRemoteUsageSettlement(result, 'pending'))!;
    adapter.emit('complete', semantic); await flush();
    expect(f.events).toEqual([]);
    result.usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 30 };
    expect(remote.accept(markRemoteUsageSettlement(result, 'settled'))).toBeUndefined();
    await flush();
    expect(f.order).toEqual(['usage:root', 'complete:root']);
    expect(f.events[0].event).toMatchObject({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, cacheWriteTokens: 30 });
    remote.settleAll(); await flush();
    expect(spies.recordUsage).toHaveBeenCalledTimes(1);
    expect(f.events).toHaveLength(1);
  });

  it('keeps the pending descendant barrier when the child is removed before finalization', async () => {
    const f = fixture(); const root = f.add('root'); const child = f.add('child', 'root');
    const result = response('removed-child'); const settle = deferResponseUsage(result);
    child.adapter.emit('complete', result); await flush();
    f.instances.delete('child'); f.adapters.delete('child');
    root.adapter.emit('complete', response('root')); await flush();
    expect(f.events).toEqual([]);
    expect(f.order).toEqual(['usage:root']);
    result.usage = { cacheReadTokens: 1000, cacheWriteTokens: 1000 };
    settle(); await flush();
    expect(f.order).toEqual(['usage:root', 'usage:child', 'complete:root']);
  });

  it('retains error metadata, output and immediate completion when usage is already final', async () => {
    const f = fixture(); const { adapter } = f.add('root');
    const result = { ...response('failed'), metadata: { turnErrored: true }, usage: { inputTokens: 1 } };
    adapter.emit('complete', result); await flush();
    expect(f.order).toEqual(['usage:root', 'complete:root']);
    expect(f.events[0].options).toMatchObject({ raw: { payload: { content: 'Checked.', metadata: { turnErrored: true } } } });
    expect(spies.hook).toHaveBeenCalledWith('Stop', expect.anything(), expect.objectContaining({ stopReason: 'error', transcript: 'Checked.' }), expect.anything(), expect.anything());
  });
});
