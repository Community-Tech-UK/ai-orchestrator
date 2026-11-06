import { describe, expect, it } from 'vitest';
import { formatMoneyExact, formatMoneyPlain } from './format-money';

describe('money presentation', () => {
  it.each([
    [0.7302072, '$0.73'],
    [0.001, 'under 1 cent'],
    [0.004999, 'under 1 cent'],
    [0.005, '$0.01'],
    [0, '$0.00'],
    [12.4, '$12.40'],
    [1e-21, 'under 1 cent'],
  ] satisfies [number, string][])('presents %s in plain cents', (value, expected) => {
    expect(formatMoneyPlain(value)).toBe(expected);
  });

  it('keeps the full supplied precision in Details', () => {
    expect(formatMoneyExact(0.7302072)).toBe('$0.7302072');
    expect(formatMoneyExact(0.1 + 0.2)).toBe('$0.30000000000000004');
    expect(formatMoneyExact(1e-21)).toBe('$1e-21');
  });
});
