import type { ConversationData, ConversationHistoryEntry } from '../../shared/types/history.types';
import { inferConversationHistoryProvider } from '../../shared/types/history.types';
import type {
  HistoryRecoveryCoverage,
  RecoveryHistoryIdentity,
} from '../session/session-recovery-candidate-service';

export async function resolveHistoryRecoveryCoverage(
  entries: readonly ConversationHistoryEntry[],
  identities: readonly RecoveryHistoryIdentity[],
  loadConversation: (entryId: string) => Promise<ConversationData | null>,
): Promise<ReadonlyMap<string, HistoryRecoveryCoverage>> {
  const result = new Map<string, HistoryRecoveryCoverage>();
  for (const identity of identities) {
    const matching = entries.filter((entry) => entryMatchesIdentity(entry, identity));

    let best: HistoryRecoveryCoverage | undefined;
    for (const entry of matching) {
      let conversation: ConversationData | null;
      try {
        conversation = await loadConversation(entry.id);
      } catch {
        continue;
      }
      if (!isVerifiedConversation(entry, conversation, identity)) continue;

      const persistedEntry = conversation.entry;
      const provider = inferConversationHistoryProvider(persistedEntry);
      const lastMessageTimestamp = conversation.messages.reduce((latest, message) => (
        Number.isFinite(message?.timestamp) ? Math.max(latest, message.timestamp) : latest
      ), 0);
      const coverage: HistoryRecoveryCoverage = {
        recoveryKey: identity.recoveryKey,
        historyEntryId: persistedEntry.id,
        provider,
        historyThreadId: persistedEntry.historyThreadId?.trim() || undefined,
        sessionId: persistedEntry.sessionId?.trim() || undefined,
        coveredThrough: Math.max(
          Number.isFinite(persistedEntry.endedAt) ? persistedEntry.endedAt : 0,
          lastMessageTimestamp,
        ),
        messageCount: conversation.messages.length,
      };
      if (!best
        || coverage.coveredThrough > best.coveredThrough
        || (coverage.coveredThrough === best.coveredThrough
          && coverage.historyEntryId.localeCompare(best.historyEntryId) < 0)) {
        best = coverage;
      }
    }
    if (best) result.set(identity.recoveryKey, best);
  }
  return result;
}

function entryMatchesIdentity(
  entry: ConversationHistoryEntry,
  identity: RecoveryHistoryIdentity,
): boolean {
  if (inferConversationHistoryProvider(entry) !== identity.provider) return false;
  const historyThreadId = identity.historyThreadId?.trim();
  if (historyThreadId) return historyThreadId === entry.historyThreadId?.trim();
  const sessionId = identity.sessionId?.trim();
  return Boolean(sessionId && sessionId === entry.sessionId?.trim());
}

function isVerifiedConversation(
  indexedEntry: ConversationHistoryEntry,
  conversation: ConversationData | null,
  identity: RecoveryHistoryIdentity,
): conversation is ConversationData {
  return Boolean(
    conversation
    && conversation.entry
    && conversation.entry.id === indexedEntry.id
    && Number.isFinite(conversation.entry.endedAt)
    && Array.isArray(conversation.messages)
    && conversation.messages.every((message) => Boolean(
      message
      && typeof message.id === 'string'
      && typeof message.content === 'string'
      && Number.isFinite(message.timestamp)
      && ['assistant', 'user', 'system', 'tool_use', 'tool_result', 'error'].includes(message.type)
    ))
    && entryMatchesIdentity(conversation.entry, identity)
  );
}
