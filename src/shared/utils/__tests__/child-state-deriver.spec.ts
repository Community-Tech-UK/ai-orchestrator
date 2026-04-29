import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STATUSES,
  FAILED_STATUSES,
  deriveChildState,
} from '../child-state-deriver';
import type { AgentTreeNode } from '../../types/agent-tree.types';

const NOW = 1_900_000_000_000;

function child(overrides: Partial<AgentTreeNode> = {}): Pick<AgentTreeNode, 'status' | 'statusTimeline' | 'lastActivityAt' | 'heartbeatAt'> {
  return {
    status: 'idle',
    statusTimeline: [{ status: 'idle', timestamp: NOW - 1_000 }],
    lastActivityAt: NOW - 1_000,
    ...overrides,
  };
}

describe('deriveChildState', () => {
  it('buckets failed status as failed', () => {
    const state = deriveChildState(child({ status: 'error' }), { now: NOW });
    expect(state.category).toBe('failed');
    expect(state.isFailed).toBe(true);
    expect(state.isActive).toBe(false);
  });

  it('buckets waiting_for_input as waiting', () => {
    const state = deriveChildState(child({ status: 'waiting_for_input' }), { now: NOW });
    expect(state.category).toBe('waiting');
    expect(state.isWaiting).toBe(true);
  });

  it('buckets active statuses as active', () => {
    for (const status of ACTIVE_STATUSES) {
      const state = deriveChildState(child({ status }), { now: NOW });
      expect(state.category).toBe('active');
      expect(state.isActive).toBe(true);
    }
  });

  it('buckets idle past stale threshold as stale', () => {
    const state = deriveChildState(
      child({ status: 'idle', lastActivityAt: NOW - 60_000 }),
      { now: NOW, staleThresholdMs: 30_000 },
    );
    expect(state.category).toBe('stale');
    expect(state.isStale).toBe(true);
  });

  it('keeps idle within threshold as idle', () => {
    const state = deriveChildState(
      child({ status: 'idle', lastActivityAt: NOW - 5_000 }),
      { now: NOW, staleThresholdMs: 30_000 },
    );
    expect(state.category).toBe('idle');
    expect(state.isStale).toBe(false);
  });

  it('failed wins over stale by priority order', () => {
    const state = deriveChildState(
      child({ status: 'error', lastActivityAt: NOW - 60_000 }),
      { now: NOW, staleThresholdMs: 30_000 },
    );
    expect(state.category).toBe('failed');
  });

  it('counts turns from the status timeline length', () => {
    const state = deriveChildState(child({
      statusTimeline: [
        { status: 'idle', timestamp: NOW - 5_000 },
        { status: 'busy', timestamp: NOW - 4_000 },
        { status: 'idle', timestamp: NOW - 3_000 },
      ],
    }), { now: NOW });
    expect(state.turnCount).toBe(3);
  });

  it('counts churn within the rolling window', () => {
    const state = deriveChildState(child({
      statusTimeline: [
        { status: 'idle', timestamp: NOW - 50_000 },
        { status: 'busy', timestamp: NOW - 40_000 },
        { status: 'idle', timestamp: NOW - 30_000 },
        { status: 'busy', timestamp: NOW - 20_000 },
        { status: 'idle', timestamp: NOW - 10_000 },
        { status: 'busy', timestamp: NOW - 70_000 },
      ],
    }), { now: NOW, churnWindowMs: 60_000, churnThreshold: 5 });
    expect(state.churnCount).toBe(5);
    expect(state.isChurning).toBe(true);
  });

  it('does not flag churn under threshold', () => {
    const state = deriveChildState(child({
      statusTimeline: [
        { status: 'idle', timestamp: NOW - 5_000 },
        { status: 'busy', timestamp: NOW - 4_000 },
      ],
    }), { now: NOW, churnThreshold: 5 });
    expect(state.isChurning).toBe(false);
  });

  it('clamps ageMs to non-negative when lastActivityAt is in the future', () => {
    const state = deriveChildState(child({ lastActivityAt: NOW + 5_000 }), { now: NOW });
    expect(state.ageMs).toBe(0);
  });

  it('echoes heartbeatAt and lastActivityAt for caller convenience', () => {
    const state = deriveChildState(
      child({ lastActivityAt: NOW - 1_000, heartbeatAt: NOW - 500 }),
      { now: NOW },
    );
    expect(state.lastActivityAt).toBe(NOW - 1_000);
    expect(state.heartbeatAt).toBe(NOW - 500);
  });

  it('FAILED_STATUSES includes core failure states', () => {
    expect(FAILED_STATUSES.has('error')).toBe(true);
    expect(FAILED_STATUSES.has('crashed')).toBe(true);
    expect(FAILED_STATUSES.has('failed')).toBe(true);
  });

  it('uses default thresholds when options are omitted', () => {
    const state = deriveChildState(
      child({ status: 'idle', lastActivityAt: NOW - 31_000 }),
      { now: NOW },
    );
    expect(state.category).toBe('stale');
  });
});
