import type { ContextUsage, OutputMessage } from '../../../../shared/types/instance.types';
import { generateId } from '../../../../shared/utils/id-generator';

export function buildObservedCompactionEvents(input: {
  contextWindow: number;
  cumulativeTokens: number;
  costEstimate: number;
}): { output: OutputMessage; context: ContextUsage } {
  return {
    output: {
      id: generateId(),
      timestamp: Date.now(),
      type: 'system',
      content: 'Codex compacted the conversation to free context space.',
      metadata: { threadCompacted: true },
    },
    context: {
      used: 0,
      total: input.contextWindow,
      percentage: 0,
      cumulativeTokens: input.cumulativeTokens,
      costEstimate: input.costEstimate,
      source: 'thread-compacted',
      isEstimated: true,
    },
  };
}
