import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import { InstanceStateManager } from '../instance/instance-state';
import { pendingApprovalDigest, type PendingApprovalLike } from './pending-approval-digest';
import {
  liveWaitingAsApprovals,
  mergePendingAndLiveApprovals,
  type LiveWaitingInstance,
} from './live-waiting-approvals';

const NOW = 1_000_000;
const WAIT_STARTED = NOW - 600_000;
function session(overrides: Partial<LiveWaitingInstance> = {}): LiveWaitingInstance {
  return { id: 'claude-question', status: 'waiting_for_input', yoloMode: false,
    parentId: null, waitingSince: WAIT_STARTED, ...overrides };
}
function durable(overrides: Partial<PendingApprovalLike> = {}): PendingApprovalLike {
  return { approvalId: 'durable', instanceId: 'claude-question', createdAt: WAIT_STARTED,
    expiresAt: NOW + 60_000, ...overrides };
}

afterEach(() => vi.useRealTimers());

describe('liveWaitingAsApprovals', () => {
  it.each(['waiting_for_input', 'waiting_for_permission'] as const)('maps %s to an approval from the original wait time', (status) => {
    expect(liveWaitingAsApprovals([session({ status })], NOW)).toEqual([{
      approvalId: 'live:claude-question', instanceId: 'claude-question',
      createdAt: WAIT_STARTED, expiresAt: NOW + 24 * 60 * 60_000,
    }]);
  });

  it('excludes YOLO, completed and machine-wait sessions', () => {
    expect(liveWaitingAsApprovals([
      session({ yoloMode: true }), session({ status: 'idle' }),
      session({ waitReason: { kind: 'backoff', attempt: 1, retryAt: NOW + 1000 } }),
    ], NOW)).toEqual([]);
  });

  it.each([
    { parentId: 'parent' }, { metadata: { pingPongReviewer: true } },
    { metadata: { planQueueRunId: 'queue' } }, { metadata: { planQueueRole: 'worker' } },
    { metadata: { automationId: 'automation' } }, { metadata: { spawnParentInstanceId: 'parent' } },
    ...['plan-queue', 'automation', 'repo-job', 'remote-node'].map((spendPurpose) => ({ metadata: { spendPurpose } })),
  ])('excludes a machine-started session carrying %j', (overrides) => {
    expect(liveWaitingAsApprovals([session(overrides)], NOW)).toEqual([]);
  });

  it('retains human-started channel sessions and never invents an unknown wait age', () => {
    expect(liveWaitingAsApprovals([session({ metadata: { spendPurpose: 'channel' } })], NOW)).toHaveLength(1);
    expect(liveWaitingAsApprovals([session({ waitingSince: undefined })], NOW)).toEqual([]);
    expect(liveWaitingAsApprovals([session({ waitingSince: Number.NaN })], NOW)).toEqual([]);
    expect(liveWaitingAsApprovals([session({ waitingSince: NOW + 1 })], NOW)).toEqual([]);
  });
});

describe('mergePendingAndLiveApprovals', () => {
  it('counts each session once and retains its oldest unexpired wait', () => {
    const input = session();
    const merged = mergePendingAndLiveApprovals([
      durable({ createdAt: NOW - 2000 }), durable({ approvalId: 'older', createdAt: NOW - 4000 }),
      durable({ approvalId: 'expired', createdAt: 1, expiresAt: NOW }),
    ], [input], NOW);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.createdAt).toBe(NOW - 4000);
    expect(pendingApprovalDigest({ pending: merged, now: NOW, minAgeMs: 0 })?.approvals).toBe(1);
  });

  it('a durable row that has expired does not hide the live wait', () => {
    expect(mergePendingAndLiveApprovals([durable({ expiresAt: NOW })], [session()], NOW))
      .toMatchObject([{ approvalId: 'live:claude-question', createdAt: NOW }]);
  });

  it('starts conservatively at first observation, independent of lastActivity', () => {
    const input = session();
    const first = mergePendingAndLiveApprovals([], [input], NOW);
    const later = mergePendingAndLiveApprovals([], [input], NOW + 600_000);
    expect(first[0]?.createdAt).toBe(NOW);
    expect(later[0]?.createdAt).toBe(NOW);
    expect(pendingApprovalDigest({ pending: later, now: NOW + 600_000, minAgeMs: 300_000 })?.oldestAgeMs)
      .toBe(600_000);
  });

  it('excludes sessions owned by a live loop', () => {
    expect(mergePendingAndLiveApprovals([], [session()], NOW, () => true)).toEqual([]);
  });

  it('timestamps state transitions before the banner or reminder first polls', () => {
    vi.useFakeTimers();
    vi.setSystemTime(WAIT_STARTED);
    const state = new InstanceStateManager();
    const input = { ...session({ waitingSince: undefined }), lastActivity: WAIT_STARTED } as Instance;
    state.setInstance(input);
    state.queueUpdate(input.id, 'waiting_for_input');

    vi.setSystemTime(NOW);
    input.lastActivity = NOW;
    state.queueUpdate(input.id, 'waiting_for_input');
    expect(mergePendingAndLiveApprovals([], state.getAllInstances(), NOW)[0]?.createdAt).toBe(WAIT_STARTED);

    input.status = 'busy';
    state.queueUpdate(input.id, 'busy');
    vi.setSystemTime(NOW + 1000);
    input.status = 'waiting_for_permission';
    state.queueUpdate(input.id, input.status);
    input.status = 'waiting_for_input';
    state.queueUpdate(input.id, input.status);
    expect(mergePendingAndLiveApprovals([], state.getAllInstances(), NOW + 2000)[0]?.createdAt).toBe(NOW + 1000);
    state.destroy();
  });

  it('does not reuse a removed instance object clock for a replacement with the same id', () => {
    const original = session();
    mergePendingAndLiveApprovals([], [original], NOW);
    expect(mergePendingAndLiveApprovals([], [session()], NOW + 10_000)[0]?.createdAt).toBe(NOW + 10_000);
  });
});
