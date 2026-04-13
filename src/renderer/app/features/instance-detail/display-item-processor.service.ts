/**
 * Display Item Processor — incremental message-to-display-item transformation.
 *
 * Replaces the 5-pass O(n) recomputation in displayItems() with incremental
 * append-only processing. Only new messages (since last process call) are
 * transformed; previously computed items are reused.
 */

import type { OutputMessage } from '../../core/state/instance/instance.types';
import type { ThinkingContent } from '../../../../shared/types/instance.types';

export interface DisplayItem {
  id: string;
  type: 'message' | 'tool-group' | 'thought-group' | 'system-event-group';
  message?: OutputMessage;
  renderedMessage?: unknown;  // SafeHtml at runtime, set by consuming component
  toolMessages?: OutputMessage[];
  thinking?: ThinkingContent[];
  thoughts?: string[];
  response?: OutputMessage;
  renderedResponse?: unknown;  // SafeHtml at runtime, set by consuming component
  timestamp?: number;
  repeatCount?: number;
  showHeader?: boolean;
  bufferIndex?: number;
  // ── system-event-group fields ──
  /** Non-empty orchestration messages that make up this group, in chronological order. */
  systemEvents?: OutputMessage[];
  /** The shared `metadata.action` value, e.g. `'get_children'`. */
  groupAction?: string;
  /** Friendly label resolved from `groupAction`, e.g. `'Active children polled'`. */
  groupLabel?: string;
  /** Single-line preview derived from the latest event's content, truncated for the header. */
  groupPreview?: string;
}

const TIME_GAP_THRESHOLD = 2 * 60 * 1000; // 2 minutes

/**
 * Maximum wall-clock gap allowed between consecutive members of a
 * system-event-group. A new accordion is started after this much idle.
 */
const SYSTEM_GROUP_TIME_GAP_MS = 5 * 60 * 1000;

/**
 * Orchestration `metadata.action` values that must always render as their own
 * standalone system bubble — never absorbed into a system-event-group.
 *
 * These are state-changing events the user needs to see immediately; bucketing
 * them under an accordion would hide important signal.
 */
const ALWAYS_VISIBLE_SYSTEM_ACTIONS: ReadonlySet<string> = new Set([
  'task_complete',
  'task_error',
  'child_completed',
  'all_children_completed',
  'request_user_action',
  'user_action_response',
  'unknown',
]);

/**
 * Friendly labels for grouped orchestration actions. Anything not listed falls
 * back to humanising the action name (snake_case → Sentence case).
 */
const SYSTEM_ACTION_LABELS: Readonly<Record<string, string>> = {
  get_children: 'Active children polled',
  get_child_output: 'Child output fetched',
  get_child_summary: 'Child summary fetched',
  get_child_artifacts: 'Child artifacts fetched',
  get_child_section: 'Child section fetched',
  task_progress: 'Task progress',
  call_tool: 'Tool calls',
  message_child: 'Messages to children',
  spawn_child: 'Child spawned',
  terminate_child: 'Children terminated',
};

/**
 * Maximum length of the single-line preview rendered in the collapsed header.
 * Longer previews are truncated with an ellipsis.
 */
const SYSTEM_GROUP_PREVIEW_MAX_LEN = 120;

/**
 * Resolve the friendly label for an orchestration action. Falls back to a
 * humanised version of the snake_case action name.
 */
export function resolveSystemActionLabel(action: string): string {
  const known = SYSTEM_ACTION_LABELS[action];
  if (known) return known;
  // Humanise: replace underscores with spaces, capitalise the first letter only.
  const spaced = action.replace(/_/g, ' ').replace(/ +/g, ' ').trim();
  if (!spaced) return 'System event';
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Reduce a markdown message to a single line suitable for an accordion header:
 * strip common markdown emphasis markers, collapse whitespace, truncate.
 */
export function buildSystemGroupPreview(content: string): string {
  if (!content) return '';
  const stripped = content
    // Drop fenced code blocks entirely.
    .replace(/```[\s\S]*?```/g, ' ')
    // Strip inline code backticks but keep contents.
    .replace(/`([^`]*)`/g, '$1')
    // Strip *bold* / **bold** / ***bold*** (asterisk emphasis is unambiguous).
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
    // Strip _italic_ etc. only when not flanked by word chars (avoids eating
    // underscores inside snake_case identifiers like `task_complete`).
    .replace(/(?<!\w)_{1,3}([^_]+)_{1,3}(?!\w)/g, '$1')
    // Strip leading list/heading markers on each line.
    .replace(/^\s*[-*#>]+\s*/gm, '')
    // Collapse all whitespace (including newlines) to single spaces.
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped.length <= SYSTEM_GROUP_PREVIEW_MAX_LEN) return stripped;
  return stripped.slice(0, SYSTEM_GROUP_PREVIEW_MAX_LEN - 1).trimEnd() + '…';
}

export class DisplayItemProcessor {
  private lastProcessedCount = 0;
  private items: DisplayItem[] = [];
  private lastInstanceId: string | null = null;
  private lastHistoryOffset = 0;
  private firstMessageId: string | null = null;
  private seenStreamingIds = new Set<string>();
  private _newItemCount = 0;

  process(
    messages: readonly OutputMessage[],
    instanceId?: string,
    historyOffset = 0,
  ): DisplayItem[] {
    // Detect instance switch, buffer shrink, or prepend (first message ID changed)
    const currentFirstId = messages.length > 0 ? messages[0].id : null;
    if (
      instanceId !== this.lastInstanceId ||
      historyOffset !== this.lastHistoryOffset ||
      messages.length < this.lastProcessedCount ||
      (currentFirstId !== null && currentFirstId !== this.firstMessageId)
    ) {
      this.reset();
      this.lastInstanceId = instanceId ?? null;
    }
    this.lastHistoryOffset = historyOffset;
    this.firstMessageId = currentFirstId;

    if (messages.length === this.lastProcessedCount) {
      return this.items;
    }

    const newMessages = messages.slice(this.lastProcessedCount);
    const bufferOffset = historyOffset + this.lastProcessedCount;
    this.lastProcessedCount = messages.length;

    const rawItems = this.convertToItems(newMessages, bufferOffset);

    const prevLength = this.items.length;
    this.mergeNewItems(rawItems);
    this._newItemCount = this.items.length - prevLength;

    this.computeHeaders();

    return this._newItemCount > 0 ? [...this.items] : this.items;
  }

  reset(): void {
    this.items = [];
    this.lastProcessedCount = 0;
    this.lastHistoryOffset = 0;
    this.seenStreamingIds.clear();
  }

  get newItemCount(): number {
    return this._newItemCount;
  }

  private convertToItems(messages: readonly OutputMessage[], bufferOffset: number): DisplayItem[] {
    const items: DisplayItem[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const bufferIndex = bufferOffset + i;
      const isStreaming =
        msg.metadata != null &&
        'streaming' in msg.metadata &&
        msg.metadata['streaming'] === true;

      if (isStreaming) {
        if (this.seenStreamingIds.has(msg.id)) {
          const existingIdx = items.findIndex(
            item => item.type === 'message' && item.message?.id === msg.id,
          );
          const target = existingIdx >= 0 ? items : this.items;
          const targetIdx =
            existingIdx >= 0
              ? existingIdx
              : this.items.findIndex(
                  item => item.type === 'message' && item.message?.id === msg.id,
                );
          if (targetIdx >= 0 && target[targetIdx]?.message) {
            const accumulatedContent =
              msg.metadata != null && 'accumulatedContent' in msg.metadata
                ? String(msg.metadata['accumulatedContent'])
                : msg.content;
            target[targetIdx] = {
              ...target[targetIdx],
              message: { ...target[targetIdx].message!, content: accumulatedContent },
            };
          }
          continue;
        }
        this.seenStreamingIds.add(msg.id);
        const displayContent =
          msg.metadata != null && 'accumulatedContent' in msg.metadata
            ? String(msg.metadata['accumulatedContent'])
            : msg.content;
        items.push({
          id: `stream-${msg.id}`,
          type: 'message',
          message: { ...msg, content: displayContent },
          bufferIndex,
        });
      } else if (msg.thinking && msg.thinking.length > 0 && msg.type === 'assistant') {
        items.push({
          id: `thought-${msg.id}`,
          type: 'thought-group',
          thinking: msg.thinking,
          thoughts: msg.thinking.map(t => t.content),
          response: msg,
          timestamp: msg.timestamp,
          bufferIndex,
        });
      } else {
        items.push({ id: `msg-${msg.id}`, type: 'message', message: msg, bufferIndex });
      }
    }

    return items;
  }

  private mergeNewItems(newItems: DisplayItem[]): void {
    for (const item of newItems) {
      const last = this.items[this.items.length - 1];

      if (
        item.type === 'message' &&
        item.message &&
        (item.message.type === 'tool_use' || item.message.type === 'tool_result')
      ) {
        if (last?.type === 'tool-group' && last.toolMessages) {
          last.toolMessages.push(item.message);
          continue;
        }
        if (
          last?.type === 'message' &&
          last.message &&
          (last.message.type === 'tool_use' || last.message.type === 'tool_result')
        ) {
          const group: DisplayItem = {
            id: `tools-${last.message.id}`,
            type: 'tool-group',
            toolMessages: [last.message, item.message],
            timestamp: last.message.timestamp,
          };
          this.items[this.items.length - 1] = group;
          continue;
        }
        // Single tool message — wrap in a collapsible tool-group
        this.items.push({
          id: `tools-${item.message.id}`,
          type: 'tool-group',
          toolMessages: [item.message],
          timestamp: item.message.timestamp,
        });
        continue;
      }

      // Collapse consecutive identical messages — but never system messages.
      // System notices (restore warnings, compaction boundaries, etc.) should
      // always appear individually so they aren't mistaken for duplicated noise.
      if (
        item.type === 'message' &&
        last?.type === 'message' &&
        item.message &&
        last.message &&
        item.message.type !== 'system' &&
        item.message.type === last.message.type &&
        item.message.content === last.message.content
      ) {
        last.repeatCount = (last.repeatCount ?? 1) + 1;
        last.bufferIndex = item.bufferIndex;
        continue;
      }

      // Orchestration system-event grouping — collapse runs of repetitive
      // orchestration messages with the same `metadata.action` into an
      // accordion display item. Empty assistant turns between members are
      // absorbed (removed) so they don't break the run.
      if (
        item.type === 'message' &&
        item.message?.type === 'system' &&
        this.isGroupableOrchestration(item.message)
      ) {
        const action = (item.message.metadata as { action: string }).action;
        const candidateIdx = this.findLastNonEmptyItemIndex();
        const candidate = candidateIdx >= 0 ? this.items[candidateIdx] : undefined;

        if (
          candidate?.type === 'system-event-group' &&
          candidate.groupAction === action &&
          this.withinSystemGroupGap(candidate, item.message)
        ) {
          this.dropTrailingEmptyMessages(candidateIdx);
          this.appendToSystemGroup(candidate, item.message);
          continue;
        }

        if (
          candidate?.type === 'message' &&
          candidate.message?.type === 'system' &&
          this.isGroupableOrchestration(candidate.message) &&
          (candidate.message.metadata as { action: string }).action === action &&
          item.message.timestamp - candidate.message.timestamp <= SYSTEM_GROUP_TIME_GAP_MS
        ) {
          this.dropTrailingEmptyMessages(candidateIdx);
          this.promoteToSystemGroup(candidateIdx, candidate.message, item.message);
          continue;
        }
      }

      this.items.push(item);
    }
  }

  private isGroupableOrchestration(msg: OutputMessage): boolean {
    const meta = msg.metadata as { source?: unknown; action?: unknown } | undefined;
    if (!meta || meta.source !== 'orchestration') return false;
    const action = meta.action;
    if (typeof action !== 'string' || !action) return false;
    return !ALWAYS_VISIBLE_SYSTEM_ACTIONS.has(action);
  }

  private withinSystemGroupGap(group: DisplayItem, next: OutputMessage): boolean {
    const events = group.systemEvents;
    if (!events || events.length === 0) return true;
    const last = events[events.length - 1];
    return next.timestamp - last.timestamp <= SYSTEM_GROUP_TIME_GAP_MS;
  }

  private appendToSystemGroup(group: DisplayItem, msg: OutputMessage): void {
    if (!group.systemEvents) group.systemEvents = [];
    group.systemEvents.push(msg);
    group.groupPreview = buildSystemGroupPreview(msg.content);
    group.timestamp = msg.timestamp;
    // bufferIndex tracking for groups is approximate — the latest member's
    // index isn't strictly needed; this keeps the field defined for any
    // downstream consumer that reads it.
    group.bufferIndex = (group.bufferIndex ?? 0) + 1;
  }

  private promoteToSystemGroup(
    indexToReplace: number,
    first: OutputMessage,
    second: OutputMessage,
  ): void {
    const action = (first.metadata as { action: string }).action;
    const group: DisplayItem = {
      id: `sysgrp-${first.id}`,
      type: 'system-event-group',
      systemEvents: [first, second],
      groupAction: action,
      groupLabel: resolveSystemActionLabel(action),
      groupPreview: buildSystemGroupPreview(second.content),
      timestamp: second.timestamp,
      bufferIndex: this.items[indexToReplace].bufferIndex,
    };
    this.items[indexToReplace] = group;
  }

  /**
   * Walk `this.items` backwards, returning the index of the last item that
   * either isn't a `'message'` display item or whose message has non-empty
   * trimmed content. Returns -1 if no such item exists.
   *
   * Used by the system-event grouping pass to look past empty assistant turns
   * (which are noise emitted between orchestration polls) when deciding
   * whether the new message extends an existing run.
   */
  private findLastNonEmptyItemIndex(): number {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.type !== 'message') return i;
      const content = it.message?.content ?? '';
      if (content.trim().length > 0) return i;
    }
    return -1;
  }

  /**
   * Remove any trailing empty `'message'` display items (assistant turns whose
   * content trims to nothing). Called when an orchestration message is about
   * to extend a group — those empties belong in the group, not floating
   * outside it.
   */
  private dropTrailingEmptyMessages(downToIndex: number): void {
    while (this.items.length - 1 > downToIndex) {
      const tail = this.items[this.items.length - 1];
      if (tail.type !== 'message') break;
      const content = tail.message?.content ?? '';
      if (content.trim().length > 0) break;
      this.items.pop();
    }
  }

  private computeHeaders(): void {
    const startIdx = Math.max(0, this.items.length - 20);
    for (let i = startIdx; i < this.items.length; i++) {
      const item = this.items[i];
      const prev = i > 0 ? this.items[i - 1] : undefined;

      item.showHeader = true;
      if (!prev) continue;

      const curSender = this.getItemSenderType(item);
      const prevSender = this.getItemSenderType(prev);

      if (curSender && prevSender && curSender === prevSender) {
        const curTime = this.getItemTimestamp(item);
        const prevTime = this.getItemTimestamp(prev);
        if (curTime && prevTime && curTime - prevTime < TIME_GAP_THRESHOLD) {
          item.showHeader = false;
        }
      }
    }
  }

  private getItemSenderType(item: DisplayItem): string | null {
    if (item.type === 'message' && item.message) return item.message.type;
    if (item.type === 'thought-group') return 'assistant';
    if (item.type === 'tool-group') return 'tool';
    return null;
  }

  private getItemTimestamp(item: DisplayItem): number | null {
    if (item.timestamp) return item.timestamp;
    if (item.type === 'message' && item.message) return item.message.timestamp;
    if (item.response) return item.response.timestamp;
    if (item.type === 'tool-group' && item.toolMessages?.[0]) return item.toolMessages[0].timestamp;
    return null;
  }
}
