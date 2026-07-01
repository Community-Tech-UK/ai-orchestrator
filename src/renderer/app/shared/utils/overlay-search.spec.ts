import { describe, expect, it } from 'vitest';
import { matchesOverlayQuery, scoreOverlayQuery } from './overlay-search';

describe('overlay-search', () => {
  it('matches subsequence queries across searchable fields', () => {
    expect(matchesOverlayQuery(['Review pull request', 'Run code review'], 'rvw pr')).toBe(true);
  });

  it('does not match out-of-order subsequences', () => {
    expect(matchesOverlayQuery(['Request Pull Git'], 'gpr')).toBe(false);
  });

  it('scores tighter field matches above scattered matches', () => {
    expect(scoreOverlayQuery(['review-pr'], 'rvw')).toBeGreaterThan(
      scoreOverlayQuery(['rexxvxxw-pr'], 'rvw'),
    );
  });
});
