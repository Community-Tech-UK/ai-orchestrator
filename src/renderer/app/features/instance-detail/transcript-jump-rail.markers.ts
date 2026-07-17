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
  /** Display names (basenames) of files edited during the turn, in edit order. */
  files: string[];
}

/** Below this many user messages the rail hides — nothing worth navigating. */
export const MIN_JUMP_TARGETS = 3;

const EXCERPT_MAX_LENGTH = 160;

/** Vertical gap between adjacent ticks in the centred cluster. */
const TICK_SPACING = 12;
/** Spacing floor when many ticks must fit a short rail. */
const MIN_TICK_SPACING = 4;

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
    const filePaths = new Set<string>();
    for (let j = i + 1; j < items.length && !userMessageOf(items[j]); j++) {
      reply = assistantTextOf(items[j]) || reply;
      collectEditedFilePaths(items[j], filePaths);
    }

    targets.push({
      itemId: items[i].id,
      messageId: message.id,
      promptExcerpt: excerptText(message.content),
      replyExcerpt: excerptText(reply),
      files: fileDisplayNames(filePaths),
    });
  }

  return targets;
}

/**
 * Tools that never mutate files — their path arguments are reads, not edits.
 * Mirrors the read-only set in `src/main/instance/tool-output-parser.ts`.
 */
const READ_ONLY_TOOLS = new Set([
  // Claude
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Agent', 'TodoWrite', 'LS',
  // Codex / Gemini / generic
  'ListFiles', 'SearchFiles', 'read_file', 'list_dir', 'grep', 'list_directory', 'search_files',
  // Copilot
  'readFile', 'listFiles', 'searchFiles',
]);

const FILE_PATH_KEYS = ['file_path', 'path', 'filePath', 'notebook_path', 'filename'] as const;

/** Recursively collect edited-file paths from tool_use messages carried by an item. */
function collectEditedFilePaths(item: DisplayItem, sink: Set<string>): void {
  if (item.type === 'tool-group' && item.toolMessages) {
    for (const toolMessage of item.toolMessages) {
      addToolUseFilePaths(toolMessage, sink);
    }
  } else if (item.type === 'work-cycle' && item.children) {
    for (const child of item.children) {
      collectEditedFilePaths(child, sink);
    }
  } else if (item.type === 'message' && item.message) {
    addToolUseFilePaths(item.message, sink);
  }
}

/**
 * Pull file paths out of a mutating tool_use message's metadata. The adapter
 * stores the tool input either under `metadata['input']` or flattened into the
 * metadata itself (alongside `name`), so both shapes are probed. Command-string
 * parsing (Bash redirects etc.) is deliberately skipped — the preview chips
 * only need the common direct-edit tools, not the full diff-tracker fidelity
 * of `tool-output-parser.ts`.
 */
function addToolUseFilePaths(message: OutputMessage, sink: Set<string>): void {
  if (message.type !== 'tool_use' || !message.metadata) return;
  const meta = message.metadata as Record<string, unknown>;
  const toolName = typeof meta['name'] === 'string' ? meta['name'] : '';
  if (READ_ONLY_TOOLS.has(toolName)) return;

  const rawInput = meta['input'];
  const input =
    rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
      ? (rawInput as Record<string, unknown>)
      : meta;

  for (const key of FILE_PATH_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) sink.add(value);
  }

  const edits = input['edits'];
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      if (edit && typeof edit === 'object') {
        const filePath = (edit as Record<string, unknown>)['file_path'];
        if (typeof filePath === 'string' && filePath.trim()) sink.add(filePath);
      }
    }
  }
}

/** Map full paths to deduplicated basenames, preserving first-seen order. */
function fileDisplayNames(paths: ReadonlySet<string>): string[] {
  const names = new Set<string>();
  for (const path of paths) {
    const name = path.split(/[/\\]/).filter(Boolean).pop();
    if (name) names.add(name);
  }
  return [...names];
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
 * Codex-style tick layout: an evenly spaced cluster bunched at the vertical
 * centre of the rail, NOT spread proportionally across the pane height.
 * Spacing compresses when the cluster would overflow the rail, down to a
 * floor; past that, positions clamp to the rail bounds.
 */
export function computeMarkerLayout(
  count: number,
  railHeight: number,
  spacing = TICK_SPACING,
): number[] {
  if (count <= 0) return [];
  const clampedHeight = Math.max(0, railHeight);
  const fitted = count > 1 ? Math.min(spacing, clampedHeight / (count - 1)) : spacing;
  const gap = Math.max(MIN_TICK_SPACING, fitted);
  const clusterHeight = (count - 1) * gap;
  const start = Math.max(0, (clampedHeight - clusterHeight) / 2);

  const tops: number[] = [];
  for (let i = 0; i < count; i++) {
    tops.push(Math.min(clampedHeight, start + i * gap));
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
