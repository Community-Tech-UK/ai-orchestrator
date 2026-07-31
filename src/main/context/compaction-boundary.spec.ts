import { describe, expect, it } from 'vitest';
import {
  computeCompactionCut,
  exchangesToMessageBoundary,
  groupExchanges,
  messageBoundaryToExchangeCount,
  type CompactionTurnRole,
} from './compaction-boundary';

function turns(roles: ('user' | 'assistant')[]): CompactionTurnRole[] {
  return roles.map((role) => ({ role }));
}

describe('groupExchanges', () => {
  it('groups a user turn plus its following assistant turns into one exchange', () => {
    const exchanges = groupExchanges(turns(['user', 'assistant', 'assistant', 'user', 'assistant']));
    expect(exchanges).toEqual([
      { startIndex: 0, endIndex: 2, messageCount: 3 },
      { startIndex: 3, endIndex: 4, messageCount: 2 },
    ]);
  });

  it('returns an empty array for an empty transcript', () => {
    expect(groupExchanges([])).toEqual([]);
  });

  it('treats a leading assistant-only run as its own exchange (defensive)', () => {
    const exchanges = groupExchanges(turns(['assistant', 'user']));
    expect(exchanges).toEqual([
      { startIndex: 0, endIndex: 0, messageCount: 1 },
      { startIndex: 1, endIndex: 1, messageCount: 1 },
    ]);
  });
});

describe('exchangesToMessageBoundary', () => {
  const exchanges = groupExchanges(turns(['user', 'assistant', 'user', 'assistant', 'assistant', 'user', 'assistant']));
  // exchanges: [0-1] (2 msgs), [2-4] (3 msgs), [5-6] (2 msgs) = 7 total

  it('sums the trailing N exchanges', () => {
    expect(exchangesToMessageBoundary(exchanges, 1)).toBe(2); // last exchange only
    expect(exchangesToMessageBoundary(exchanges, 2)).toBe(5); // last two exchanges
  });

  it('clamps N above the exchange count to the full transcript', () => {
    expect(exchangesToMessageBoundary(exchanges, 999)).toBe(7);
  });

  it('returns 0 for N=0', () => {
    expect(exchangesToMessageBoundary(exchanges, 0)).toBe(0);
  });

  it('returns 0 for an empty exchange list regardless of N', () => {
    expect(exchangesToMessageBoundary([], 5)).toBe(0);
  });
});

describe('messageBoundaryToExchangeCount', () => {
  const exchanges = groupExchanges(turns(['user', 'assistant', 'user', 'assistant', 'assistant', 'user', 'assistant']));

  it('counts how many trailing exchanges cover at least the message boundary', () => {
    expect(messageBoundaryToExchangeCount(exchanges, 1)).toBe(1); // partial last exchange still counts as 1
    expect(messageBoundaryToExchangeCount(exchanges, 2)).toBe(1); // exactly the last exchange
    expect(messageBoundaryToExchangeCount(exchanges, 3)).toBe(2); // spills into the middle exchange
  });

  it('returns 0 for a zero or negative boundary', () => {
    expect(messageBoundaryToExchangeCount(exchanges, 0)).toBe(0);
    expect(messageBoundaryToExchangeCount(exchanges, -3)).toBe(0);
  });
});

describe('computeCompactionCut', () => {
  it('returns nothing affected/kept for an empty transcript', () => {
    expect(computeCompactionCut([], 5)).toEqual({
      affectedIndices: [],
      keptIndices: [],
      rescuedLastUserTurnIndex: null,
    });
  });

  it('keeps the trailing preserveRecentMessages turns verbatim, modulo the last-user-turn rescue', () => {
    const t = turns(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    const cut = computeCompactionCut(t, 2);
    // cutIndex=4 keeps [4,5] naturally, but the rescue rule scans the
    // affected range [0..3] for its own rightmost user turn (index 2 — the
    // opening turn of the second cut exchange) and pulls it out too, since
    // the rule protects "the most recent user ask about to be cut", not
    // just "the globally most recent user turn".
    expect(cut.affectedIndices).toEqual([0, 1, 3]);
    expect(cut.keptIndices).toEqual([2, 4, 5]);
    expect(cut.rescuedLastUserTurnIndex).toBe(2);
  });

  it('N=0 still protects the single most recent user turn', () => {
    const t = turns(['user', 'assistant', 'user', 'assistant']);
    const cut = computeCompactionCut(t, 0);
    // Everything else is affected, but index 2 (last user turn) is rescued.
    expect(cut.affectedIndices).toEqual([0, 1, 3]);
    expect(cut.keptIndices).toEqual([2]);
    expect(cut.rescuedLastUserTurnIndex).toBe(2);
  });

  it('N >= total keeps everything verbatim (nothing affected)', () => {
    const t = turns(['user', 'assistant', 'user', 'assistant']);
    const cut = computeCompactionCut(t, 999);
    expect(cut.affectedIndices).toEqual([]);
    expect(cut.keptIndices).toEqual([0, 1, 2, 3]);
    expect(cut.rescuedLastUserTurnIndex).toBeNull();
  });

  it('rescues the most recent user turn out of the affected range when it would otherwise be cut', () => {
    // preserveRecentMessages=1 keeps only the trailing assistant turn verbatim;
    // the user turn right before it would be cut without the rescue rule.
    const t = turns(['user', 'assistant', 'user', 'assistant']);
    const cut = computeCompactionCut(t, 1);
    expect(cut.affectedIndices).toEqual([0, 1]);
    expect(cut.keptIndices).toEqual([2, 3]);
    expect(cut.rescuedLastUserTurnIndex).toBe(2);
  });

  it('finds no user turn to rescue when the affected range is all-assistant (defensive)', () => {
    const t = turns(['assistant', 'assistant', 'user']);
    const cut = computeCompactionCut(t, 1);
    // preserveRecentMessages=1 keeps index 2 (the user turn) verbatim already;
    // nothing user-role remains in the affected [0,1] range to rescue.
    expect(cut.affectedIndices).toEqual([0, 1]);
    expect(cut.keptIndices).toEqual([2]);
    expect(cut.rescuedLastUserTurnIndex).toBeNull();
  });

  it('clamps a negative or non-finite preserveRecentMessages to 0', () => {
    const t = turns(['user', 'assistant']);
    expect(computeCompactionCut(t, -5)).toEqual(computeCompactionCut(t, 0));
    expect(computeCompactionCut(t, Number.NaN)).toEqual(computeCompactionCut(t, 0));
  });
});
