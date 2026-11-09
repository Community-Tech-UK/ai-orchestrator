import { describe, expect, it } from 'vitest';
import { buildSortKey, PRIORITY_NONE } from './plan-queue-sort-key';

const order = (keys: string[]): string[] => [...keys].sort();

describe('buildSortKey', () => {
  it('orders by priority first, Urgent to Low, then no priority', () => {
    const none = buildSortKey({ priority: PRIORITY_NONE, discoveryIndex: 0 });
    const low = buildSortKey({ priority: 4, discoveryIndex: 1 });
    const urgent = buildSortKey({ priority: 1, discoveryIndex: 2 });
    const medium = buildSortKey({ priority: 3, discoveryIndex: 3 });
    const high = buildSortKey({ priority: 2, discoveryIndex: 4 });
    expect(order([none, low, urgent, medium, high])).toEqual([urgent, high, medium, low, none]);
  });

  it('then by the source order, then by discovery order', () => {
    const second = buildSortKey({ priority: 2, sourceOrder: 5, discoveryIndex: 0 });
    const first = buildSortKey({ priority: 2, sourceOrder: 4, discoveryIndex: 9 });
    const tied = buildSortKey({ priority: 2, sourceOrder: 4, discoveryIndex: 10 });
    expect(order([second, tied, first])).toEqual([first, tied, second]);
  });

  it('keeps plain discovery order for a source with no priority (markdown)', () => {
    const keys = Array.from({ length: 12 }, (_, index) => buildSortKey({ discoveryIndex: index }));
    expect(order([...keys].reverse())).toEqual(keys);
  });

  it('sorts a row written before the column existed (empty key) ahead of every real key', () => {
    expect(order([buildSortKey({ priority: 1, discoveryIndex: 0 }), ''])[0]).toBe('');
  });

  it.each([
    [{ discoveryIndex: -1 }], [{ discoveryIndex: 1.5 }], [{ discoveryIndex: 1_000_000 }],
    [{ priority: 10, discoveryIndex: 0 }], [{ sourceOrder: -2, discoveryIndex: 0 }],
  ])('refuses a part that would break the order: %j', parts => {
    expect(() => buildSortKey(parts)).toThrow(/Invalid sort key/);
  });
});
