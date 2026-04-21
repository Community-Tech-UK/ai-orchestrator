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
