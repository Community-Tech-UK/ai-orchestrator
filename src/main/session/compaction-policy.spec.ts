import { describe, expect, it } from 'vitest';
import { ConversationHistoryCompactor, SessionCompactionPolicy } from './compaction-policy';

describe('SessionCompactionPolicy', () => {
  it('does not compact solely because the message count exceeds the history sizing hint', () => {
    const policy = new SessionCompactionPolicy();
    const decision = policy.evaluate({
      messageCount: 1200,
      maxConversationEntries: 1000,
      contextUsagePercent: 40,
    });

    expect(decision.shouldCompact).toBe(false);
    expect(decision.reason).toBe('none');
  });

  it('compacts when the context budget threshold is reached', () => {
    const policy = new SessionCompactionPolicy();
    const decision = policy.evaluate({
      messageCount: 1200,
      maxConversationEntries: 1000,
      contextUsagePercent: 85,
    });

    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe('background_threshold');
  });

  it('respects cooldown for background compaction', () => {
    const policy = new SessionCompactionPolicy();
    const now = Date.now();
    const decision = policy.evaluate({
      messageCount: 200,
      maxConversationEntries: 1000,
      contextUsagePercent: 85,
      lastCompactedAt: now - 1_000,
      now,
    });

    expect(decision.shouldCompact).toBe(false);
    expect(decision.reason).toBe('cooldown');
  });
});

describe('ConversationHistoryCompactor', () => {
  it('replaces compacted history with a summary entry', () => {
    const compactor = new ConversationHistoryCompactor<{
      id: string;
      role: string;
      content: string;
      timestamp: number;
      isCompacted?: boolean;
    }>();
    const result = compactor.compact(
      Array.from({ length: 10 }, (_, index) => ({
        id: `msg-${index}`,
        role: 'assistant',
        content: `message ${index}`,
        timestamp: index,
      })),
      {
        shouldCompact: true,
        reason: 'background_threshold',
        preserveRecentMessages: 4,
      },
    );

    expect(result.compactedCount).toBe(6);
    expect(result.entries[0]?.isCompacted).toBe(true);
    expect(result.entries).toHaveLength(5);
  });
});
