import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UpdateBatcherService, type StateUpdate } from './update-batcher.service';

describe('UpdateBatcherService', () => {
  let batcher: UpdateBatcherService;
  let flushed: StateUpdate[][];

  beforeEach(() => {
    batcher = new UpdateBatcherService();
    flushed = [];
    batcher.onFlush((updates) => flushed.push(updates));
  });

  afterEach(() => batcher.destroy());

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
});
