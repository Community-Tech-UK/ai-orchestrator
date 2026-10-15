import { describe, expect, it } from 'vitest';
import { PlanQueueUserClose } from './plan-queue-user-close';
describe('PlanQueueUserClose', () => {
  it('consumes a recent close once and expires marks after two minutes', () => {
    let now = 0;
    const closes = new PlanQueueUserClose(() => now);
    closes.note(['a', 'b']);
    expect(closes.consume('a')).toBe(true);
    expect(closes.consume('a')).toBe(false);
    now = 120001;
    expect(closes.consume('b')).toBe(false);
  });
});
