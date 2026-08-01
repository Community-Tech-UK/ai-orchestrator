/**
 * Pure, DOM-free math for WS-C10 transcript virtualization.
 *
 * Everything here operates on plain arrays/ids and is fully unit-testable
 * without Angular or jsdom — the DOM-touching half (ResizeObserver wiring,
 * scroll listeners) lives in `transcript-virtualizer-controller.ts`.
 *
 * Design: rather than a single top/bottom spacer pair, off-window content is
 * collapsed into a *sequence* of spacer segments interleaved with rendered
 * row segments. This lets "pinned" rows (today: top-level user messages,
 * which the jump rail and inline-edit focus depend on being able to
 * `querySelector` synchronously) stay in the DOM even when they fall outside
 * the scroll-proximate window, without pulling in everything around them.
 */

/** Estimated row height used until a row is actually measured. */
export const DEFAULT_ESTIMATED_ROW_HEIGHT_PX = 96;

/** Extra pixels rendered beyond the viewport edges, in each direction. */
export const DEFAULT_OVERSCAN_PX = 800;

export interface RenderRowSegment<T> {
  type: 'row';
  id: string;
  item: T;
}

export interface RenderSpacerSegment {
  type: 'spacer';
  /** Stable key for `@for` tracking — the id of the first collapsed item. */
  key: string;
  height: number;
}

export type RenderSegment<T> = RenderRowSegment<T> | RenderSpacerSegment;

export interface ComputeRenderSegmentsOptions<T> {
  scrollTop: number;
  viewportHeight: number;
  overscanPx?: number;
  heightOf: (id: string) => number;
  isPinned?: (item: T) => boolean;
  getId: (item: T) => string;
}

/**
 * Single linear pass over `items`: classifies each as rendered (inside the
 * scroll-proximate window, or pinned) or collapsed into an adjacent spacer.
 * Adjacent collapsed items merge into one spacer, so the result is a compact
 * ordered segment list — DOM order always matches item order.
 */
export function computeRenderSegments<T>(
  items: readonly T[],
  options: ComputeRenderSegmentsOptions<T>,
): RenderSegment<T>[] {
  const overscanPx = options.overscanPx ?? DEFAULT_OVERSCAN_PX;
  const windowStart = options.scrollTop - overscanPx;
  const windowEnd = options.scrollTop + options.viewportHeight + overscanPx;

  const segments: RenderSegment<T>[] = [];
  let runningTop = 0;
  let spacerHeight = 0;
  let spacerKey: string | null = null;

  const flushSpacer = (): void => {
    if (spacerHeight > 0 && spacerKey !== null) {
      segments.push({ type: 'spacer', key: spacerKey, height: spacerHeight });
    }
    spacerHeight = 0;
    spacerKey = null;
  };

  for (const item of items) {
    const id = options.getId(item);
    const height = options.heightOf(id);
    const top = runningTop;
    const bottom = runningTop + height;
    runningTop = bottom;

    const pinned = options.isPinned?.(item) ?? false;
    const inWindow = bottom >= windowStart && top <= windowEnd;

    if (pinned || inWindow) {
      flushSpacer();
      segments.push({ type: 'row', id, item });
    } else {
      if (spacerKey === null) spacerKey = id;
      spacerHeight += height;
    }
  }
  flushSpacer();

  return segments;
}

/** Total height across every item, using cached/estimated heights. Used for
 *  sanity-checking that virtual scrollHeight tracks the non-virtualized total. */
export function estimateTotalHeight<T>(
  items: readonly T[],
  heightOf: (id: string) => number,
  getId: (item: T) => string,
): number {
  let total = 0;
  for (const item of items) total += heightOf(getId(item));
  return total;
}

/** A semantic scroll anchor: the topmost fully-visible row, plus its pixel
 *  offset from the viewport top. Restoring scroll from this (rather than a
 *  raw scrollTop) survives content above the anchor changing size — prepend,
 *  re-measurement, or a session revisit with updated cached heights. */
export interface TranscriptAnchor {
  id: string;
  offset: number;
}

export interface AnchorCandidateRow {
  id: string;
  /** Offset of the row's top edge relative to the viewport's visible top. */
  top: number;
  height: number;
}

/**
 * Picks the topmost fully-visible row as the anchor. Falls back to the
 * topmost row that is at least partially visible (its bottom edge below the
 * viewport top) when nothing is fully visible — e.g. a single row taller
 * than the viewport. Returns null when no rows are rendered.
 */
export function captureAnchor(
  rows: readonly AnchorCandidateRow[],
  viewportHeight: number,
): TranscriptAnchor | null {
  if (rows.length === 0) return null;

  let fallback: AnchorCandidateRow | null = null;
  for (const row of rows) {
    const bottom = row.top + row.height;
    if (row.top >= 0 && bottom <= viewportHeight) {
      return { id: row.id, offset: row.top };
    }
    if (fallback === null && bottom > 0) {
      fallback = row;
    }
  }

  const chosen = fallback ?? rows[0];
  return { id: chosen.id, offset: Math.max(0, chosen.top) };
}

/**
 * Resolves an anchor back to a target scrollTop against a (possibly
 * different) items array — the id may have shifted position after a
 * prepend, but its cumulative offset is recomputed from scratch each time,
 * so the same message lands at the same on-screen offset. Returns null when
 * the anchor's id is no longer present (e.g. history was trimmed).
 */
export function resolveAnchorScrollTop<T>(
  anchor: TranscriptAnchor,
  items: readonly T[],
  heightOf: (id: string) => number,
  getId: (item: T) => string,
): number | null {
  let runningTop = 0;
  for (const item of items) {
    const id = getId(item);
    if (id === anchor.id) {
      return Math.max(0, runningTop - anchor.offset);
    }
    runningTop += heightOf(id);
  }
  return null;
}
