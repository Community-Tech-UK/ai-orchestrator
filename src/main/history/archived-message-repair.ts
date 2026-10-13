import type { ConversationData } from '../../shared/types/history.types';

/**
 * Give an archived message that is missing only its id or time a stable one.
 *
 * Coverage and recovery both refuse an archive holding a message without a
 * string id and a finite timestamp, so one such message made a whole saved
 * conversation look absent from History. Until 2026-10-13 Codex's native-retry
 * notices were emitted that way, and every archive containing one was offered
 * back as "not in history" on each start.
 *
 * Only messages that are otherwise readable (an object with string content) are
 * repaired. Anything else is left for the readers to reject as before, so a
 * genuinely damaged archive is still not trusted as coverage.
 *
 * The id is derived from the entry and position so every load agrees on it, and
 * the time is the previous message's (else the entry's start), which can never
 * move coverage later than the archive really reaches. Repairing does not write
 * the file, but any later save built from this load (re-archive, title, archive
 * flag, resume-failure mark, thread-id self-heal) keeps the repaired values.
 */
export function repairArchivedMessageIdentity(conversation: ConversationData | null): void {
  if (!conversation || !Array.isArray(conversation.messages)) return;
  const entryId = conversation.entry?.id;
  const createdAt = conversation.entry?.createdAt;
  let lastTimestamp = Number.isFinite(createdAt) ? createdAt : undefined;
  conversation.messages.forEach((message, index) => {
    if (!message || typeof message !== 'object' || typeof message.content !== 'string') return;
    if (Number.isFinite(message.timestamp)) {
      lastTimestamp = message.timestamp;
    } else if (lastTimestamp !== undefined) {
      message.timestamp = lastTimestamp;
    }
    if ((typeof message.id !== 'string' || message.id.length === 0) && typeof entryId === 'string') {
      message.id = `${entryId}:repaired:${index}`;
    }
  });
}
