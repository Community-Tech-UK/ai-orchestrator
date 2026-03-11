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
  type: 'message' | 'tool-group' | 'thought-group';
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
}

const TIME_GAP_THRESHOLD = 2 * 60 * 1000; // 2 minutes

export class DisplayItemProcessor {
  private lastProcessedCount = 0;
  private items: DisplayItem[] = [];
  private lastInstanceId: string | null = null;
  private seenStreamingIds = new Set<string>();
  private _newItemCount = 0;

  process(messages: readonly OutputMessage[], instanceId?: string): DisplayItem[] {
    if (instanceId !== this.lastInstanceId || messages.length < this.lastProcessedCount) {
      this.reset();
      this.lastInstanceId = instanceId ?? null;
    }

    if (messages.length === this.lastProcessedCount) {
      return this.items;
    }

    const newMessages = messages.slice(this.lastProcessedCount);
    this.lastProcessedCount = messages.length;

    const rawItems = this.convertToItems(newMessages);

    const prevLength = this.items.length;
    this.mergeNewItems(rawItems);
    this._newItemCount = this.items.length - prevLength;

    this.computeHeaders();

    return this.items;
  }

  reset(): void {
    this.items = [];
    this.lastProcessedCount = 0;
    this.seenStreamingIds.clear();
  }

  get newItemCount(): number {
    return this._newItemCount;
  }

  private convertToItems(messages: readonly OutputMessage[]): DisplayItem[] {
    const items: DisplayItem[] = [];

    for (const msg of messages) {
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
        });
      } else if (msg.thinking && msg.thinking.length > 0 && msg.type === 'assistant') {
        items.push({
          id: `thought-${msg.id}`,
          type: 'thought-group',
          thinking: msg.thinking,
          thoughts: msg.thinking.map(t => t.content),
          response: msg,
          timestamp: msg.timestamp,
        });
      } else {
        items.push({ id: `msg-${msg.id}`, type: 'message', message: msg });
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
      }

      if (
        item.type === 'message' &&
        last?.type === 'message' &&
        item.message &&
        last.message &&
        item.message.type === last.message.type &&
        item.message.content === last.message.content
      ) {
        last.repeatCount = (last.repeatCount ?? 1) + 1;
        continue;
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
