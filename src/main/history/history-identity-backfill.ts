import {
  inferConversationHistoryProvider,
  type ConversationHistoryEntry,
} from '../../shared/types/history.types';

export function isSameHistoryEntryForIdentityBackfill(
  indexedEntry: ConversationHistoryEntry,
  persistedEntry: ConversationHistoryEntry,
): boolean {
  const indexedId = indexedEntry.id.trim();
  const persistedId = persistedEntry.id.trim();
  const indexedSessionId = indexedEntry.sessionId.trim();
  const persistedSessionId = persistedEntry.sessionId.trim();
  return Boolean(
    indexedId
    && indexedId === persistedId
    && indexedSessionId
    && indexedSessionId === persistedSessionId
    && inferConversationHistoryProvider(indexedEntry)
      === inferConversationHistoryProvider(persistedEntry)
  );
}
