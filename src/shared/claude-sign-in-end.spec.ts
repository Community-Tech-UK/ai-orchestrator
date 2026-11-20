import { describe, expect, it } from 'vitest';
import { claudeSignInEndingSoon, describeClaudeSignInEnd } from './claude-sign-in-end';

const DAY = 24 * 60 * 60 * 1000;
/** Local midday, so the dates in the text do not depend on the time zone. */
const LATEST = new Date(2026, 10, 27, 12, 0).getTime();

describe('claudeSignInEndingSoon', () => {
  it('warns from a week before the earliest end, three days before the reported date', () => {
    expect(claudeSignInEndingSoon(LATEST, LATEST - 10 * DAY - 60_000)).toBeNull();
    expect(claudeSignInEndingSoon(LATEST, LATEST - 10 * DAY)).toEqual({ earliest: LATEST - 3 * DAY, latest: LATEST });
    expect(claudeSignInEndingSoon(LATEST, LATEST + DAY)).toEqual({ earliest: LATEST - 3 * DAY, latest: LATEST });
  });

  it('says nothing without a usable end date', () => {
    expect(claudeSignInEndingSoon(undefined, LATEST)).toBeNull();
    expect(claudeSignInEndingSoon(Number.NaN, LATEST)).toBeNull();
  });
});

describe('describeClaudeSignInEnd', () => {
  const end = { earliest: LATEST - 3 * DAY, latest: LATEST };

  it('gives the window, naming the month once when both days share it', () => {
    expect(describeClaudeSignInEnd(end, LATEST - 6 * DAY)).toBe('ends between 24 and 27 November');
  });

  it('names both months when the window crosses one', () => {
    const latest = new Date(2026, 11, 2, 12, 0).getTime();
    expect(describeClaudeSignInEnd({ earliest: latest - 3 * DAY, latest }, latest - 5 * DAY))
      .toBe('ends between 29 November and 2 December');
  });

  it('says it can end at any time once the window has opened, and may have ended after it', () => {
    expect(describeClaudeSignInEnd(end, LATEST - DAY)).toBe('can end at any time before 27 November');
    expect(describeClaudeSignInEnd(end, LATEST + 60_000)).toBe('may already have ended (on 27 November at the latest)');
  });
});
