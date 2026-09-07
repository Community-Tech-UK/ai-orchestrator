/**
 * Post-filter merge of thought-groups that are only adjacent on screen.
 *
 * `DisplayItemProcessor` already folds consecutive thinking-only turns into a
 * single "Thought process" panel, but it runs BEFORE the visibility filter and
 * deliberately refuses to merge across a tool-group — the reasoning either side
 * of real work belongs to different steps. With "show tool calls" off (or
 * progress notes hidden) those separators never reach the DOM, so a turn that
 * alternates think → Bash → think → Bash renders as a stack of identical
 * "Thought process (1)" boxes with nothing between them.
 *
 * So the same merge runs again over the FILTERED list, where "adjacent" means
 * "adjacent on screen". Only response-less groups merge, so a visible assistant
 * bubble can never be swallowed — matching the processor's own rule.
 *
 * Merged rows are memoised through a carrier state, mirroring
 * `compute-stable-display-items.ts`: rebuilding the merged `thinking`/`thoughts`
 * arrays on every recompute would flip the row's content signature every time
 * and defeat the reference stabilisation that keeps OnPush rows from
 * re-rendering on each incoming message.
 */

import type { DisplayItem } from './display-item.types';

interface MergedEntry {
  /** Content key of the members that produced `item`. */
  key: string;
  item: DisplayItem;
}

/**
 * State carried between calls so an unchanged run of thought-groups yields the
 * exact same merged object (and the same array references inside it).
 *
 * `merged` is keyed by the run's lead item id — the id the merged row adopts,
 * so expansion state survives the run growing.
 */
export interface ThoughtCoalesceState {
  merged: Map<string, MergedEntry>;
  result: DisplayItem[];
}

export const EMPTY_THOUGHT_COALESCE_STATE: ThoughtCoalesceState = {
  merged: new Map(),
  result: [],
};

/**
 * Merge runs of adjacent, response-less thought-groups into one row, at the top
 * level and inside work-cycle children.
 *
 * Pure with respect to the input: source items and their arrays are never
 * mutated (they are the processor's own objects, which in turn reference store
 * state). Returns a fresh state; pass the previous one back in to reuse merged
 * rows whose content has not changed.
 */
export function coalesceThoughtGroups(
  items: DisplayItem[],
  previous: ThoughtCoalesceState,
): ThoughtCoalesceState {
  const merged = new Map<string, MergedEntry>();
  // Safe: coalesceList either hands back `items` itself or an array it built.
  const result = coalesceList(items, previous.merged, merged) as DisplayItem[];
  return { merged, result };
}

/**
 * Walk one list, merging the runs it finds. Returns the input array itself when
 * nothing merged — with tool calls visible that is every recompute, and the
 * caller (a `computed()` on every incoming message) should not pay for a copy.
 * The output array is only allocated once the first row actually changes.
 */
function coalesceList(
  items: readonly DisplayItem[],
  previous: ReadonlyMap<string, MergedEntry>,
  next: Map<string, MergedEntry>,
): readonly DisplayItem[] {
  let out: DisplayItem[] | null = null;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let resolved = item;
    let lastConsumed = i;

    if (item.type === 'work-cycle' && item.children && item.children.length > 0) {
      const source = item.children;
      const children = coalesceList(source, previous, next);
      if (children !== source) {
        resolved = { ...item, children: children as DisplayItem[] };
      }
    } else if (isMergeableThoughtGroup(item)) {
      let end = i + 1;
      while (end < items.length && isMergeableThoughtGroup(items[end])) {
        end++;
      }
      if (end - i > 1) {
        resolved = mergeRun(items.slice(i, end), previous, next);
        lastConsumed = end - 1;
      }
    }

    if (out === null) {
      if (resolved === item) {
        continue;
      }
      out = items.slice(0, i);
    }

    out.push(resolved);
    i = lastConsumed;
  }

  return out ?? items;
}

/** A thought-group carrying no assistant bubble of its own. */
function isMergeableThoughtGroup(item: DisplayItem): boolean {
  return item.type === 'thought-group' && !hasRenderableResponse(item);
}

/** Mirrors MessageFormatService.hasContent() for a thought-group's response. */
function hasRenderableResponse(item: DisplayItem): boolean {
  const response = item.response;
  return Boolean(
    response &&
    (response.content?.trim() || (response.attachments && response.attachments.length > 0)),
  );
}

function mergeRun(
  members: readonly DisplayItem[],
  previous: ReadonlyMap<string, MergedEntry>,
  next: Map<string, MergedEntry>,
): DisplayItem {
  const lead = members[0];
  const key = memberKey(members);
  const cached = previous.get(lead.id);
  if (cached && cached.key === key) {
    next.set(lead.id, cached);
    return cached.item;
  }

  const thinking = members.flatMap((member) => member.thinking ?? []);
  const thoughts = members.flatMap((member) => member.thoughts ?? []);
  const last = members[members.length - 1];

  const item: DisplayItem = {
    ...lead,
    thinking: thinking.length > 0 ? thinking : undefined,
    thoughts: thoughts.length > 0 ? thoughts : undefined,
    bufferIndex: last.bufferIndex ?? lead.bufferIndex,
    collapsedThinkingFallback: members.some((member) => member.collapsedThinkingFallback)
      ? true
      : lead.collapsedThinkingFallback,
  };

  next.set(lead.id, { key, item });
  return item;
}

/**
 * Content key for a run. Ids cover membership; the block counts cover a member
 * growing in place (the processor appends to a group as more reasoning lands),
 * and `showHeader`/`collapsedThinkingFallback` cover the render flags the merged
 * copy inherits from its lead.
 */
function memberKey(members: readonly DisplayItem[]): string {
  return members
    .map((member) =>
      [
        member.id,
        member.thinking?.length ?? 0,
        member.thoughts?.length ?? 0,
        member.collapsedThinkingFallback ? 'cf' : '',
        member.showHeader ?? '',
      ].join(':'),
    )
    .join('|');
}
