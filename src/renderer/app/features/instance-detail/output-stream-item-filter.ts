/**
 * Visibility filtering for the output-stream display items.
 *
 * Strips items that the current display settings hide — tool-groups (when tool
 * calls are hidden) and empty thought-groups (when thinking is hidden) — from
 * both the top level and from inside work-cycle children. This keeps a
 * collapsed work-cycle's summary honest: it must not advertise "1 thought" or
 * "2 Bash" for content that would render to an empty box. Work-cycles whose
 * children all get filtered out are dropped entirely.
 *
 * When thinking is hidden, a thought-group that carries reasoning/narration but
 * no standalone response is NOT dropped and NOT flattened into a bare assistant
 * bubble (which rendered an empty "CLAUDE" header — the reasoning text was
 * created after the markdown pass and never rendered). Instead it is kept as a
 * thought-group and flagged `collapsedThinkingFallback`, so the template renders
 * it as a collapsed-by-default "Thought process" accordion. The reasoning stays
 * one click away instead of either vanishing or filling the transcript.
 * Thought-groups with no reasoning text at all are still dropped.
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

/** True when the thought-group carries any non-empty reasoning/narration text. */
function hasThinkingText(item: DisplayItem): boolean {
  if (item.thinking?.some((block) => block.content.trim().length > 0)) {
    return true;
  }
  return item.thoughts?.some((thought) => thought.trim().length > 0) ?? false;
}

/**
 * When thinking display is off, a thought-group with reasoning text but no
 * standalone response would otherwise render nothing (its accordion is gated on
 * the showThinking toggle). Rather than drop it — or flatten it into an empty
 * assistant bubble — keep it as a thought-group flagged to render a
 * collapsed-by-default accordion. Groups with no reasoning text are dropped.
 */
function resolveHiddenThoughtGroup(item: DisplayItem): DisplayItem | null {
  if (!hasThinkingText(item)) {
    return null;
  }
  if (item.collapsedThinkingFallback) {
    return item;
  }
  return { ...item, collapsedThinkingFallback: true };
}

function resolveItemForDisplay(
  item: DisplayItem,
  options: DisplayItemFilterOptions,
): DisplayItem | null {
  const { hideToolGroups, hideEmptyThoughts, isThoughtGroupEmpty } = options;

  if (hideToolGroups && item.type === 'tool-group') {
    return null;
  }

  if (hideEmptyThoughts && item.type === 'thought-group' && isThoughtGroupEmpty(item)) {
    return resolveHiddenThoughtGroup(item);
  }

  return item;
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
  const { hideToolGroups, hideEmptyThoughts } = options;
  if (!hideToolGroups && !hideEmptyThoughts) {
    return items;
  }

  const result: T[] = [];
  for (const item of items) {
    const resolved = resolveItemForDisplay(item, options);
    if (!resolved) {
      continue;
    }

    if (resolved.type === 'work-cycle' && resolved.children) {
      const filteredChildren = resolved.children
        .map((child) => resolveItemForDisplay(child, options))
        .filter((child): child is DisplayItem => child !== null);
      if (filteredChildren.length === 0) {
        continue;
      }
      result.push({ ...resolved, children: filteredChildren } as T);
    } else {
      result.push(resolved as T);
    }
  }
  return result;
}
