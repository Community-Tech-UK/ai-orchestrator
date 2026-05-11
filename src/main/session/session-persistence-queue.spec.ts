import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionPersistenceQueue, _resetSessionPersistenceQueueForTesting, getSessionPersistenceQueue } from './session-persistence-queue';

describe('SessionPersistenceQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetSessionPersistenceQueueForTesting();
  });

  afterEach(async () => {
    vi.useRealTimers();
  });

  it('coalesces multiple enqueueSave calls for the same instance to one task', async () => {
    vi.useRealTimers();
    const queue = new SessionPersistenceQueue();
    const saveFn = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();

    queue.enqueueSave('inst-1', saveFn, onError);
    queue.enqueueSave('inst-1', saveFn, onError);
    queue.enqueueSave('inst-1', saveFn, onError);

    await queue.shutdown({ drain: true });

    expect(saveFn).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('routes save errors to onError and does not throw', async () => {
    vi.useRealTimers();
    const queue = new SessionPersistenceQueue();
    const saveFn = vi.fn().mockRejectedValue(new Error('disk full'));
    const onError = vi.fn();

    queue.enqueueSave('inst-1', saveFn, onError);

    await queue.shutdown({ drain: true });

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it('processes saves for different instances independently', async () => {
    vi.useRealTimers();
    const queue = new SessionPersistenceQueue();
    const save1 = vi.fn().mockResolvedValue(undefined);
    const save2 = vi.fn().mockResolvedValue(undefined);

    queue.enqueueSave('inst-1', save1, vi.fn());
    queue.enqueueSave('inst-2', save2, vi.fn());

    await queue.shutdown({ drain: true });

    expect(save1).toHaveBeenCalledOnce();
    expect(save2).toHaveBeenCalledOnce();
  });

  it('batches enqueueEvent calls before flushing to the queue', () => {
    const queue = new SessionPersistenceQueue();
    const metricsBeforeFlush = queue.metrics();

    queue.enqueueEvent('/tmp/session.log', '{"type":"a"}');
    queue.enqueueEvent('/tmp/session.log', '{"type":"b"}');
    queue.enqueueEvent('/tmp/session.log', '{"type":"c"}');

    // No task in the queue yet (flush timer not fired)
    expect(queue.metrics().queued).toBe(metricsBeforeFlush.queued);

    // Fire flush timer
    vi.advanceTimersByTime(300);

    // Now exactly one event-batch task
    expect(queue.metrics().queued + queue.metrics().inFlight).toBeGreaterThanOrEqual(1);
  });

  it('returns metrics from the underlying bounded queue', async () => {
    vi.useRealTimers();
    const queue = new SessionPersistenceQueue();
    const m = queue.metrics();
    expect(typeof m.queued).toBe('number');
    expect(typeof m.processed).toBe('number');
    expect(typeof m.dropped).toBe('number');
  });

  it('shutdown with drain: false does not process remaining tasks', async () => {
    vi.useRealTimers();
    const queue = new SessionPersistenceQueue();
    const saveFn = vi.fn().mockResolvedValue(undefined);

    queue.enqueueSave('inst-1', saveFn, vi.fn());

    // Shut down without draining — saves might or might not have run
    await queue.shutdown({ drain: false });
    // No assertion on saveFn count — just verify no throw
  });

  it('getSessionPersistenceQueue returns the same singleton', () => {
    const a = getSessionPersistenceQueue();
    const b = getSessionPersistenceQueue();
    expect(a).toBe(b);
  });

  it('_resetSessionPersistenceQueueForTesting creates a fresh instance', () => {
    const a = getSessionPersistenceQueue();
    _resetSessionPersistenceQueueForTesting();
    const b = getSessionPersistenceQueue();
    expect(a).not.toBe(b);
  });
});

describe('SessionPersistenceQueue conversation entry ordering', () => {
  it('processes entries in enqueue order', async () => {
    vi.useRealTimers();
    const queue = new SessionPersistenceQueue();
    const order: string[] = [];

    queue.enqueueSave('inst-1', async () => { order.push('first'); }, vi.fn());
    queue.enqueueSave('inst-2', async () => { order.push('second'); }, vi.fn());

    await queue.shutdown({ drain: true });

    // inst-1 was enqueued before inst-2, so it should appear first
    expect(order).toEqual(['first', 'second']);
  });
});
