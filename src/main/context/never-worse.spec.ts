import { describe, it, expect } from 'vitest';
import { pickNeverWorse } from './never-worse';

describe('pickNeverWorse', () => {
  it('returns the reduced form when it is estimated to cost fewer tokens', () => {
    const raw = 'x'.repeat(1000);
    const reduced = 'x'.repeat(10);
    expect(pickNeverWorse(raw, reduced)).toBe(reduced);
  });

  it('returns the raw form when the "reduced" form is not actually smaller', () => {
    const raw = 'short';
    const reduced = 'this replacement is actually longer than the original text';
    expect(pickNeverWorse(raw, reduced)).toBe(raw);
  });

  it('prefers the reduced form on a token-estimate tie', () => {
    // Same length -> same default char-heuristic token estimate.
    const raw = 'abcd';
    const reduced = 'wxyz';
    expect(pickNeverWorse(raw, reduced)).toBe(reduced);
  });

  it('uses a custom estimator when provided', () => {
    const raw = 'aaaa';
    const reduced = 'bb';
    // Custom estimator says the "reduced" form is actually more expensive.
    const estimator = (text: string) => (text === reduced ? 100 : 1);
    expect(pickNeverWorse(raw, reduced, estimator)).toBe(raw);
  });

  it('handles empty strings without throwing', () => {
    expect(pickNeverWorse('', '')).toBe('');
    expect(pickNeverWorse('non-empty', '')).toBe('');
  });
});
