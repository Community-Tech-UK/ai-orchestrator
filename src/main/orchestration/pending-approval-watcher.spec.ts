import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  startPendingApprovalWatcher,
  stopPendingApprovalWatcher,
  _resetForTesting,
} from './pending-approval-watcher';
import type { PendingApprovalLike } from './pending-approval-digest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let clock = 1_000_000;
const now = () => clock;

function blocked(ageMs: number): PendingApprovalLike {
  return {
    approvalId: 'a1',
    instanceId: 'inst-1',
    createdAt: clock - ageMs,
    expiresAt: clock + 3_600_000,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  clock = 1_000_000;
});

afterEach(() => {
  _resetForTesting();
  vi.useRealTimers();
});

describe('startPendingApprovalWatcher (N9)', () => {
  it('stays quiet when nothing is pending', () => {
    const onDigest = vi.fn();
    startPendingApprovalWatcher({ listPending: () => [], pollMs: 10, now, onDigest });
    vi.advanceTimersByTime(100);
    expect(onDigest).not.toHaveBeenCalled();
  });

  it('reports a session that has been blocked long enough', () => {
    const onDigest = vi.fn();
    startPendingApprovalWatcher({
      listPending: () => [blocked(10 * 60_000)], pollMs: 10, now, onDigest,
    });
    vi.advanceTimersByTime(50);
    expect(onDigest).toHaveBeenCalledTimes(1);
    expect(onDigest.mock.calls[0]![0]).toContain('1 session is blocked');
  });

  /** A reminder every five minutes is how an operator learns to ignore it. */
  it('does not repeat within the reminder window', () => {
    const onDigest = vi.fn();
    startPendingApprovalWatcher({
      listPending: () => [blocked(10 * 60_000)],
      pollMs: 10, remindEveryMs: 1_000, now, onDigest,
    });
    vi.advanceTimersByTime(500);
    expect(onDigest).toHaveBeenCalledTimes(1);
  });

  it('reminds again after the window passes', () => {
    const onDigest = vi.fn();
    startPendingApprovalWatcher({
      listPending: () => [blocked(10 * 60_000)],
      pollMs: 10, remindEveryMs: 100, now, onDigest,
    });
    vi.advanceTimersByTime(30);
    clock += 200;
    vi.advanceTimersByTime(30);
    expect(onDigest).toHaveBeenCalledTimes(2);
  });

  /**
   * Re-arm on an empty queue: otherwise a block that clears and returns inside
   * the reminder window is swallowed, which is the case an operator most needs.
   */
  it('re-arms once the queue clears', () => {
    let pending: PendingApprovalLike[] = [blocked(10 * 60_000)];
    const onDigest = vi.fn();
    startPendingApprovalWatcher({
      listPending: () => pending, pollMs: 10, remindEveryMs: 10_000, now, onDigest,
    });
    vi.advanceTimersByTime(30);
    expect(onDigest).toHaveBeenCalledTimes(1);

    pending = [];
    vi.advanceTimersByTime(30);
    pending = [blocked(10 * 60_000)];
    vi.advanceTimersByTime(30);
    expect(onDigest).toHaveBeenCalledTimes(2);
  });

  it('survives a listing failure rather than killing the watcher', () => {
    const onDigest = vi.fn();
    let shouldThrow = true;
    startPendingApprovalWatcher({
      listPending: () => {
        if (shouldThrow) throw new Error('db locked');
        return [blocked(10 * 60_000)];
      },
      pollMs: 10, now, onDigest,
    });
    vi.advanceTimersByTime(30);
    expect(onDigest).not.toHaveBeenCalled();
    shouldThrow = false;
    vi.advanceTimersByTime(30);
    expect(onDigest).toHaveBeenCalledTimes(1);
  });

  it('stops cleanly', () => {
    const onDigest = vi.fn();
    startPendingApprovalWatcher({
      listPending: () => [blocked(10 * 60_000)], pollMs: 10, now, onDigest,
    });
    stopPendingApprovalWatcher();
    vi.advanceTimersByTime(200);
    expect(onDigest).not.toHaveBeenCalled();
  });
});
