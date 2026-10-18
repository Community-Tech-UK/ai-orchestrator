import { estimateTokens } from '../../shared/utils/token-estimate';
import { groupExchanges } from './compaction-boundary';
import type { OutputMessage, Instance } from '../../shared/types/instance.types';

export function activeMessagesOf(instance: Pick<Instance, 'outputBuffer' | 'archivedUpToMessageId'>): OutputMessage[] {
  const archivedIndex = instance.archivedUpToMessageId
    ? instance.outputBuffer.findIndex(message => message.id === instance.archivedUpToMessageId)
    : -1;
  return instance.outputBuffer.slice(archivedIndex + 1).filter(message => message.metadata?.['kind'] !== 'session-boundary');
}

export function selectCompactionTail(
  turns: readonly { role: 'user' | 'assistant'; content: string }[],
  contextWindow: number,
  keepLatestExchanges?: number,
): { affectedIndices: number[]; keptIndices: number[]; tokenBudget: number } {
  const window = Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : 200000;
  const tokenBudget = keepLatestExchanges === undefined
    ? Math.max(2000, Math.min(15000, Math.floor(window * 0.25)))
    : Math.max(1, Math.floor(window * 0.4));
  const exchanges = groupExchanges(turns);
  const kept = new Set<number>();
  let tokens = 0;
  let count = 0;
  for (let i = exchanges.length - 1; i >= 0; i--) {
    if (keepLatestExchanges !== undefined && count >= Math.max(0, Math.floor(keepLatestExchanges))) break;
    const exchange = exchanges[i]!;
    const indices = Array.from({ length: exchange.endIndex - exchange.startIndex + 1 }, (_, j) => exchange.startIndex + j);
    const cost = indices.reduce((sum, index) => sum + estimateTokens(turns[index]!.content), 0);
    if (tokens + cost > tokenBudget) {
      // Only the newest exchange may be split, while the newest user stays whole below.
      if (count === 0) {
        for (const index of indices.reverse()) {
          const turnCost = estimateTokens(turns[index]!.content);
          if (tokens + turnCost <= tokenBudget) { kept.add(index); tokens += turnCost; }
        }
      }
      break;
    }
    for (const index of indices) kept.add(index);
    tokens += cost;
    count++;
  }
  let lastUser = -1;
  for (let index = turns.length - 1; index >= 0; index--) { if (turns[index]!.role === 'user') { lastUser = index; break; } }
  if (lastUser >= 0) kept.add(lastUser);
  return {
    affectedIndices: turns.map((_, index) => index).filter(index => !kept.has(index)),
    keptIndices: [...kept].sort((a, b) => a - b),
    tokenBudget,
  };
}
