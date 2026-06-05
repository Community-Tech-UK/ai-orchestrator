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
 * When thinking is hidden, thought-groups that carry extracted planning text
 * but no standalone response are promoted to regular assistant messages so
 * Cursor/Codex narration is still visible (formatted via markdown), instead
 * of vanishing from the transcript.
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

function joinThoughtContent(item: DisplayItem): string {
  const fromBlocks = item.thinking?.map((block) => block.content.trim()).filter(Boolean) ?? [];
  if (fromBlocks.length > 0) {
    return fromBlocks.join('\n\n');
  }
  const fromLegacy = item.thoughts?.map((thought) => thought.trim()).filter(Boolean) ?? [];
  return fromLegacy.join('\n\n');
}

/**
 * When thinking display is off, a thought-group with extracted narration but
 * no response body would otherwise be dropped entirely. Promote it to a normal
 * assistant message so the user still sees the text.
 */
function promoteHiddenThoughtGroup(
  item: DisplayItem,
  isThoughtGroupEmpty: (item: DisplayItem) => boolean,
): DisplayItem | null {
  if (item.type !== 'thought-group' || !isThoughtGroupEmpty(item)) {
    return item;
  }

  const thinkingContent = joinThoughtContent(item);
  if (!thinkingContent) {
    return null;
  }

  const baseMessage = item.response ?? {
    id: item.id.replace(/^thought-/, 'msg-'),
    type: 'assistant' as const,
    content: '',
    timestamp: item.timestamp ?? Date.now(),
  };

  return {
    id: `msg-${item.id}`,
    type: 'message',
    message: {
      ...baseMessage,
      type: 'assistant',
      content: thinkingContent,
    },
    timestamp: item.timestamp ?? baseMessage.timestamp,
    bufferIndex: item.bufferIndex,
  };
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
    return promoteHiddenThoughtGroup(item, isThoughtGroupEmpty);
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
