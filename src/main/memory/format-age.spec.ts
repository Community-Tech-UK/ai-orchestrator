import { describe, expect, it } from 'vitest';
import { formatAge, isStaleAge, ONE_DAY_MS } from './format-age';

describe('formatAge', () => {
  it('renders "today" for under a day, including zero and negative (clock skew)', () => {
    expect(formatAge(0)).toBe('today');
    expect(formatAge(ONE_DAY_MS - 1)).toBe('today');
    expect(formatAge(-500)).toBe('today');
  });

  it('renders "1 day ago" for exactly one day', () => {
    expect(formatAge(ONE_DAY_MS)).toBe('1 day ago');
  });

  it('renders "N days ago" for 2–6 days', () => {
    expect(formatAge(2 * ONE_DAY_MS)).toBe('2 days ago');
    expect(formatAge(6 * ONE_DAY_MS)).toBe('6 days ago');
  });

  it('switches to week granularity at 7 days', () => {
    expect(formatAge(7 * ONE_DAY_MS)).toBe('1 week ago');
    expect(formatAge(13 * ONE_DAY_MS)).toBe('1 week ago');
    expect(formatAge(14 * ONE_DAY_MS)).toBe('2 weeks ago');
  });

  it('stays at day granularity — never renders hours or minutes', () => {
    // 25 hours should still be "1 day ago", not "1 day, 1 hour ago".
    expect(formatAge(25 * 60 * 60 * 1000)).toBe('1 day ago');
  });

  it('is stable within the same day for prompt-cache friendliness', () => {
    const morning = 3 * ONE_DAY_MS + 1000;
    const evening = 3 * ONE_DAY_MS + 23 * 60 * 60 * 1000;
    expect(formatAge(morning)).toBe(formatAge(evening));
  });
});

describe('isStaleAge', () => {
  it('is false below the threshold and true at/above it', () => {
    expect(isStaleAge(6 * ONE_DAY_MS, 7)).toBe(false);
    expect(isStaleAge(7 * ONE_DAY_MS, 7)).toBe(true);
    expect(isStaleAge(30 * ONE_DAY_MS, 30)).toBe(true);
    expect(isStaleAge(29 * ONE_DAY_MS, 30)).toBe(false);
  });
});
