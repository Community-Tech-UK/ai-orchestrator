/**
 * Maps ledger `ConversationMessageRecord`s to renderer `OutputMessage`s for
 * chat surfaces (chat-detail, side-chat panel).
 *
 * Memoizes by record identity: the chat store preserves prior record
 * identities across incremental transcript updates, so this mapper returns
 * stable `OutputMessage` references for unchanged messages. That keeps the
 * output stream's incremental `DisplayItemProcessor` (which compares by
 * reference) on its fast path — only newly-appended messages are reprocessed,
 * rather than the entire transcript being rebuilt on every provider event and
 * every streaming tick.
 *
 * Instantiate one mapper per component so caches don't outlive their surface
 * (the WeakMap keeps this safe either way).
 */

import type { ConversationMessageRecord } from '../../../../shared/types/conversation-ledger.types';
import type { FileAttachment, OutputMessage, ThinkingContent } from '../../../../shared/types/instance.types';

export class ChatOutputMessageMapper {
  private readonly cache = new WeakMap<ConversationMessageRecord, OutputMessage>();

  toOutputMessage(message: ConversationMessageRecord): OutputMessage {
    const cached = this.cache.get(message);
    if (cached) {
      return cached;
    }
    const built = this.buildOutputMessage(message);
    this.cache.set(message, built);
    return built;
  }

  private buildOutputMessage(message: ConversationMessageRecord): OutputMessage {
    const rawJson = this.asRecord(message.rawJson);
    const rawMetadata = this.asRecord(rawJson?.['metadata']);
    const type = this.toOutputMessageType(message, rawMetadata);
    const metadata = {
      ...(rawMetadata ?? {}),
      ledgerMessageId: message.id,
      ledgerSequence: message.sequence,
      nativeTurnId: message.nativeTurnId,
      phase: message.phase,
    };
    return {
      id: message.nativeMessageId ?? message.id,
      timestamp: message.createdAt,
      type,
      content: message.content,
      metadata,
      attachments: this.asAttachments(rawJson?.['attachments']),
      thinking: this.asThinking(rawJson?.['thinking']),
      thinkingExtracted: typeof rawJson?.['thinkingExtracted'] === 'boolean'
        ? rawJson['thinkingExtracted']
        : undefined,
    };
  }

  private toOutputMessageType(
    message: ConversationMessageRecord,
    metadata: Record<string, unknown> | null,
  ): OutputMessage['type'] {
    if (message.role === 'user') {
      return 'user';
    }
    if (message.role === 'system' || message.role === 'event') {
      return 'system';
    }
    if (message.phase === 'error' || metadata?.['kind'] === 'error') {
      return 'error';
    }
    if (message.role === 'tool') {
      return message.phase === 'tool_result' || metadata?.['kind'] === 'tool_result'
        ? 'tool_result'
        : 'tool_use';
    }
    return 'assistant';
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  private asAttachments(value: unknown): FileAttachment[] | undefined {
    return Array.isArray(value) ? value as FileAttachment[] : undefined;
  }

  private asThinking(value: unknown): ThinkingContent[] | undefined {
    return Array.isArray(value) ? value as ThinkingContent[] : undefined;
  }
}
