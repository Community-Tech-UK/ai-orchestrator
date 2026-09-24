import { describe, expect, it } from 'vitest';
import { computeProjectMenuPosition } from './project-menu-position';

/**
 * LT-631: the project `⋯` menu was clipped by the scrolling
 * `.instance-viewport` ancestor because it was `position: absolute` inside
 * it. These pin the pure placement math the fixed-positioned replacement
 * uses — anchored to the trigger's real viewport rect, not the list pane's
 * clipped box.
 */
describe('computeProjectMenuPosition', () => {
  it('opens downward, flush with the trigger, when there is plenty of room below', () => {
    const anchor = { top: 100, bottom: 126, right: 300 };
    const viewport = { width: 800, height: 900 };

    const position = computeProjectMenuPosition(anchor, viewport);

    expect(position.top).toBe(132); // anchor.bottom + 6px gap
    expect(position.bottom).toBeNull();
    expect(position.right).toBe(500); // viewport.width - anchor.right
  });

  it('reaches the full 420px cap when the whole viewport has room, regardless of a scrolled ancestor', () => {
    // Reproduces the LT-631 numbers: a 900px window whose list pane's own
    // visible clip box was only 413px (other page chrome took the rest).
    // The old `position: absolute` menu was clipped by that 413px box; this
    // menu now measures against the full viewport, per the trigger's real
    // on-screen position.
    const anchor = { top: 150, bottom: 176, right: 300 };
    const viewport = { width: 800, height: 900 };

    const position = computeProjectMenuPosition(anchor, viewport);

    expect(position.maxHeight).toBe(420);
  });

  it('flips upward when there is not enough room below but more room above', () => {
    const anchor = { top: 820, bottom: 846, right: 300 };
    const viewport = { width: 800, height: 900 };

    const position = computeProjectMenuPosition(anchor, viewport);

    expect(position.top).toBeNull();
    expect(position.bottom).toBe(86); // viewport.height - anchor.top + 6px gap
  });

  it('flips toward whichever side has more room when neither meets the comfortable floor', () => {
    const anchor = { top: 200, bottom: 210, right: 300 };
    const viewport = { width: 800, height: 300 };

    const position = computeProjectMenuPosition(anchor, viewport);

    // spaceBelow = 300-210-6-8=76, spaceAbove = 200-6-8=186: below is under
    // the 160px floor, and above has more room, so it flips upward even
    // though 186px is itself short of the preferred 420px cap.
    expect(position.top).toBeNull();
    expect(position.bottom).not.toBeNull();
  });

  it('clamps maxHeight down to the space actually available when even the roomier side is under the 420px cap', () => {
    const anchor = { top: 300, bottom: 850, right: 300 };
    const viewport = { width: 800, height: 900 };

    const position = computeProjectMenuPosition(anchor, viewport);

    // spaceBelow = 900-850-6-8=36 (under the 160px floor) so it flips
    // upward; spaceAbove = 300-6-8=286, under the 420px preferred cap, so
    // maxHeight tracks the real 286px of room instead of overflowing it.
    expect(position.top).toBeNull();
    expect(position.maxHeight).toBe(286);
  });

  it('clamps the right offset to the viewport margin instead of going negative near the edge', () => {
    const anchor = { top: 100, bottom: 126, right: 398 };
    const viewport = { width: 400, height: 900 };

    const position = computeProjectMenuPosition(anchor, viewport);

    expect(position.right).toBe(8);
  });
});
