/**
 * The summariser is shared by main (which builds a recap from the loop store)
 * and the renderer (which merges a later recap into one still on screen), so
 * these pin the behaviour both depend on — particularly that merging never
 * loses a card, which is the defect `mergeAwayRecaps` exists to prevent.
 */
import { describe, expect, it } from 'vitest';

import {
  mergeAwayRecaps,
  summariseAwayCards,
  type AwayRunCard,
} from './away-recap-summary';

function card(over: Partial<AwayRunCard> & { runId: string }): AwayRunCard {
  return {
    goal: 'A goal',
    outcome: 'finished',
    status: 'completed',
    iterations: 1,
    durationMs: 100,
    costCents: 10,
    outstandingCount: 0,
    endReason: null,
    ...over,
  };
}

describe('summariseAwayCards', () => {
  it('returns null for an empty set rather than a "0 loop runs ended" sentence', () => {
    expect(summariseAwayCards([])).toBeNull();
  });

  it('orders by how much each run wants a person, then by duration', () => {
    const recap = summariseAwayCards([
      card({ runId: 'a', outcome: 'finished' }),
      card({ runId: 'b', outcome: 'needs-you' }),
      card({ runId: 'c', outcome: 'stopped-short' }),
    ]);
    expect(recap?.cards.map((c) => c.runId)).toEqual(['b', 'c', 'a']);
  });

  it('leads the headline with what needs a person', () => {
    const recap = summariseAwayCards([
      card({ runId: 'a', outcome: 'finished' }),
      card({ runId: 'b', outcome: 'finished' }),
      card({ runId: 'c', outcome: 'needs-you' }),
    ]);
    expect(recap?.headline).toBe('3 loop runs ended: 1 needs you, 2 finished.');
  });

  it('does not mutate the caller’s array', () => {
    const input = [card({ runId: 'a', outcome: 'finished' }), card({ runId: 'b', outcome: 'needs-you' })];
    summariseAwayCards(input);
    expect(input.map((c) => c.runId)).toEqual(['a', 'b']);
  });

  it('totals cost across the cards', () => {
    expect(summariseAwayCards([
      card({ runId: 'a', costCents: 25 }),
      card({ runId: 'b', costCents: 5 }),
    ])?.totalCostCents).toBe(30);
  });
});

describe('mergeAwayRecaps', () => {
  const first = summariseAwayCards([card({ runId: 'a', outcome: 'needs-you' })]);
  const second = summariseAwayCards([card({ runId: 'b', outcome: 'finished' })]);

  it('keeps both sets of cards', () => {
    const merged = mergeAwayRecaps(first, second);
    expect(merged?.cards.map((c) => c.runId)).toEqual(['a', 'b']);
    expect(merged?.headline).toBe('2 loop runs ended: 1 needs you, 1 finished.');
  });

  it('never lets a later, less urgent recap displace an unread one', () => {
    // The exact failure: `needs-you` shown, `finished` arrives, and the boundary
    // has already moved past the first run so it can never be re-queried.
    const merged = mergeAwayRecaps(first, second);
    expect(merged?.needsYou).toBe(1);
    expect(merged?.cards[0]?.runId).toBe('a');
  });

  it('de-duplicates by runId, keeping the copy already on screen', () => {
    const again = summariseAwayCards([card({ runId: 'a', outcome: 'needs-you', goal: 'Rewritten' })]);
    const merged = mergeAwayRecaps(first, again);
    expect(merged?.cards).toHaveLength(1);
    expect(merged?.cards[0]?.goal).toBe('A goal');
  });

  it('passes either side through when the other is null', () => {
    expect(mergeAwayRecaps(null, second)).toBe(second);
    expect(mergeAwayRecaps(first, null)).toBe(first);
    expect(mergeAwayRecaps(null, null)).toBeNull();
  });
});
