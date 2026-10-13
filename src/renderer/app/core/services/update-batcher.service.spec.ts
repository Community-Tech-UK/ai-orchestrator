import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateBatcherService, type StateUpdate } from './update-batcher.service';
import { InstanceStateManager } from '../../../../main/instance/instance-state';
import type { Instance } from '../../../../shared/types/instance.types';
import type { BatchUpdatePayload } from '../../../../shared/types/ipc.types';
import { LIMITS } from '../../../../shared/constants/limits';

describe('UpdateBatcherService', () => {
  let batcher: UpdateBatcherService;
  let flushed: StateUpdate[][];

  beforeEach(() => {
    vi.useFakeTimers();
    batcher = new UpdateBatcherService();
    flushed = [];
    batcher.onFlush((updates) => flushed.push(updates));
  });

  afterEach(() => {
    batcher.destroy();
    vi.useRealTimers();
  });

  it('keeps backgroundWork from an earlier update when a later one in the window omits it', () => {
    batcher.queueUpdate({ instanceId: 'i1', backgroundWork: { count: 1, since: 500 } });
    batcher.queueUpdate({ instanceId: 'i1', status: 'idle' });
    batcher.forceFlush();

    expect(flushed[0]?.[0]?.backgroundWork).toEqual({ count: 1, since: 500 });
  });

  it('lets a later null clear backgroundWork within the same window', () => {
    batcher.queueUpdate({ instanceId: 'i1', backgroundWork: { count: 1, since: 500 } });
    batcher.queueUpdate({ instanceId: 'i1', backgroundWork: null });
    batcher.forceFlush();

    expect(flushed[0]?.[0]?.backgroundWork).toBeNull();
  });

  it('applies the same preserve and clear rules to waitReason', () => {
    batcher.queueUpdate({ instanceId: 'i1', waitReason: { kind: 'backoff', attempt: 1, retryAt: 9 } });
    batcher.queueUpdate({ instanceId: 'i1', status: 'respawning' });
    batcher.queueUpdate({ instanceId: 'i2', waitReason: { kind: 'backoff', attempt: 1, retryAt: 9 } });
    batcher.queueUpdate({ instanceId: 'i2', waitReason: null });
    batcher.forceFlush();

    const byId = new Map(flushed[0]?.map((update) => [update.instanceId, update]));
    expect(byId.get('i1')?.waitReason).toEqual({ kind: 'backoff', attempt: 1, retryAt: 9 });
    expect(byId.get('i2')?.waitReason).toBeNull();
  });

  it('keeps automationRevealed when a later update in the window carries undefined', () => {
    batcher.queueUpdate({ instanceId: 'i1', status: 'error', automationRevealed: true });
    batcher.queueUpdate({ instanceId: 'i1', status: 'busy', automationRevealed: undefined });
    batcher.forceFlush();

    expect(flushed[0]?.[0]?.automationRevealed).toBe(true);
  });

  it.each(['omitted', 'undefined'] as const)('preserves a pending runtime when a later status packet has %s runtime fields', kind => {
    const desired = { provider: 'codex', accountProfileId: 'example-picked' } as const;
    batcher.queueUpdate({ instanceId: 'i1', provider: 'codex', desiredRuntime: desired });
    batcher.queueUpdate({ instanceId: 'i1', status: 'idle',
      ...(kind === 'undefined' ? { provider: undefined, desiredRuntime: undefined } : {}) });
    batcher.forceFlush();
    expect(flushed[0]?.[0]?.desiredRuntime).toEqual(desired);
    expect(flushed[0]?.[0]?.provider).toBe('codex');
  });

  it('retains an explicit pending clear through an undefined status packet', () => {
    batcher.queueUpdate({ instanceId: 'i1', desiredRuntime: { provider: 'claude', model: 'example-model' } });
    batcher.queueUpdate({ instanceId: 'i1', desiredRuntime: null });
    batcher.queueUpdate({ instanceId: 'i1', status: 'idle', desiredRuntime: undefined });
    batcher.forceFlush();
    expect(flushed[0]?.[0]?.desiredRuntime).toBeNull();
  });

  it('lets the newest concrete target and provider supersede earlier targets and clears', () => {
    const latest = { provider: 'codex', accountProfileId: 'example-latest' } as const;
    batcher.queueUpdates([
      { instanceId: 'i1', provider: 'claude', desiredRuntime: { provider: 'claude', model: 'example-old' } },
      { instanceId: 'i1', desiredRuntime: null },
      { instanceId: 'i1', provider: 'codex', desiredRuntime: latest },
      { instanceId: 'i1', status: 'idle', provider: undefined, desiredRuntime: undefined },
    ]);
    batcher.forceFlush();
    expect(flushed[0]?.[0]?.desiredRuntime).toEqual(latest);
    expect(flushed[0]?.[0]?.provider).toBe('codex');
  });

  it('does not invent a pending change or carry a prior clear across flush windows', () => {
    batcher.queueUpdate({ instanceId: 'i1', desiredRuntime: null });
    batcher.forceFlush();
    batcher.queueUpdate({ instanceId: 'i1', status: 'idle', desiredRuntime: undefined, provider: undefined });
    batcher.forceFlush();
    expect(flushed[0]?.[0]?.desiredRuntime).toBeNull();
    expect(flushed[1]?.[0]?.desiredRuntime).toBeUndefined();
    expect(flushed[1]?.[0]?.provider).toBeUndefined();
  });

  it.each(['pending', 'cleared'] as const)('preserves %s ownership and provider while delayed main packets coalesce in the renderer interval', async kind => {
    const desired = { provider: 'codex', accountProfileId: 'example-picked' } as const;
    const instance = { id: 'example-live', provider: 'codex', status: 'idle',
      accountProfileId: 'example-picked', accountRoutingSource: 'explicit',
      contextUsage: { used: 0, total: 1000, percentage: 0 } } as Instance;
    const main = new InstanceStateManager();
    main.setInstance(instance);
    const delivered: BatchUpdatePayload[] = [];
    main.on('batch-update', batch => delivered.push(structuredClone(batch)));
    try {
      main.queueUpdate(instance.id, instance.status, instance.contextUsage,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        { provider: instance.provider, desiredRuntime: kind === 'pending' ? desired : null });
      await vi.advanceTimersByTimeAsync(LIMITS.OUTPUT_BATCH_INTERVAL_MS);
      main.queueUpdate(instance.id, instance.status, instance.contextUsage);
      await vi.advanceTimersByTimeAsync(LIMITS.OUTPUT_BATCH_INTERVAL_MS);
      expect(delivered).toHaveLength(2);
      expect(Object.hasOwn(delivered[1].updates[0], 'desiredRuntime')).toBe(true);
      expect(delivered[1].updates[0].desiredRuntime).toBeUndefined();
      expect(delivered[1].updates[0].provider).toBeUndefined();
      // Electron preserves undefined properties. A renderer draining an IPC
      // backlog can queue these distinct main batches before its next interval.
      for (const packet of delivered) batcher.queueUpdates(packet.updates);
      expect(flushed).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(50);
      expect(flushed).toHaveLength(1);
      expect(flushed[0]?.[0]?.desiredRuntime).toEqual(kind === 'pending' ? desired : null);
      expect(flushed[0]?.[0]?.provider).toBe('codex');
      expect(flushed[0]?.[0]?.accountProfileId).toBe('example-picked');
      expect(flushed[0]?.[0]?.accountRoutingSource).toBe('explicit');
    } finally { main.destroy(); }
  });
});
