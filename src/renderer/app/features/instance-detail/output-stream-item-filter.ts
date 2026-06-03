/**
 * Visibility filtering for the output-stream display items.
 *
 * Strips items that the current display settings hide — tool-groups (when tool
 * calls are hidden) and empty thought-groups (when thinking is hidden) — from
 * both the top level and from inside work-cycle children. This keeps a
 * collapsed work-cycle's summary honest: it must not advertise "1 thought" or
 * "2 Bash" for content that would render to an empty box. Work-cycles whose
 * children all get filtered out are dropped entirely.
 */

import type { DisplayItem } from './display-item-processor.service';

export interface DisplayItemFilterOptions {
  /** Drop tool-group items (and tool-group children of work-cycles). */
  hideToolGroups: boolean;
  /**
   * Drop thought-group items that would render nothing — i.e. thinking is
   * hidden and the group carries no standalone response. Without this, a
   * thought-group nested in a work-cycle still inflates the cycle summary
   * ("1 thought") and expands to an empty body.
   */
  hideEmptyThoughts: boolean;
  /**
   * Predicate returning true when a thought-group has no visible content under
   * the current settings. Injected so this module stays free of the
   * content-inspection logic (which lives in MessageFormatService).
   */
  isThoughtGroupEmpty: (item: DisplayItem) => boolean;
}

/**
 * Filter the display-item list for the current visibility settings.
 *
 * Returns the original array reference unchanged when nothing needs filtering,
 * preserving downstream reference-stability short-circuits.
 */
export function filterDisplayItems<T extends DisplayItem>(
  items: T[],
  options: DisplayItemFilterOptions,
): T[] {
  const { hideToolGroups, hideEmptyThoughts, isThoughtGroupEmpty } = options;
  if (!hideToolGroups && !hideEmptyThoughts) {
    return items;
  }

  const keep = (item: DisplayItem): boolean => {
    if (hideToolGroups && item.type === 'tool-group') {
      return false;
    }
    if (
      hideEmptyThoughts &&
      item.type === 'thought-group' &&
      isThoughtGroupEmpty(item)
    ) {
      return false;
    }
    return true;
  };

  const result: T[] = [];
  for (const item of items) {
    if (!keep(item)) {
      continue;
    }
    if (item.type === 'work-cycle' && item.children) {
      const filtered = item.children.filter(keep);
      if (filtered.length === 0) {
        continue;
      }
      result.push({ ...item, children: filtered } as T);
    } else {
      result.push(item);
    }
  }
  return result;
}
