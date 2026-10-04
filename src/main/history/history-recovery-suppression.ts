import type { ConversationHistoryEntry, HistoryIndex } from '../../shared/types/history.types';
import {
  RECOVERY_FALLBACK_WINDOW_MS,
  type HistoryRecoverySuppressionQuery,
} from '../session/session-recovery-candidate-service';

/**
 * Tombstone a History entry the user deleted.
 *
 * The sessionId tombstone stops the native-Claude transcript importer from
 * re-importing it from `~/.claude/projects/`. The timed thread tombstone stops
 * startup autosave recovery from copying the same conversation back in. Thread
 * tombstones older than the recovery window are pruned: no autosave that old is
 * ever offered, so they could never match.
 */
export function tombstoneDeletedHistoryEntry(
  index: HistoryIndex,
  entry: Pick<ConversationHistoryEntry, 'sessionId' | 'historyThreadId'>,
  now: number,
): void {
  const sessionId = entry.sessionId?.trim();
  if (sessionId) {
    index.deletedSessionIds = Array.from(new Set([...(index.deletedSessionIds ?? []), sessionId]));
  }

  const historyThreadId = entry.historyThreadId?.trim();
  if (!historyThreadId) return;
  const threads: Record<string, number> = {};
  for (const [threadId, deletedAt] of Object.entries(index.deletedHistoryThreads ?? {})) {
    if (Number.isFinite(deletedAt) && deletedAt > now - RECOVERY_FALLBACK_WINDOW_MS) {
      threads[threadId] = deletedAt;
    }
  }
  threads[historyThreadId] = now;
  index.deletedHistoryThreads = threads;
}

/**
 * Whether an autosave must stay out of History because the user removed it:
 * its thread was deleted after its last activity, its native session was
 * deleted, or History was cleared after its last activity.
 */
export function isRecoverySuppressedByHistory(
  index: Pick<HistoryIndex, 'deletedSessionIds' | 'deletedHistoryThreads' | 'recoverySuppressedThrough'>,
  query: HistoryRecoverySuppressionQuery,
): boolean {
  const clearedThrough = index.recoverySuppressedThrough;
  if (clearedThrough !== undefined && Number.isFinite(clearedThrough)
    && query.lastActivityAt <= clearedThrough) {
    return true;
  }

  const historyThreadId = query.historyThreadId?.trim();
  const deletedAt = historyThreadId ? index.deletedHistoryThreads?.[historyThreadId] : undefined;
  if (deletedAt !== undefined && Number.isFinite(deletedAt)) {
    // The timed tombstone is authoritative: work after the deletion is new.
    return query.lastActivityAt <= deletedAt;
  }

  // Untimed sessionId tombstones predate thread tombstones; honour them as-is.
  const sessionId = query.sessionId?.trim();
  return Boolean(sessionId && index.deletedSessionIds?.some((deleted) => deleted.trim() === sessionId));
}
