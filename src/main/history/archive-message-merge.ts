/**
 * Keep earlier archived messages when a thread is re-archived.
 *
 * `archiveInstance` replaces every history entry on the instance's thread with
 * one built from the live instance. That is lossless only when the instance
 * still holds the whole transcript, as a native restore does. A crash-recovery
 * revival can be seeded from a stale, trimmed continuity state instead: on
 * 2026-10-08 a revived instance holding 1,000 messages replaced a 19,398-message
 * entry and the rest of the conversation was deleted.
 *
 * So for a crash revival only (`metadata.continuityRevival`), every message of
 * a previous archive the new transcript provably descends from and lacks is
 * carried forward. Descent means at least one non-notice message in common, by
 * id or as a renumbered copy: wake gives every buffered message a fresh id
 * (`wake-buffer-restore.ts`), so a hibernated revival may share no id at all. Every other archive keeps
 * replacing, deliberately: edit-and-resend forks share the source's thread and
 * message ids but must drop the discarded branch (forks shed the revival
 * marker, see `instance-persistence.ts`), and a superseded generation must not
 * absorb its successor's messages. An archive with no message in common is a
 * different runtime generation re-materialised under new ids and times, and
 * stays replaced too.
 *
 * An archived message is already present when the new transcript holds the same
 * id, or a renumbered copy of it (same type, timestamp and content; see
 * `prompt-retention.ts`). Continuity stores `error` and `tool_outcome` as
 * `system`, so a woken copy is compared with those types folded together. Each live message stands in for at most one archived
 * message: parallel tool calls share type, millisecond and content, so a
 * looser match would collapse them. Restore notices and legacy redaction
 * placeholders are not carried: restore filters both out of a transcript, and
 * it adds a fresh notice every cycle that history readers would find first.
 */

import { getLogger } from '../logging/logger';
import type { ConversationData, ConversationHistoryEntry } from '../../shared/types/history.types';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import { isLegacyRedactedToolOutput } from '../session/redacted-tool-output';
import { isRestoreInfrastructureMessage } from './history-restore-helpers';

const logger = getLogger('ArchiveMessageMerge');

type ConversationLoader = (entryId: string) => Promise<ConversationData | null>;

/**
 * Share one read of each archive between the coverage check and the merge, so
 * a re-archive parses a large previous archive once.
 */
export function memoizeConversationLoads(load: ConversationLoader): ConversationLoader {
  const loads = new Map<string, Promise<ConversationData | null>>();
  return (entryId) => {
    let pending = loads.get(entryId);
    if (!pending) {
      pending = load(entryId);
      loads.set(entryId, pending);
    }
    return pending;
  };
}

export async function mergePreviouslyArchivedMessages(
  instance: Pick<Instance, 'metadata' | 'status'>,
  messages: OutputMessage[],
  previousEntries: readonly ConversationHistoryEntry[],
  loadConversation: ConversationLoader,
): Promise<OutputMessage[]> {
  if (instance.metadata?.['continuityRevival'] !== true || instance.status === 'superseded') {
    return messages;
  }
  if (previousEntries.length === 0) return messages;

  const liveById = new Map(messages.map((message) => [message.id, message]));
  const transcriptIds = new Set(liveById.keys());
  const carriedIds = new Set<string>();
  const liveByTimestamp = groupByTimestamp(messages);
  // Live messages not yet used to stand in for a renumbered archived copy.
  const unmatchedLiveByTimestamp = groupByTimestamp(messages);
  const isSameMessage = (a: OutputMessage, b: OutputMessage) =>
    continuityType(a) === continuityType(b) && a.content === b.content;
  const descendsFrom = (archived: readonly OutputMessage[]) => archived.some((message) =>
    !isRestoreInfrastructureMessage(message)
    && (transcriptIds.has(message.id)
      || (liveByTimestamp.get(message.timestamp)?.some(
        (live) => !isRestoreInfrastructureMessage(live) && isSameMessage(live, message),
      ) ?? false)));
  const takeLive = (timestamp: number, matches: (live: OutputMessage) => boolean): boolean => {
    const sameTime = unmatchedLiveByTimestamp.get(timestamp);
    const index = sameTime?.findIndex(matches) ?? -1;
    if (index < 0) return false;
    sameTime!.splice(index, 1);
    return true;
  };

  const carried: OutputMessage[] = [];
  for (const entry of previousEntries) {
    let conversation: ConversationData | null;
    try {
      conversation = await loadConversation(entry.id);
    } catch (error) {
      logger.warn('Could not read previous archive while re-archiving', {
        entryId: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    const previousMessages = (conversation?.messages ?? []).filter(
      (message): message is OutputMessage => Boolean(message)
        && typeof message.id === 'string'
        && typeof message.content === 'string',
    );
    if (!descendsFrom(previousMessages)) continue;
    // A live message archived under its own id is accounted for, so it must not
    // also stand in for a different archived message.
    for (const message of previousMessages) {
      const live = liveById.get(message.id);
      if (live) takeLive(live.timestamp, (candidate) => candidate === live);
    }
    for (const message of previousMessages) {
      if (transcriptIds.has(message.id) || carriedIds.has(message.id)) continue;
      if (isRestoreInfrastructureMessage(message) || isLegacyRedactedToolOutput(message.content)) continue;
      if (takeLive(message.timestamp, (live) => isSameMessage(live, message))) continue;
      carriedIds.add(message.id);
      carried.push(message);
    }
  }
  if (carried.length === 0) return messages;

  logger.info('Kept previously archived messages missing from the re-archived transcript', {
    carriedMessages: carried.length,
    transcriptMessages: messages.length,
    previousEntries: previousEntries.length,
  });
  // Stable sort: on equal timestamps earlier archives stay ahead of new messages.
  return [...carried, ...messages].sort((a, b) => a.timestamp - b.timestamp);
}

function groupByTimestamp(messages: readonly OutputMessage[]): Map<number, OutputMessage[]> {
  const byTimestamp = new Map<number, OutputMessage[]>();
  for (const message of messages) {
    const sameTime = byTimestamp.get(message.timestamp);
    if (sameTime) sameTime.push(message);
    else byTimestamp.set(message.timestamp, [message]);
  }
  return byTimestamp;
}

/** The type a message keeps through the continuity state (see `continuity-message-projection.ts`). */
function continuityType(message: OutputMessage): OutputMessage['type'] {
  return message.type === 'error' || message.type === 'tool_outcome' ? 'system' : message.type;
}
