import { describe, it, expect } from 'vitest';
import {
  captureAnchor,
  computeRenderSegments,
  estimateTotalHeight,
  resolveAnchorScrollTop,
} from './transcript-virtualizer-math';

interface Item {
  id: string;
}

function makeItems(count: number): Item[] {
  return Array.from({ length: count }, (_, i) => ({ id: `item-${i}` }));
}

const FIXED_HEIGHT = 100;
const heightOf = (): number => FIXED_HEIGHT;
const getId = (item: Item): string => item.id;

describe('computeRenderSegments', () => {
  it('renders every item as a single row segment when everything fits the window', () => {
    const items = makeItems(5);
    const segments = computeRenderSegments(items, {
      scrollTop: 0,
      viewportHeight: 1000,
      heightOf,
      getId,
    });

    expect(segments).toEqual(items.map((item) => ({ type: 'row', id: item.id, item })));
  });

  it('collapses off-window items into a single merged spacer, preserving DOM order', () => {
    const items = makeItems(20); // 20 * 100px = 2000px total
    const segments = computeRenderSegments(items, {
      scrollTop: 1050,
      viewportHeight: 100,
      overscanPx: 0,
      heightOf,
      getId,
    });

    // Window is [1050, 1150] with 0 overscan: only item-10 (1000-1100) and
    // item-11 (1100-1200) overlap it; everything else collapses.
    expect(segments[0]).toMatchObject({ type: 'spacer', height: 1000 }); // items 0-9
    expect(segments[1]).toMatchObject({ type: 'row', id: 'item-10' });
    expect(segments[2]).toMatchObject({ type: 'row', id: 'item-11' });
    expect(segments[3]).toMatchObject({ type: 'spacer', height: 800 }); // items 12-19
    expect(segments).toHaveLength(4);
  });

  it('splits a spacer around a pinned item that falls outside the window', () => {
    const items = makeItems(20);
    const segments = computeRenderSegments(items, {
      scrollTop: 1050,
      viewportHeight: 100,
      overscanPx: 0,
      heightOf,
      getId,
      isPinned: (item) => item.id === 'item-2',
    });

    // item-2 (offset 200-300) is pinned, so the leading spacer splits into
    // [0-200] spacer, item-2 row, [300-1000] spacer, then the natural window.
    expect(segments.map((s) => (s.type === 'row' ? s.id : `spacer(${s.height})`))).toEqual([
      'spacer(200)',
      'item-2',
      'spacer(700)',
      'item-10',
      'item-11',
      'spacer(800)',
    ]);
  });

  it('never emits a zero-height spacer between two adjacent windows', () => {
    const items = makeItems(3);
    const segments = computeRenderSegments(items, {
      scrollTop: 0,
      viewportHeight: 1000,
      heightOf,
      getId,
    });
    expect(segments.some((s) => s.type === 'spacer')).toBe(false);
  });

  it('returns an empty list for an empty item array', () => {
    expect(computeRenderSegments([], { scrollTop: 0, viewportHeight: 500, heightOf, getId })).toEqual([]);
  });

  it('uses per-item measured/estimated heights, not a fixed constant', () => {
    const items = makeItems(3);
    const heights: Record<string, number> = { 'item-0': 50, 'item-1': 900, 'item-2': 50 };
    const segments = computeRenderSegments(items, {
      scrollTop: 0,
      viewportHeight: 100,
      overscanPx: 0,
      heightOf: (id) => heights[id],
      getId,
    });
    // window [0,100]: item-0 (0-50) in, item-1 (50-950) overlaps [0,100] too.
    expect(segments.filter((s) => s.type === 'row').map((s) => (s as { id: string }).id)).toEqual([
      'item-0',
      'item-1',
    ]);
  });
});

describe('estimateTotalHeight', () => {
  it('sums heights across all items', () => {
    const items = makeItems(4);
    expect(estimateTotalHeight(items, heightOf, getId)).toBe(400);
  });

  it('is zero for an empty list', () => {
    expect(estimateTotalHeight([], heightOf, getId)).toBe(0);
  });
});

describe('captureAnchor', () => {
  it('picks the topmost fully-visible row', () => {
    const anchor = captureAnchor(
      [
        { id: 'a', top: -50, height: 80 }, // clipped at top, not fully visible
        { id: 'b', top: 30, height: 100 }, // fully visible
        { id: 'c', top: 130, height: 100 },
      ],
      400,
    );
    expect(anchor).toEqual({ id: 'b', offset: 30 });
  });

  it('falls back to a partially-visible row when nothing is fully visible', () => {
    const anchor = captureAnchor([{ id: 'tall', top: -20, height: 1000 }], 400);
    expect(anchor).toEqual({ id: 'tall', offset: 0 });
  });

  it('returns null when there are no rendered rows', () => {
    expect(captureAnchor([], 400)).toBeNull();
  });

  it('ignores a row that has already scrolled fully above the viewport', () => {
    const anchor = captureAnchor(
      [
        { id: 'gone', top: -200, height: 50 }, // bottom at -150, fully above
        { id: 'visible', top: 10, height: 50 },
      ],
      400,
    );
    expect(anchor?.id).toBe('visible');
  });
});

describe('resolveAnchorScrollTop', () => {
  it('resolves the cumulative offset of the anchor id, minus its saved offset', () => {
    const items = makeItems(5); // 100px rows
    const target = resolveAnchorScrollTop({ id: 'item-3', offset: 20 }, items, heightOf, getId);
    // item-3 starts at cumulative 300; anchor wants it to sit 20px from the top.
    expect(target).toBe(280);
  });

  it('clamps to zero rather than going negative', () => {
    const items = makeItems(2);
    const target = resolveAnchorScrollTop({ id: 'item-0', offset: 500 }, items, heightOf, getId);
    expect(target).toBe(0);
  });

  it('returns null when the anchor id is no longer present', () => {
    const items = makeItems(3);
    expect(resolveAnchorScrollTop({ id: 'missing', offset: 0 }, items, heightOf, getId)).toBeNull();
  });

  it('keeps the anchor message visually stable after a prepend (new items shift its cumulative offset, but resolving against the new array still lands correctly)', () => {
    const before = makeItems(5);
    const anchor = { id: 'item-3', offset: 20 };
    const targetBefore = resolveAnchorScrollTop(anchor, before, heightOf, getId);
    expect(targetBefore).not.toBeNull();

    const prepended = [{ id: 'older-0' }, { id: 'older-1' }, ...before];
    const targetAfter = resolveAnchorScrollTop(anchor, prepended, heightOf, getId);

    // Same on-screen offset (20px from top), but the absolute scrollTop grew
    // by exactly the prepended content's height (2 * 100px).
    expect(targetAfter).toBe((targetBefore as number) + 200);
  });
});
