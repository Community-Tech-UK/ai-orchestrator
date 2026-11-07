import type { CostEntry, CostSummary } from './cost-tracker';

/** Child rows already include main-model use: never add the parent a second time. */
export function buildCostSummary(entries: readonly CostEntry[], startTime = 0, endTime = Date.now()): CostSummary {
  const summary: CostSummary = { totalCost: 0, totalAiCreditsNano: 0, totalEstimatedCost: 0, hasEstimatedEntries: false,
    totalInputTokens: 0, totalOutputTokens: 0, totalCacheReadTokens: 0, totalCacheWriteTokens: 0, totalReasoningTokens: 0,
    byModel: {}, bySession: {}, providers: [], requestCount: 0, startTime, endTime };
  for (const entry of entries) {
    if (entry.timestamp < startTime || entry.timestamp > endTime) continue;
    summary.requestCount++;
    if (!summary.providers!.includes(entry.provider ?? 'unknown')) summary.providers!.push(entry.provider ?? 'unknown');
    summary.totalCost += entry.cost;
    summary.totalAiCreditsNano += entry.aiCreditsNano ?? 0;
    if (entry.aiCreditsNano !== undefined) summary.firstCreditsAt = Math.min(summary.firstCreditsAt ?? Infinity, entry.timestamp);
    summary.totalInputTokens += entry.inputTokens;
    summary.totalOutputTokens += entry.outputTokens;
    summary.totalCacheReadTokens += entry.cacheReadTokens ?? 0;
    summary.totalCacheWriteTokens += entry.cacheWriteTokens ?? 0;
    summary.totalReasoningTokens += entry.reasoningTokens ?? 0;
    if (entry.isEstimated) { summary.hasEstimatedEntries = true; summary.totalEstimatedCost += entry.cost; }
    for (const model of entry.byModel?.length ? entry.byModel : [{ ...entry, costUsd: entry.cost }]) {
      const row = summary.byModel[model.model] ??= { cost: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
        requests: 0, hasEstimated: false };
      row.cost += model.costUsd ?? 0;
      if (model.costUsd === undefined) row.hasUnknownCost = true;
      row.inputTokens += model.inputTokens;
      row.outputTokens += model.outputTokens;
      row.reasoningTokens += model.model === entry.model ? entry.reasoningTokens ?? 0 : 0;
      row.requests++;
      row.hasEstimated ||= !!entry.isEstimated;
      if (model.model === entry.model && entry.aiCreditsNano !== undefined) row.aiCreditsNano = (row.aiCreditsNano ?? 0) + (entry.aiCreditsNano ?? 0);
    }
    const row = summary.bySession[entry.sessionId] ??= { cost: 0, tokens: 0, requests: 0, hasEstimated: false };
    row.instanceId = entry.instanceId;
    row.provider = entry.provider;
    row.cost += entry.cost;
    row.tokens += entry.inputTokens + entry.outputTokens + (entry.cacheReadTokens ?? 0) + (entry.cacheWriteTokens ?? 0) + (entry.reasoningTokens ?? 0);
    row.requests++;
    row.hasEstimated ||= !!entry.isEstimated;
    if (entry.aiCreditsNano !== undefined) row.aiCreditsNano = (row.aiCreditsNano ?? 0) + entry.aiCreditsNano;
  }
  return summary;
}
