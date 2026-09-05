import { describe, expect, it } from 'vitest';

import {
  buildInterventionReceipts,
  reportInterventionReceipts,
  summariseReceipts,
} from './intervention-receipt';
import type { LeasedLoopPendingInput } from './loop-intervention-lease';

const NOW = 2_000_000;

function input(over: Partial<LeasedLoopPendingInput> = {}): LeasedLoopPendingInput {
  return {
    id: `i-${Math.random()}`,
    kind: 'steer',
    message: 'Focus on the failing test first',
    enqueuedAt: NOW - 30_000,
    source: 'human',
    ...over,
  } as LeasedLoopPendingInput;
}

describe('buildInterventionReceipts (B3)', () => {
  it('records a delivered intervention', () => {
    const [r] = buildInterventionReceipts({ leased: [input()], seq: 3, now: NOW });
    expect(r).toMatchObject({ fate: 'delivered', seq: 3, kind: 'steer', source: 'human' });
    expect(r!.waitedMs).toBe(30_000);
  });

  it('distinguishes held from dropped, which mean different things to the sender', () => {
    const receipts = buildInterventionReceipts({
      leased: [],
      sealed: [input()],
      dropped: [input()],
      seq: 1,
      now: NOW,
    });
    expect(receipts.map((r) => r.fate).sort()).toEqual(['dropped', 'held']);
  });

  it('carries a readable excerpt so a log line stands alone', () => {
    const [r] = buildInterventionReceipts({
      leased: [input({ message: '  Focus  on\nthe   test  ' })],
      seq: 1,
      now: NOW,
    });
    expect(r!.excerpt).toBe('Focus on the test');
  });

  it('clips a long message', () => {
    const [r] = buildInterventionReceipts({
      leased: [input({ message: 'm'.repeat(300) })],
      seq: 1,
      now: NOW,
    });
    expect(r!.excerpt.length).toBeLessThanOrEqual(80);
    expect(r!.excerpt.endsWith('…')).toBe(true);
  });

  it('never reports a negative wait when the clock disagrees', () => {
    const [r] = buildInterventionReceipts({
      leased: [input({ enqueuedAt: NOW + 5_000 })],
      seq: 1,
      now: NOW,
    });
    expect(r!.waitedMs).toBe(0);
  });

  it('returns nothing when no interventions were involved', () => {
    expect(buildInterventionReceipts({ leased: [], seq: 1, now: NOW })).toEqual([]);
  });
});

describe('summariseReceipts', () => {
  /** Plain delivery is the expected case; a line for it is noise. */
  it('stays silent when everything was simply delivered', () => {
    const receipts = buildInterventionReceipts({ leased: [input(), input()], seq: 1, now: NOW });
    const summary = summariseReceipts(receipts);
    expect(summary.delivered).toBe(2);
    expect(summary.line).toBeNull();
  });

  it('speaks up when something was held back', () => {
    const receipts = buildInterventionReceipts({
      leased: [input()], sealed: [input()], seq: 1, now: NOW,
    });
    expect(summariseReceipts(receipts).line).toContain('1 held back by the merge budget');
  });

  it('speaks up when something was dropped', () => {
    const receipts = buildInterventionReceipts({ leased: [], dropped: [input()], seq: 1, now: NOW });
    expect(summariseReceipts(receipts).line).toContain('dropped (queue full)');
  });

  /**
   * `released` is only a count upstream, so it is reported as a count rather
   * than dressed up as identified payloads.
   */
  it('reports returned leases from the count it actually has', () => {
    const summary = summariseReceipts([], 2);
    expect(summary.returned).toBe(2);
    expect(summary.line).toContain('2 returned from an unacked lease');
  });
});

describe('reportInterventionReceipts', () => {
  it('is silent for a plain delivery', () => {
    expect(reportInterventionReceipts({ leased: [input()], seq: 1, now: NOW }).line).toBeNull();
  });

  it('reports a dropped payload and a returned lease together', () => {
    const summary = reportInterventionReceipts({
      leased: [input()],
      dropped: [input()],
      releasedCount: 1,
      seq: 2,
      now: NOW,
    });
    expect(summary.line).toContain('dropped (queue full)');
    expect(summary.line).toContain('returned from an unacked lease');
    expect(summary.delivered).toBe(1);
  });

  it('handles an empty lease step without inventing a line', () => {
    expect(reportInterventionReceipts({ leased: [], seq: 1, now: NOW }).line).toBeNull();
  });
});
