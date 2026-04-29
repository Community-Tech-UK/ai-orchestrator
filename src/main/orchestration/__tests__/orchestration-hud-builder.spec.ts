import { describe, expect, it } from 'vitest';
import { buildHudSnapshot, type HudChildInput } from '../orchestration-hud-builder';

const NOW = 1_900_000_000_000;

function child(overrides: Partial<HudChildInput>): HudChildInput {
  const instanceId = overrides.instanceId ?? 'child-1';
  return {
    instanceId,
    displayName: instanceId,
    status: 'idle',
    lastActivityAt: NOW - 1_000,
    statusTimeline: [{ status: 'idle', timestamp: NOW - 1_000 }],
    ...overrides,
  };
}

describe('buildHudSnapshot', () => {
  it('returns an empty snapshot for no children', () => {
    const snapshot = buildHudSnapshot('parent-1', [], { now: NOW });
    expect(snapshot.totalChildren).toBe(0);
    expect(snapshot.countsByCategory).toEqual({
      failed: 0,
      waiting: 0,
      active: 0,
      stale: 0,
      idle: 0,
    });
    expect(snapshot.attentionItems).toEqual([]);
  });

  it('orders failed, waiting, active, stale, then idle children', () => {
    const snapshot = buildHudSnapshot('parent-1', [
      child({ instanceId: 'idle', status: 'idle', lastActivityAt: NOW - 1_000 }),
      child({ instanceId: 'failed', status: 'failed' }),
      child({ instanceId: 'active', status: 'busy' }),
      child({ instanceId: 'waiting', status: 'waiting_for_input' }),
      child({ instanceId: 'stale', status: 'idle', lastActivityAt: NOW - 60_000 }),
    ], { now: NOW, staleThresholdMs: 30_000 });

    expect(snapshot.children.map((entry) => entry.instanceId)).toEqual([
      'failed',
      'waiting',
      'active',
      'stale',
      'idle',
    ]);
  });

  it('counts every category and sums to totalChildren', () => {
    const snapshot = buildHudSnapshot('parent-1', [
      child({ instanceId: 'failed', status: 'error' }),
      child({ instanceId: 'waiting', status: 'waiting_for_permission' }),
      child({ instanceId: 'active', status: 'busy' }),
      child({ instanceId: 'stale', status: 'idle', lastActivityAt: NOW - 60_000 }),
      child({ instanceId: 'idle', status: 'idle', lastActivityAt: NOW - 1_000 }),
    ], { now: NOW });

    expect(snapshot.countsByCategory).toEqual({
      failed: 1,
      waiting: 1,
      active: 1,
      stale: 1,
      idle: 1,
    });
    expect(Object.values(snapshot.countsByCategory).reduce((sum, count) => sum + count, 0)).toBe(snapshot.totalChildren);
  });

  it('includes failed, waiting, and churning entries as attention items', () => {
    const churning = child({
      instanceId: 'churning',
      status: 'busy',
      statusTimeline: [
        { status: 'idle', timestamp: NOW - 50_000 },
        { status: 'busy', timestamp: NOW - 40_000 },
        { status: 'idle', timestamp: NOW - 30_000 },
        { status: 'busy', timestamp: NOW - 20_000 },
        { status: 'idle', timestamp: NOW - 10_000 },
      ],
    });

    const snapshot = buildHudSnapshot('parent-1', [
      child({ instanceId: 'idle', status: 'idle' }),
      child({ instanceId: 'failed', status: 'failed' }),
      child({ instanceId: 'waiting', status: 'waiting_for_input' }),
      churning,
    ], { now: NOW, churnThreshold: 5 });

    expect(snapshot.churningCount).toBe(1);
    expect(snapshot.attentionItems.map((entry) => entry.instanceId)).toEqual([
      'failed',
      'waiting',
      'churning',
    ]);
  });
});
