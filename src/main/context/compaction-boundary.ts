/**
 * Compaction Boundary — pure math for the manual "keep latest N exchanges"
 * boundary control (WS-B7). No I/O; safe to call from a read-only preview
 * and reused by the real restart-with-summary compaction cut so the two can
 * never disagree.
 *
 * Mirrors the cut logic in `ContextCompactor.compact()`:
 *   - `preserveRecent` turns (messages) are kept verbatim from the tail.
 *   - the single most recent user-role turn is always protected, even if it
 *     falls outside that tail window.
 * `repairOrphanedToolPairs` is intentionally NOT replicated here: the
 * manual-compaction turn feed (`instance.outputBuffer` filtered to
 * user/assistant) never carries `toolCalls`, so that pass is a no-op on
 * this path in practice.
 */

export interface CompactionTurnRole {
  role: 'user' | 'assistant';
}

export interface CompactionExchange {
  /** Index of the first turn in this exchange (inclusive). */
  startIndex: number;
  /** Index of the last turn in this exchange (inclusive). */
  endIndex: number;
  /** Number of turns (messages) in this exchange. */
  messageCount: number;
}

/**
 * Groups turns into "exchanges": a user turn followed by zero or more
 * assistant turns, up to (not including) the next user turn. Any leading
 * assistant-only turns before the first user turn form their own exchange
 * (defensive — real transcripts always start with a user turn).
 */
export function groupExchanges(turns: readonly CompactionTurnRole[]): CompactionExchange[] {
  const exchanges: CompactionExchange[] = [];
  let current: CompactionExchange | null = null;

  turns.forEach((turn, index) => {
    if (turn.role === 'user' || !current) {
      current = { startIndex: index, endIndex: index, messageCount: 1 };
      exchanges.push(current);
    } else {
      current.endIndex = index;
      current.messageCount += 1;
    }
  });

  return exchanges;
}

/**
 * Translates "keep the latest N exchanges" into the equivalent message-count
 * boundary (`preserveRecent` turns) by summing the message counts of the
 * trailing N exchange groups. Clamped to [0, exchanges.length].
 */
export function exchangesToMessageBoundary(
  exchanges: readonly CompactionExchange[],
  keepLatestExchanges: number,
): number {
  const n = clampExchangeCount(keepLatestExchanges, exchanges.length);
  if (n === 0) return 0;
  return exchanges
    .slice(exchanges.length - n)
    .reduce((sum, exchange) => sum + exchange.messageCount, 0);
}

/**
 * Inverse-ish helper for display: how many trailing exchanges does it take
 * to cover at least `messageBoundary` trailing messages? Used to seed the
 * "keep latest N exchanges" control from the compactor's own default
 * `preserveRecent` message count when the caller hasn't chosen a boundary.
 */
export function messageBoundaryToExchangeCount(
  exchanges: readonly CompactionExchange[],
  messageBoundary: number,
): number {
  if (messageBoundary <= 0) return 0;
  let remaining = messageBoundary;
  let count = 0;
  for (let i = exchanges.length - 1; i >= 0 && remaining > 0; i--) {
    remaining -= exchanges[i]!.messageCount;
    count += 1;
  }
  return count;
}

export interface CompactionCut {
  /** Indices (into the turns array) that would be summarized, ascending. */
  affectedIndices: number[];
  /** Indices (into the turns array) that remain verbatim, ascending. */
  keptIndices: number[];
  /**
   * Index rescued into `keptIndices` by the always-protect-most-recent-
   * user-turn rule, or null when the rule found nothing to rescue (nothing
   * affected, or no user turn in the affected range).
   */
  rescuedLastUserTurnIndex: number | null;
}

/**
 * Computes exactly which turn indices are affected (summarized) vs kept
 * verbatim for a given `preserveRecent` message-count boundary, replicating
 * `ContextCompactor.compact()`'s cut + "always protect the most recent user
 * turn" rule.
 */
export function computeCompactionCut(
  turns: readonly CompactionTurnRole[],
  preserveRecentMessages: number,
): CompactionCut {
  const total = turns.length;
  if (total === 0) {
    return { affectedIndices: [], keptIndices: [], rescuedLastUserTurnIndex: null };
  }

  const turnsToPreserve = clampExchangeCount(preserveRecentMessages, total);
  const cutIndex = turnsToPreserve === 0 ? total : total - turnsToPreserve;

  const affected = new Set<number>();
  for (let i = 0; i < cutIndex; i++) affected.add(i);
  const kept = new Set<number>();
  for (let i = cutIndex; i < total; i++) kept.add(i);

  let rescuedLastUserTurnIndex: number | null = null;
  for (let i = cutIndex - 1; i >= 0; i--) {
    if (turns[i]!.role === 'user') {
      affected.delete(i);
      kept.add(i);
      rescuedLastUserTurnIndex = i;
      break;
    }
  }

  return {
    affectedIndices: [...affected].sort((a, b) => a - b),
    keptIndices: [...kept].sort((a, b) => a - b),
    rescuedLastUserTurnIndex,
  };
}

function clampExchangeCount(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.floor(value), max));
}
