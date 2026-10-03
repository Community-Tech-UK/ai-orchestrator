import { describe, expect, it } from 'vitest';
import { isContentFilterEnding } from './content-filter-ending';

const SENTENCE = 'The request was rejected because it was considered high risk';

describe('isContentFilterEnding', () => {
  it('matches the sentence glued onto the previous status line', () => {
    expect(isContentFilterEnding(`Let me understand the auth flow.${SENTENCE}`)).toBe(true);
  });

  it('matches the sentence on its own line, with or without a final period', () => {
    expect(isContentFilterEnding(`Working through the import.\n\n${SENTENCE}`)).toBe(true);
    expect(isContentFilterEnding(`${SENTENCE}.`)).toBe(true);
  });

  it('ignores the sentence when the turn continues past it', () => {
    expect(isContentFilterEnding(`${SENTENCE}\n\nI will try a narrower read.`)).toBe(false);
    expect(isContentFilterEnding('The import is ready.')).toBe(false);
    expect(isContentFilterEnding('')).toBe(false);
  });
});
