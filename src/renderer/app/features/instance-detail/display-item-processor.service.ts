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
  type: 'message' | 'tool-group' | 'thought-group' | 'work-cycle' | 'system-event-group';
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
  /** When type === 'work-cycle', the wrapped child items (thoughts/tools/errors). */
  children?: DisplayItem[];
  /** Non-empty orchestration system messages that make up this group. */
  systemEvents?: OutputMessage[];
  /** Shared orchestration action for a grouped run, e.g. 'get_children'. */
  groupAction?: string;
  /** Friendly label shown in the collapsed header. */
  groupLabel?: string;
  /** Single-line preview derived from the latest grouped event. */
  groupPreview?: string;
}

const TIME_GAP_THRESHOLD = 2 * 60 * 1000; // 2 minutes
const SYSTEM_GROUP_TIME_GAP_MS = 5 * 60 * 1000; // 5 minutes
const SYSTEM_GROUP_PREVIEW_MAX_LEN = 120;
const ALWAYS_VISIBLE_SYSTEM_ACTIONS: ReadonlySet<string> = new Set([
  'task_complete',
  'task_error',
  'child_completed',
  'all_children_completed',
  'request_user_action',
  'user_action_response',
  'unknown',
]);
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

export function resolveSystemActionLabel(action: string): string {
  const knownLabel = SYSTEM_ACTION_LABELS[action];
  if (knownLabel) return knownLabel;

  const humanized = action.replace(/_/g, ' ').trim();
  if (!humanized) return 'System event';
  return humanized.charAt(0).toUpperCase() + humanized.slice(1);
}

export function buildSystemGroupPreview(content: string): string {
  if (!content) return '';

  const cleaned = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/^\s*[-*#>]+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length <= SYSTEM_GROUP_PREVIEW_MAX_LEN) return cleaned;
  return `${cleaned.slice(0, SYSTEM_GROUP_PREVIEW_MAX_LEN - 3).trimEnd()}...`;
}

export class DisplayItemProcessor {
  private lastProcessedCount = 0;
  private items: DisplayItem[] = [];
  private lastInstanceId: string | null = null;
  private lastHistoryOffset = 0;
  private firstMessageId: string | null = null;
  private seenStreamingIds = new Set<string>();
  private processedMessageRefs: readonly OutputMessage[] = [];
  private _newItemCount = 0;

  process(
    messages: readonly OutputMessage[],
    instanceId?: string,
    historyOffset = 0,
  ): DisplayItem[] {
    // Detect instance switch, buffer shrink, or prepend (first message ID changed)
    const currentFirstId = messages.length > 0 ? messages[0].id : null;
    const processedMessagesChanged = this.haveProcessedMessagesChanged(messages);
    if (
      instanceId !== this.lastInstanceId ||
      historyOffset !== this.lastHistoryOffset ||
      messages.length < this.lastProcessedCount ||
      (currentFirstId !== null && currentFirstId !== this.firstMessageId) ||
      processedMessagesChanged
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
    this.processedMessageRefs = messages.slice();

    return this.wrapForDisplay();
  }

  /** Flat internal item list. Consumers use this for incremental markdown rendering
   *  since wrapped work-cycles share the same child object references. */
  get flatItems(): readonly DisplayItem[] {
    return this.items;
  }

  reset(): void {
    this.items = [];
    this.lastProcessedCount = 0;
    this.lastHistoryOffset = 0;
    this.seenStreamingIds.clear();
    this.processedMessageRefs = [];
    // Reset newItemCount too: if reset is followed by an early-return
    // (messages.length === lastProcessedCount === 0), process() skips the
    // recompute path and consumers would otherwise see a stale count from
    // the previous instance, yielding a negative startIdx.
    this._newItemCount = 0;
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
          response: this.hasStandaloneAssistantContent(msg) ? undefined : msg,
          timestamp: msg.timestamp,
          bufferIndex,
        });
        if (this.hasStandaloneAssistantContent(msg)) {
          items.push({
            id: `msg-${msg.id}`,
            type: 'message',
            message: msg,
            bufferIndex,
          });
        }
      } else {
        items.push({ id: `msg-${msg.id}`, type: 'message', message: msg, bufferIndex });
      }
    }

    return items;
  }

  private haveProcessedMessagesChanged(messages: readonly OutputMessage[]): boolean {
    if (this.lastProcessedCount === 0) {
      return false;
    }

    const processedCount = Math.min(this.lastProcessedCount, messages.length);
    for (let i = 0; i < processedCount; i++) {
      if (messages[i] !== this.processedMessageRefs[i]) {
        return true;
      }
    }

    return false;
  }

  private hasStandaloneAssistantContent(message: OutputMessage): boolean {
    return Boolean(
      message.content?.trim()
      || (message.attachments && message.attachments.length > 0),
    );
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

      if (
        item.type === 'message' &&
        item.message?.type === 'system' &&
        this.isGroupableOrchestration(item.message)
      ) {
        const action = this.getOrchestrationAction(item.message)!;
        const candidateIdx = this.findLastNonEmptyItemIndex();
        const candidate = candidateIdx >= 0 ? this.items[candidateIdx] : undefined;

        if (
          candidate?.type === 'system-event-group' &&
          candidate.groupAction === action &&
          this.withinSystemGroupGap(candidate, item.message)
        ) {
          this.dropTrailingEmptyMessages(candidateIdx);
          this.appendToSystemGroup(candidate, item.message, item.bufferIndex);
          continue;
        }

        if (
          candidate?.type === 'message' &&
          candidate.message?.type === 'system' &&
          this.isGroupableOrchestration(candidate.message) &&
          this.getOrchestrationAction(candidate.message) === action &&
          item.message.timestamp - candidate.message.timestamp <= SYSTEM_GROUP_TIME_GAP_MS
        ) {
          this.dropTrailingEmptyMessages(candidateIdx);
          this.promoteToSystemGroup(candidateIdx, candidate.message, item.message, item.bufferIndex);
          continue;
        }
      }

      this.items.push(item);
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
    if (item.type === 'thought-group') return null;
    if (item.type === 'tool-group') return 'tool';
    if (item.type === 'system-event-group') return 'system';
    return null;
  }

  private getItemTimestamp(item: DisplayItem): number | null {
    if (item.timestamp) return item.timestamp;
    if (item.type === 'message' && item.message) return item.message.timestamp;
    if (item.response) return item.response.timestamp;
    if (item.type === 'tool-group' && item.toolMessages?.[0]) return item.toolMessages[0].timestamp;
    return null;
  }

  /** True if an item represents background "work" (thinking, tool calls, errors)
   *  rather than a conversational turn. Runs of these items are what we wrap
   *  into a single collapsible work-cycle card. */
  private isWorkItem(item: DisplayItem): boolean {
    if (item.type === 'thought-group' || item.type === 'tool-group') return true;
    if (item.type === 'message' && item.message) {
      const t = item.message.type;
      if (t === 'error' || t === 'tool_use' || t === 'tool_result') return true;
    }
    return false;
  }

  private getOrchestrationAction(message: OutputMessage): string | null {
    const action = message.metadata?.['action'];
    return typeof action === 'string' && action.length > 0 ? action : null;
  }

  private isGroupableOrchestration(message: OutputMessage): boolean {
    if ((message.metadata?.['source'] as string | undefined) !== 'orchestration') {
      return false;
    }
    if (!message.content.trim()) {
      return false;
    }

    const action = this.getOrchestrationAction(message);
    if (!action) {
      return false;
    }

    return !ALWAYS_VISIBLE_SYSTEM_ACTIONS.has(action);
  }

  private withinSystemGroupGap(group: DisplayItem, nextMessage: OutputMessage): boolean {
    const lastEvent = group.systemEvents?.[group.systemEvents.length - 1];
    if (!lastEvent) {
      return true;
    }

    return nextMessage.timestamp - lastEvent.timestamp <= SYSTEM_GROUP_TIME_GAP_MS;
  }

  private appendToSystemGroup(group: DisplayItem, message: OutputMessage, bufferIndex?: number): void {
    group.systemEvents = [...(group.systemEvents ?? []), message];
    group.groupPreview = buildSystemGroupPreview(message.content);
    group.timestamp = message.timestamp;
    group.bufferIndex = bufferIndex ?? group.bufferIndex;
  }

  private promoteToSystemGroup(
    indexToReplace: number,
    firstMessage: OutputMessage,
    secondMessage: OutputMessage,
    bufferIndex?: number,
  ): void {
    const action = this.getOrchestrationAction(firstMessage) ?? 'unknown';

    this.items[indexToReplace] = {
      id: `sysgrp-${firstMessage.id}`,
      type: 'system-event-group',
      systemEvents: [firstMessage, secondMessage],
      groupAction: action,
      groupLabel: resolveSystemActionLabel(action),
      groupPreview: buildSystemGroupPreview(secondMessage.content),
      timestamp: secondMessage.timestamp,
      bufferIndex,
    };
  }

  private findLastNonEmptyItemIndex(): number {
    for (let index = this.items.length - 1; index >= 0; index--) {
      const item = this.items[index];
      if (item.type !== 'message') {
        return index;
      }

      if ((item.message?.content ?? '').trim().length > 0) {
        return index;
      }
    }

    return -1;
  }

  private dropTrailingEmptyMessages(downToIndex: number): void {
    while (this.items.length - 1 > downToIndex) {
      const tail = this.items[this.items.length - 1];
      if (tail.type !== 'message') {
        break;
      }

      if ((tail.message?.content ?? '').trim().length > 0) {
        break;
      }

      this.items.pop();
    }
  }

  /** Wrap consecutive runs of work-items into a single work-cycle item.
   *  Runs of length 1 are left as-is. The trailing run is not wrapped while
   *  it may still be growing (no conversational item follows), so the user
   *  can watch live progress during a streaming turn. */
  private wrapForDisplay(): DisplayItem[] {
    const src = this.items;
    const out: DisplayItem[] = [];
    let i = 0;
    while (i < src.length) {
      if (!this.isWorkItem(src[i])) {
        out.push(src[i]);
        i++;
        continue;
      }
      let j = i;
      while (j < src.length && this.isWorkItem(src[j])) j++;
      const runLength = j - i;
      const runExtendsToEnd = j === src.length;
      // Only wrap a run of length >= 2 that's followed by a conversational item.
      // An unterminated trailing run stays flat so live streaming stays visible.
      if (runLength >= 2 && !runExtendsToEnd) {
        const children = src.slice(i, j);
        const firstTs = this.getItemTimestamp(children[0]) ?? 0;
        out.push({
          id: `cycle-${children[0].id}`,
          type: 'work-cycle',
          children,
          timestamp: firstTs,
        });
      } else {
        for (let k = i; k < j; k++) out.push(src[k]);
      }
      i = j;
    }
    return out;
  }
}
