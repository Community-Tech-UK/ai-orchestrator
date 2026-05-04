import { LIMITS } from '../../shared/constants/limits';

export interface CompactionInputs {
  messageCount: number;
  maxConversationEntries: number;
  contextUsagePercent: number;
  lastCompactedAt?: number;
  now?: number;
}

export interface CompactionDecision {
  shouldCompact: boolean;
  reason: 'background_threshold' | 'cooldown' | 'none';
  preserveRecentMessages: number;
}

export interface ConversationLike {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  isCompacted?: boolean;
}

export interface Compactor<T extends ConversationLike> {
  compact(entries: T[], decision: CompactionDecision): {
    entries: T[];
    compactedCount: number;
  };
}

export class SessionCompactionPolicy {
  evaluate(inputs: CompactionInputs): CompactionDecision {
    const now = inputs.now ?? Date.now();
    const lastCompactedAt = inputs.lastCompactedAt ?? 0;
    const preserveRecentMessages = Math.min(inputs.maxConversationEntries, 50);
    const compactableMessages = Math.max(0, inputs.messageCount - preserveRecentMessages);
    const minimumCompactableMessages = Math.max(1, preserveRecentMessages);
    const hasUsefulCompactionBatch = compactableMessages >= minimumCompactableMessages;

    if (
      hasUsefulCompactionBatch
      && inputs.contextUsagePercent >= LIMITS.COMPACTION_BACKGROUND_THRESHOLD
      && now - lastCompactedAt >= LIMITS.COMPACTION_COOLDOWN_MS
    ) {
      return {
        shouldCompact: true,
        reason: 'background_threshold',
        preserveRecentMessages,
      };
    }

    if (
      hasUsefulCompactionBatch
      && inputs.contextUsagePercent >= LIMITS.COMPACTION_BACKGROUND_THRESHOLD
    ) {
      return {
        shouldCompact: false,
        reason: 'cooldown',
        preserveRecentMessages,
      };
    }

    return {
      shouldCompact: false,
      reason: 'none',
      preserveRecentMessages,
    };
  }
}

export class ConversationHistoryCompactor<T extends ConversationLike> implements Compactor<T> {
  compact(entries: T[], decision: CompactionDecision): { entries: T[]; compactedCount: number } {
    const preserveRecentMessages = Math.max(1, decision.preserveRecentMessages);
    if (entries.length <= preserveRecentMessages) {
      return { entries, compactedCount: 0 };
    }

    const compacted = entries.slice(0, entries.length - preserveRecentMessages);
    const preserved = entries.slice(entries.length - preserveRecentMessages);
    const summary = {
      id: `compacted-${Date.now()}`,
      role: 'system',
      content: `[Compacted ${compacted.length} earlier messages. Key context preserved in session state.]`,
      timestamp: Date.now(),
      isCompacted: true,
    } as T;

    return {
      entries: [summary, ...preserved],
      compactedCount: compacted.length,
    };
  }
}
