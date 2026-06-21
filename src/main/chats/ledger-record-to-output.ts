import type { ConversationMessageRecord } from '../../shared/types/conversation-ledger.types';
import type { OutputMessage } from '../../shared/types/instance.types';

/**
 * Convert a ledger `ConversationMessageRecord` to the `OutputMessage` shape
 * expected by `buildReplayContinuityMessage` and related transcript utilities.
 *
 * Mirrors the renderer-side conversion in `chat-detail.component.ts`
 * (`buildOutputMessage`) so the model receives the same shaped data whether
 * context is rebuilt in the main process or replayed from history.
 */
export function ledgerRecordToOutputMessage(record: ConversationMessageRecord): OutputMessage {
  const rawJson = record.rawJson as Record<string, unknown> | null;
  const rawMetadata = rawJson?.['metadata'] as Record<string, unknown> | undefined;

  return {
    id: record.nativeMessageId ?? record.id,
    timestamp: record.createdAt,
    type: toOutputMessageType(record, rawMetadata),
    content: record.content,
    metadata: {
      ...(rawMetadata ?? {}),
      ledgerMessageId: record.id,
      ledgerSequence: record.sequence,
      nativeTurnId: record.nativeTurnId,
      phase: record.phase,
    },
  };
}

export function ledgerRecordsToOutputMessages(
  records: ConversationMessageRecord[],
): OutputMessage[] {
  return records.map(ledgerRecordToOutputMessage);
}

function toOutputMessageType(
  record: ConversationMessageRecord,
  metadata: Record<string, unknown> | undefined,
): OutputMessage['type'] {
  if (record.role === 'user') return 'user';
  if (record.role === 'system' || record.role === 'event') return 'system';
  if (record.phase === 'error' || metadata?.['kind'] === 'error') return 'error';
  if (record.role === 'tool') {
    return record.phase === 'tool_result' || metadata?.['kind'] === 'tool_result'
      ? 'tool_result'
      : 'tool_use';
  }
  return 'assistant';
}
