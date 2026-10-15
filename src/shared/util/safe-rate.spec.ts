import { describe, expect, it } from 'vitest';
import { rate, formatRate, formatMoneyRate, formatMean } from './safe-rate';
describe('safe rates', () => {
  it('fails closed for invalid populations', () => {
    for (const [n,d] of [[0,0],[2,1],[NaN,2],[1,Infinity],[-1,2]]) expect(formatRate(rate(n,d))).toBe('-');
  });
  it('labels proportions and means separately', () => {
    expect(formatRate(rate(5,8))).toBe('63% (5 of 8)');
    expect(formatMoneyRate(520,840)).toBe('62% ($5.20 of $8.40)');
    expect(formatMean(494400,12,'tokens per task')).toBe('41,200 tokens per task (12 tasks)');
    expect(formatMean(4,0,'dollars per document')).toBe('-');
  });
});
