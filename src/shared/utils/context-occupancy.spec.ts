import { describe, expect, it } from 'vitest';
import { formatTokensK, selfCompactThreshold } from './context-occupancy';

describe('Claude context note helpers', () => {
  it('uses the smaller of the model window and configured ceiling, less Claude’s 33K reserve', () => {
    expect(selfCompactThreshold(1_000_000)).toBe(967_000);
    expect(selfCompactThreshold(1_000_000, 400_000)).toBe(367_000);
    expect(selfCompactThreshold(200_000, 400_000)).toBe(167_000);
    expect(selfCompactThreshold(20_000)).toBe(0);
  });

  it('formats a compact token count for the near-limit note', () => {
    expect(formatTokensK(412_000)).toBe('412K');
    expect(formatTokensK(999)).toBe('999');
  });
});
