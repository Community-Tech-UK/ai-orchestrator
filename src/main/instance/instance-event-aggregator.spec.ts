import { describe, expect, it } from 'vitest';
import { InstanceEventAggregator } from './instance-event-aggregator';

describe('InstanceEventAggregator', () => {
  it('emits monotonic per-instance sequences across lifecycle events', () => {
    const aggregator = new InstanceEventAggregator();

    const created = aggregator.recordCreated({
      id: 'inst-1',
      status: 'initializing',
      provider: 'claude',
      parentId: null,
      workingDirectory: '/tmp/project',
    });
    const updated = aggregator.recordStateUpdate({
      instanceId: 'inst-1',
      previousStatus: 'initializing',
      status: 'idle',
      timestamp: 123,
    });
    const removed = aggregator.recordRemoved('inst-1', 'terminated');

    expect(created.seq).toBe(0);
    expect(updated.seq).toBe(1);
    expect(removed.seq).toBe(2);
    expect(updated.event).toMatchObject({
      kind: 'status_changed',
      previousStatus: 'initializing',
      status: 'idle',
    });
  });

  it('classifies startup and runtime failures', () => {
    const aggregator = new InstanceEventAggregator();

    const startupFailure = aggregator.recordStateUpdate({
      instanceId: 'inst-1',
      previousStatus: 'initializing',
      status: 'failed',
      timestamp: 1,
    });
    const runtimeFailure = aggregator.recordStateUpdate({
      instanceId: 'inst-2',
      previousStatus: 'busy',
      status: 'error',
      timestamp: 2,
    });

    expect(startupFailure.event).toMatchObject({
      kind: 'status_changed',
      failureClass: 'startup',
    });
    expect(runtimeFailure.event).toMatchObject({
      kind: 'status_changed',
      failureClass: 'runtime',
    });
  });

  it('resets sequence tracking after removal', () => {
    const aggregator = new InstanceEventAggregator();

    aggregator.recordCreated({
      id: 'inst-1',
      status: 'initializing',
      provider: 'claude',
      parentId: null,
      workingDirectory: '/tmp/project',
    });
    aggregator.recordRemoved('inst-1', 'terminated');

    const recreated = aggregator.recordCreated({
      id: 'inst-1',
      status: 'initializing',
      provider: 'claude',
      parentId: null,
      workingDirectory: '/tmp/project',
    });

    expect(recreated.seq).toBe(0);
  });
});

describe('InstanceEventAggregator retained log (A8)', () => {
  const create = (aggregator: InstanceEventAggregator, id: string) =>
    aggregator.recordCreated({
      id,
      status: 'initializing',
      provider: 'claude',
      parentId: null,
      workingDirectory: '/tmp/project',
    });

  it('retains lifecycle events in chronological order, queryable by id', () => {
    const aggregator = new InstanceEventAggregator();
    create(aggregator, 'inst-1');
    aggregator.recordStateUpdate({
      instanceId: 'inst-1',
      previousStatus: 'initializing',
      status: 'idle',
      timestamp: 10,
    });
    aggregator.recordRemoved('inst-1', 'terminated');

    const events = aggregator.getEvents('inst-1');
    expect(events.map((e) => e.event.kind)).toEqual(['created', 'status_changed', 'removed']);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(aggregator.getEventCount('inst-1')).toBe(3);
    expect(aggregator.getLatestEvent('inst-1')?.event.kind).toBe('removed');
  });

  it('returns [] for an unknown instance', () => {
    const aggregator = new InstanceEventAggregator();
    expect(aggregator.getEvents('nope')).toEqual([]);
    expect(aggregator.getLatestEvent('nope')).toBeUndefined();
    expect(aggregator.getEventCount('nope')).toBe(0);
  });

  it('filters by afterSeq (resume) and caps with limit', () => {
    const aggregator = new InstanceEventAggregator();
    create(aggregator, 'inst-1');
    for (let i = 0; i < 4; i++) {
      aggregator.recordStateUpdate({
        instanceId: 'inst-1',
        previousStatus: 'idle',
        status: 'busy',
        timestamp: i,
      });
    }
    // seqs are 0 (created) + 1..4 (updates)
    expect(aggregator.getEvents('inst-1', { afterSeq: 2 }).map((e) => e.seq)).toEqual([3, 4]);
    expect(aggregator.getEvents('inst-1', { limit: 2 }).map((e) => e.seq)).toEqual([3, 4]);
    expect(aggregator.getEvents('inst-1', { afterSeq: 4 })).toEqual([]);
  });

  it('does not leak mutations back into the retained buffer', () => {
    const aggregator = new InstanceEventAggregator();
    create(aggregator, 'inst-1');
    const snapshot = aggregator.getEvents('inst-1');
    snapshot.pop();
    expect(aggregator.getEventCount('inst-1')).toBe(1);
  });

  it('starts a fresh window when a removed id is recreated', () => {
    const aggregator = new InstanceEventAggregator();
    create(aggregator, 'inst-1');
    aggregator.recordRemoved('inst-1', 'terminated');
    create(aggregator, 'inst-1');

    const events = aggregator.getEvents('inst-1');
    expect(events.map((e) => e.event.kind)).toEqual(['created']);
    expect(events[0].seq).toBe(0);
  });

  it('bounds the per-instance window to the most recent events', () => {
    const aggregator = new InstanceEventAggregator(3, 128);
    create(aggregator, 'inst-1');
    for (let i = 0; i < 5; i++) {
      aggregator.recordStateUpdate({
        instanceId: 'inst-1',
        previousStatus: 'idle',
        status: 'busy',
        timestamp: i,
      });
    }
    const events = aggregator.getEvents('inst-1');
    expect(events).toHaveLength(3);
    // The most recent three seqs are retained; the oldest were dropped.
    expect(events.map((e) => e.seq)).toEqual([3, 4, 5]);
  });

  it('evicts the least-recently-updated instance past the global cap', () => {
    const aggregator = new InstanceEventAggregator(500, 2);
    create(aggregator, 'inst-1');
    create(aggregator, 'inst-2');
    // Touch inst-1 so inst-2 becomes least-recently-updated.
    aggregator.recordStateUpdate({
      instanceId: 'inst-1',
      previousStatus: 'initializing',
      status: 'idle',
      timestamp: 1,
    });
    // Third instance exceeds the cap of 2 → the LRU (inst-2) is evicted.
    create(aggregator, 'inst-3');

    expect(aggregator.getTrackedInstances().sort()).toEqual(['inst-1', 'inst-3']);
    expect(aggregator.getEvents('inst-2')).toEqual([]);
  });

  it('pruneInstance drops a retained log', () => {
    const aggregator = new InstanceEventAggregator();
    create(aggregator, 'inst-1');
    aggregator.pruneInstance('inst-1');
    expect(aggregator.getEvents('inst-1')).toEqual([]);
    expect(aggregator.getTrackedInstances()).toEqual([]);
  });
});
