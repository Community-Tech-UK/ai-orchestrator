import { describe, expect, it } from 'vitest';

import { pendingApprovalDigest, type PendingApprovalLike } from './pending-approval-digest';

const NOW = 1_000_000_000;
const MIN_AGE = 5 * 60_000;

function approval(over: Partial<PendingApprovalLike> = {}): PendingApprovalLike {
  return {
    approvalId: `a-${Math.random()}`,
    instanceId: 'inst-1',
    createdAt: NOW - 10 * 60_000,
    expiresAt: NOW + 60 * 60_000,
    ...over,
  };
}

describe('pendingApprovalDigest (N9)', () => {
  it('says nothing when nothing is pending', () => {
    expect(pendingApprovalDigest({ pending: [], now: NOW, minAgeMs: MIN_AGE })).toBeNull();
  });

  it('stays quiet until something has actually been waiting', () => {
    const fresh = approval({ createdAt: NOW - 30_000 });
    expect(pendingApprovalDigest({ pending: [fresh], now: NOW, minAgeMs: MIN_AGE })).toBeNull();
  });

  /**
   * An expired approval is no longer waiting on a human. Counting it would
   * inflate the number the operator is asked to act on.
   */
  it('excludes expired approvals from the count', () => {
    const digest = pendingApprovalDigest({
      pending: [approval(), approval({ expiresAt: NOW - 1 })],
      now: NOW,
      minAgeMs: MIN_AGE,
    });
    expect(digest?.approvals).toBe(1);
  });

  it('returns null when every pending approval has expired', () => {
    const digest = pendingApprovalDigest({
      pending: [approval({ expiresAt: NOW - 1 })],
      now: NOW,
      minAgeMs: MIN_AGE,
    });
    expect(digest).toBeNull();
  });

  /** Five blocked sessions should be one line saying five, not five lines. */
  it('aggregates across instances', () => {
    const digest = pendingApprovalDigest({
      pending: [
        approval({ instanceId: 'a' }),
        approval({ instanceId: 'b' }),
        approval({ instanceId: 'b' }),
      ],
      now: NOW,
      minAgeMs: MIN_AGE,
    });
    expect(digest?.instances).toBe(2);
    expect(digest?.approvals).toBe(3);
    expect(digest?.body).toContain('2 sessions are blocked on 3 approvals');
  });

  it('gets the singulars right for one approval on one session', () => {
    const digest = pendingApprovalDigest({ pending: [approval()], now: NOW, minAgeMs: MIN_AGE });
    expect(digest?.body).toContain('1 session is blocked on 1 approval.');
  });

  it('reports the age of the oldest, not the newest', () => {
    const digest = pendingApprovalDigest({
      pending: [approval({ createdAt: NOW - 10 * 60_000 }), approval({ createdAt: NOW - 90 * 60_000 })],
      now: NOW,
      minAgeMs: MIN_AGE,
    });
    expect(digest?.body).toContain('1 hour');
  });

  it('reads sensibly for a long wait', () => {
    const digest = pendingApprovalDigest({
      pending: [approval({ createdAt: NOW - 5 * 60 * 60_000 })],
      now: NOW,
      minAgeMs: MIN_AGE,
    });
    expect(digest?.body).toContain('5 hours');
  });
});
