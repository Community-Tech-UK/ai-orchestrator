import { describe, it, expect } from 'vitest';
import { DispatchLog, DispatchTransitionError } from './dispatch-log';

describe('DispatchLog', () => {
  it('creates a pending handoff', () => {
    const log = new DispatchLog();
    const r = log.create('m1', 'lead', 'worker', { task: 'x' }, 0);
    expect(r).toMatchObject({ id: 'm1', from: 'lead', to: 'worker', status: 'pending', attempts: 0 });
  });

  it('create is idempotent by id (returns the existing record)', () => {
    const log = new DispatchLog();
    const a = log.create('m1', 'lead', 'worker', { v: 1 }, 0);
    log.markNotified('m1', 1);
    const b = log.create('m1', 'lead', 'worker', { v: 2 }, 2);
    expect(b).toBe(a);
    expect(b.status).toBe('notified'); // not reset
    expect((b.payload as { v: number }).v).toBe(1); // original payload kept
  });

  it('drives the happy path pending → notified → delivered', () => {
    const log = new DispatchLog();
    log.create('m1', 'a', 'b', undefined, 0);
    expect(log.markNotified('m1', 1).status).toBe('notified');
    expect(log.markNotified('m1', 1).attempts).toBe(1);
    const d = log.markDelivered('m1', 2);
    expect(d.status).toBe('delivered');
    expect(d.updatedAt).toBe(2);
  });

  it('is idempotent when re-applying the current state', () => {
    const log = new DispatchLog();
    log.create('m1', 'a', 'b', undefined, 0);
    log.markNotified('m1', 1);
    const again = log.markNotified('m1', 5);
    expect(again.status).toBe('notified');
    expect(again.attempts).toBe(1); // not incremented a second time
    expect(again.updatedAt).toBe(1); // no-op didn't bump
  });

  it('rejects invalid transitions', () => {
    const log = new DispatchLog();
    log.create('m1', 'a', 'b', undefined, 0);
    // pending → delivered is not allowed (must notify first)
    expect(() => log.markDelivered('m1', 1)).toThrow(DispatchTransitionError);
    log.markNotified('m1', 1);
    log.markDelivered('m1', 2);
    // delivered is terminal
    expect(() => log.markFailed('m1', 'boom', 3)).toThrow(DispatchTransitionError);
  });

  it('supports fail then retry (failed → pending)', () => {
    const log = new DispatchLog();
    log.create('m1', 'a', 'b', undefined, 0);
    log.markNotified('m1', 1);
    const f = log.markFailed('m1', 'timeout', 2);
    expect(f).toMatchObject({ status: 'failed', error: 'timeout' });
    const retried = log.retry('m1', 3);
    expect(retried.status).toBe('pending');
    // can go through the cycle again
    expect(log.markNotified('m1', 4).attempts).toBe(2);
  });

  it('clears the error on successful delivery', () => {
    const log = new DispatchLog();
    log.create('m1', 'a', 'b', undefined, 0);
    log.markNotified('m1', 1);
    log.markFailed('m1', 'x', 2);
    log.retry('m1', 3);
    log.markNotified('m1', 4);
    expect(log.markDelivered('m1', 5).error).toBeUndefined();
  });

  it('lists/filters and exposes pending + replayable sets', () => {
    const log = new DispatchLog();
    log.create('m1', 'a', 'b', undefined, 0); // pending
    log.create('m2', 'a', 'c', undefined, 0);
    log.markNotified('m2', 1); // notified
    log.create('m3', 'a', 'd', undefined, 0);
    log.markNotified('m3', 1);
    log.markDelivered('m3', 2); // delivered
    log.create('m4', 'a', 'e', undefined, 0);
    log.markFailed('m4', 'err', 1); // failed

    expect(log.list('pending').map((r) => r.id)).toEqual(['m1']);
    expect(log.pending().map((r) => r.id).sort()).toEqual(['m1', 'm2']);
    // replayable = everything not delivered
    expect(log.replayable().map((r) => r.id).sort()).toEqual(['m1', 'm2', 'm4']);
  });

  it('throws on transitioning an unknown id', () => {
    const log = new DispatchLog();
    expect(() => log.markNotified('nope')).toThrow(/Unknown dispatch/);
  });
});
