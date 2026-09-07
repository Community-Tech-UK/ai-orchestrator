/**
 * B7 — parking is small, and every interesting case is a way the flag can go
 * wrong rather than a way it goes right. The self-heal is the one that matters:
 * a park flag can outlive its queue, and a stale flag silently strands the next
 * message the user ever queues for that instance.
 */
import { describe, expect, it } from 'vitest';

import {
  createQueuePark,
  createQueueParkState,
  isDrainBlockedByPark,
  isQueueParked,
  parkQueueOnInterrupt,
  unparkQueue,
} from './instance-queue-park';

describe('parkQueueOnInterrupt', () => {
  it('parks an instance that has queued messages', () => {
    const state = parkQueueOnInterrupt(createQueueParkState(), 'i1', 2);
    expect(isQueueParked(state, 'i1')).toBe(true);
  });

  it('does nothing when the queue is empty — there is nothing to hold back', () => {
    // Parking here would strand the NEXT message queued, which the user never
    // asked to hold.
    const state = parkQueueOnInterrupt(createQueueParkState(), 'i1', 0);
    expect(isQueueParked(state, 'i1')).toBe(false);
  });

  it('parks only the instance that was stopped', () => {
    const state = parkQueueOnInterrupt(createQueueParkState(), 'i1', 1);
    expect(isQueueParked(state, 'i2')).toBe(false);
  });

  it('returns the same state when already parked, so no needless update fires', () => {
    const first = parkQueueOnInterrupt(createQueueParkState(), 'i1', 1);
    expect(parkQueueOnInterrupt(first, 'i1', 1)).toBe(first);
  });
});

describe('unparkQueue', () => {
  it('releases the queue', () => {
    const state = unparkQueue(parkQueueOnInterrupt(createQueueParkState(), 'i1', 1), 'i1');
    expect(isQueueParked(state, 'i1')).toBe(false);
  });

  it('returns the same state when it was not parked', () => {
    const state = createQueueParkState();
    expect(unparkQueue(state, 'i1')).toBe(state);
  });
});

describe('isDrainBlockedByPark', () => {
  it('does not block an instance that was never parked', () => {
    expect(isDrainBlockedByPark(createQueueParkState(), 'i1', 3).blocked).toBe(false);
  });

  it('blocks a parked instance that still has messages', () => {
    const parked = parkQueueOnInterrupt(createQueueParkState(), 'i1', 2);
    expect(isDrainBlockedByPark(parked, 'i1', 2).blocked).toBe(true);
  });

  /**
   * The stale-flag bug this exists to prevent: cancel every parked message one
   * at a time and the queue empties without ever passing through the
   * clear-queue unpark hook. The flag would survive and silently hold the next
   * message queued for this instance, forever.
   */
  it('clears a stale flag when the queue has emptied behind it', () => {
    const parked = parkQueueOnInterrupt(createQueueParkState(), 'i1', 2);
    const check = isDrainBlockedByPark(parked, 'i1', 0);
    expect(check.blocked).toBe(false);
    expect(isQueueParked(check.state, 'i1')).toBe(false);
  });

  it('having self-healed, does not block a later queue', () => {
    const parked = parkQueueOnInterrupt(createQueueParkState(), 'i1', 2);
    const healed = isDrainBlockedByPark(parked, 'i1', 0).state;
    expect(isDrainBlockedByPark(healed, 'i1', 1).blocked).toBe(false);
  });

  it('leaves other instances’ park state alone while healing one', () => {
    let state = parkQueueOnInterrupt(createQueueParkState(), 'i1', 1);
    state = parkQueueOnInterrupt(state, 'i2', 1);
    const healed = isDrainBlockedByPark(state, 'i1', 0).state;
    expect(isQueueParked(healed, 'i2')).toBe(true);
  });
});

describe('createQueuePark', () => {
  it('parks, reports and releases through the signal', () => {
    const park = createQueuePark();
    expect(park.isParked('i1')).toBe(false);
    park.park('i1', 2);
    expect(park.isParked('i1')).toBe(true);
    park.unpark('i1');
    expect(park.isParked('i1')).toBe(false);
  });

  it('blocks a drain while messages are held', () => {
    const park = createQueuePark();
    park.park('i1', 1);
    expect(park.blocksDrain('i1', 1)).toBe(true);
  });

  it('self-heals when asked about an empty queue', () => {
    const park = createQueuePark();
    park.park('i1', 1);
    expect(park.blocksDrain('i1', 0)).toBe(false);
    expect(park.isParked('i1')).toBe(false);
  });
});
