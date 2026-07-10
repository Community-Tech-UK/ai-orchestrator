import type { DisplayItem } from './display-item.types';
import type { OutputMessage } from '../../core/state/instance/instance.types';

/** A user message the jump rail can navigate to. */
export interface JumpTarget {
  /** Top-level DisplayItem id — matches the row's `data-item-id` attribute. */
  itemId: string;
  /** Underlying OutputMessage id. */
  messageId: string;
  /** Plain-text excerpt of the user prompt, for the tick's hover preview. */
  promptExcerpt: string;
  /** Plain-text excerpt of the assistant's final reply to that prompt ('' while pending). */
  replyExcerpt: string;
}

/** Below this many user messages the rail hides — nothing worth navigating. */
export const MIN_JUMP_TARGETS = 3;

const EXCERPT_MAX_LENGTH = 160;
const MIN_MARKER_SEPARATION = 6;

/**
 * Collect jump targets from the display items the transcript renders.
 *
 * User messages are always top-level items (DisplayItemProcessor.isWorkItem
 * never classifies them as work items, so wrapForDisplay cannot nest them in
 * a work-cycle). Each target is paired with the LAST assistant response found
 * before the next user message — the final answer to that prompt, not the
 * mid-work narration — searching work-cycle children in order too, since the
 * closing thought-group of a turn is often wrapped inside a cycle.
 */
export function collectJumpTargets(items: readonly DisplayItem[]): JumpTarget[] {
  const targets: JumpTarget[] = [];

  for (let i = 0; i < items.length; i++) {
    const message = userMessageOf(items[i]);
    if (!message) continue;

    let reply = '';
    for (let j = i + 1; j < items.length && !userMessageOf(items[j]); j++) {
      reply = assistantTextOf(items[j]) || reply;
    }

    targets.push({
      itemId: items[i].id,
      messageId: message.id,
      promptExcerpt: excerptText(message.content),
      replyExcerpt: excerptText(reply),
    });
  }

  return targets;
}

function userMessageOf(item: DisplayItem): OutputMessage | null {
  return item.type === 'message' && item.message?.type === 'user' ? item.message : null;
}

/** Assistant-authored text carried by an item, or '' if it has none. */
function assistantTextOf(item: DisplayItem): string {
  if (item.type === 'thought-group' && item.response?.content?.trim()) {
    return item.response.content;
  }
  if (item.type === 'message' && item.message?.type === 'assistant' && item.message.content.trim()) {
    return item.message.content;
  }
  if (item.type === 'work-cycle' && item.children) {
    let last = '';
    for (const child of item.children) {
      last = assistantTextOf(child) || last;
    }
    return last;
  }
  return '';
}

/**
 * Flatten markdown-ish message content into a short single-line excerpt.
 * Best-effort: strips the noisiest syntax rather than fully parsing.
 */
export function excerptText(raw: string, maxLength = EXCERPT_MAX_LENGTH): string {
  const text = raw
    .replace(/```[\s\S]*?(```|$)/g, ' [code] ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|[-*+]|>)\s+/gm, '')
    .replace(/(\*\*|__|\*|_)(\S(?:[^*_]*\S)?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

/**
 * Map anchor ratios (offsetTop / scrollHeight, 0..1) to tick positions in rail
 * pixels, enforcing a minimum separation so dense runs stay individually
 * clickable. A forward pass pushes overlapping ticks down; if that spills past
 * the rail end, a backward pass pulls them up (positions may compress below
 * the minimum separation only when the rail genuinely cannot fit them all).
 */
export function computeMarkerLayout(
  ratios: readonly number[],
  railHeight: number,
  minSeparation = MIN_MARKER_SEPARATION,
): number[] {
  const clampedHeight = Math.max(0, railHeight);
  const tops = ratios.map((r) => Math.min(1, Math.max(0, r)) * clampedHeight);

  for (let i = 1; i < tops.length; i++) {
    tops[i] = Math.max(tops[i], tops[i - 1] + minSeparation);
  }
  for (let i = tops.length - 1; i >= 0; i--) {
    const ceiling = i === tops.length - 1 ? clampedHeight : tops[i + 1] - minSeparation;
    tops[i] = Math.max(0, Math.min(tops[i], ceiling));
  }

  return tops;
}

/**
 * Which marker the viewport is currently "at": the last anchor at or above a
 * reference line half a viewport below the scroll top. -1 when there are no
 * anchors; 0 when the viewport sits above the first anchor.
 */
export function activeMarkerIndex(
  anchorTops: readonly number[],
  scrollTop: number,
  viewportHeight: number,
): number {
  if (anchorTops.length === 0) return -1;

  const referenceLine = scrollTop + viewportHeight * 0.5;
  let active = 0;
  for (let i = 0; i < anchorTops.length; i++) {
    if (anchorTops[i] <= referenceLine) active = i;
  }
  return active;
}
