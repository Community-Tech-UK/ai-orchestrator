import { describe, expect, it } from 'vitest';
import { fuzzyMatch, fuzzyRank } from './fuzzy';

describe('fuzzyMatch', () => {
  it('treats whitespace-only queries as empty', () => {
    expect(fuzzyMatch('   ', 'anything')).toEqual({
      matched: true,
      score: 1000,
      positions: [],
    });
  });

  it('matches exact text with the strongest score and positions', () => {
    const exact = fuzzyMatch('review', 'review');
    const prefix = fuzzyMatch('review', 'review-pr');

    expect(exact.matched).toBe(true);
    expect(exact.positions).toEqual([0, 1, 2, 3, 4, 5]);
    expect(exact.score).toBeGreaterThan(prefix.score);
  });

  it('matches case-insensitively', () => {
    expect(fuzzyMatch('RVW', 'review-pr')).toMatchObject({
      matched: true,
      positions: [0, 2, 5],
    });
  });

  it('matches acronyms and subsequences in order', () => {
    const match = fuzzyMatch('gpr', 'Git Pull Request');

    expect(match.matched).toBe(true);
    expect(match.positions).toEqual([0, 4, 9]);
    expect(fuzzyMatch('gpr', 'Request Pull Git').matched).toBe(false);
  });

  it('scores consecutive matches above scattered matches', () => {
    const consecutive = fuzzyMatch('app', 'application');
    const scattered = fuzzyMatch('app', 'a_p_p');

    expect(consecutive.matched).toBe(true);
    expect(scattered.matched).toBe(true);
    expect(consecutive.score).toBeGreaterThan(scattered.score);
  });

  it('scores word-boundary matches above non-boundary matches', () => {
    const boundary = fuzzyMatch('fb', 'foo-bar');
    const nonBoundary = fuzzyMatch('fb', 'afbx');

    expect(boundary.matched).toBe(true);
    expect(nonBoundary.matched).toBe(true);
    expect(boundary.score).toBeGreaterThan(nonBoundary.score);
  });
});

describe('fuzzyRank', () => {
  it('keeps original ordering for an empty query', () => {
    const items = ['settings', 'review-pr', 'doctor'];

    expect(fuzzyRank('', items, item => item).map(result => result.item)).toEqual(items);
  });

  it('filters non-matches and keeps stable ordering for equal scores', () => {
    const items = ['aa', 'ab', 'bb'];

    expect(fuzzyRank('a', items, item => item).map(result => result.item)).toEqual(['aa', 'ab']);
  });

  it('matches slash-separated query tokens against reordered labels', () => {
    const model = { id: 'gpt-5.2-codex', provider: 'openai-codex' };

    expect(
      fuzzyRank('openai-codex/gpt-5.2', [model], item => `${item.id} ${item.provider}`)
        .map(result => result.item),
    ).toEqual([model]);
  });
});
