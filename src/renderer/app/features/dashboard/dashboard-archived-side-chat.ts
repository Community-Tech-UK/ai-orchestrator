import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import type { SideChatParentRef } from '../../../../shared/types/side-chat.types';
import { sideChatParentSelectionFor } from '../side-chat/side-chat-parent';

/** Metadata for an archived panel, resolved before clearing the main selection. */
export function resolveArchivedSideChatContext(
  parent: Extract<SideChatParentRef, { kind: 'session' }>,
  preview: ConversationHistoryEntry | null,
  entries: ConversationHistoryEntry[],
  attentionTitle: string | null,
) {
  const entry = preview?.historyThreadId === parent.historyThreadId ? preview
    : entries.find((item) => item.historyThreadId === parent.historyThreadId) ?? null;
  return {
    parent,
    title: entry?.displayName ?? attentionTitle ?? 'Archived session',
    workingDirectory: entry?.workingDirectory ?? null,
    selection: sideChatParentSelectionFor(null, entry),
  };
}
