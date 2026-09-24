/**
 * Pure positioning math for the instance-list project `⋯` menu (LT-631).
 *
 * `.project-menu` used to be `position: absolute` inside `.project-menu-anchor`,
 * a descendant of the scrolling `.instance-viewport` list pane. That ancestor's
 * `overflow-y: auto` clipped the bottom of the menu with a hard flat edge
 * whenever the list pane's own visible (unscrolled) box was shorter than the
 * menu's height cap — a routine case at ordinary window sizes, not an edge
 * case (see the LT-631 register entry).
 *
 * `instance-list.component.ts` now renders the menu `position: fixed` and
 * computes its placement from the trigger's `getBoundingClientRect()` against
 * the real viewport (not the scrolled list pane's clipped box), flipping
 * upward and clamping `maxHeight` when there isn't enough room below.
 */

export interface ProjectMenuPosition {
  /** `null` when the menu opens upward (anchored via `bottom` instead). */
  top: number | null;
  /** `null` when the menu opens downward (anchored via `top` instead). */
  bottom: number | null;
  right: number;
  maxHeight: number;
}

/** The subset of `DOMRect` this calculation needs, so tests can pass plain objects. */
export interface ProjectMenuAnchorRect {
  top: number;
  bottom: number;
  right: number;
}

export interface ProjectMenuViewport {
  width: number;
  height: number;
}

const GAP = 6;
const VIEWPORT_MARGIN = 8;
const MIN_USABLE_HEIGHT = 160;
const MAX_HEIGHT_CAP = 420;
const MAX_HEIGHT_VIEWPORT_FRACTION = 0.6;

export function computeProjectMenuPosition(
  anchor: ProjectMenuAnchorRect,
  viewport: ProjectMenuViewport
): ProjectMenuPosition {
  const preferredMaxHeight = Math.min(MAX_HEIGHT_CAP, viewport.height * MAX_HEIGHT_VIEWPORT_FRACTION);

  const spaceBelow = viewport.height - anchor.bottom - GAP - VIEWPORT_MARGIN;
  const spaceAbove = anchor.top - GAP - VIEWPORT_MARGIN;
  const openUpward = spaceBelow < MIN_USABLE_HEIGHT && spaceAbove > spaceBelow;
  const available = Math.max(0, openUpward ? spaceAbove : spaceBelow);

  return {
    top: openUpward ? null : anchor.bottom + GAP,
    bottom: openUpward ? viewport.height - anchor.top + GAP : null,
    right: Math.max(VIEWPORT_MARGIN, viewport.width - anchor.right),
    maxHeight: Math.min(preferredMaxHeight, Math.max(MIN_USABLE_HEIGHT, available)),
  };
}
