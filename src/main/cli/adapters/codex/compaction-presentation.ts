import type { ContextUsage, OutputMessage } from '../../../../shared/types/instance.types';
import { generateId } from '../../../../shared/utils/id-generator';

export function buildObservedCompactionEvents(input: {
  contextWindow: number;
  lastKnownUsed?: number;
  cumulativeTokens: number;
  costEstimate: number;
}): { output: OutputMessage; context: ContextUsage | null } {
  const context = input.lastKnownUsed === undefined
    ? null
    : {
        used: input.lastKnownUsed,
        total: input.contextWindow,
        percentage: input.contextWindow > 0
          ? Math.min((input.lastKnownUsed / input.contextWindow) * 100, 100)
          : 0,
        cumulativeTokens: input.cumulativeTokens,
        costEstimate: input.costEstimate,
        source: 'thread-compacted' as const,
        isEstimated: true,
      };
  return {
    output: {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content: 'Codex compacted the conversation to free context space.',
      metadata: { threadCompacted: true },
    },
    context,
  };
}
