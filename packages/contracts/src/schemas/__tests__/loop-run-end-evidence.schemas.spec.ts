import { describe, expect, it } from 'vitest';
import { LoopRunSummarySchema } from '../loop.schemas';

const summary = {
  id: 'loop-evidence', chatId: 'chat-evidence', status: 'completed-needs-review',
  totalIterations: 2, totalTokens: 0, totalCostCents: 0, startedAt: 100, endedAt: 200,
  endReason: 'The result needs review', workspaceCwd: '/fixture',
  initialPrompt: 'Review the project', iterationPrompt: null,
};

describe('stored loop summary end evidence', () => {
  it('preserves the structured merge hold across the renderer contract', () => {
    const endEvidence = { mergeHold: true, mergeHoldKind: 'verified-no-change' };
    expect(LoopRunSummarySchema.parse({ ...summary, endEvidence })).toHaveProperty('endEvidence', endEvidence);
  });

  it('continues to accept legacy summaries with no end evidence', () => {
    expect(LoopRunSummarySchema.parse(summary)).not.toHaveProperty('endEvidence');
  });

  it('rejects malformed evidence instead of dropping it', () => {
    expect(LoopRunSummarySchema.safeParse({ ...summary, endEvidence: 'merge held' }).success).toBe(false);
  });
});
