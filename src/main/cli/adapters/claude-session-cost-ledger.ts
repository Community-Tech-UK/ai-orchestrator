import type { ClaudeModelUsageSnapshot, ModelUsageDelta } from '../../../shared/types/provider-model-usage.types';

function valid(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** One ledger per adapter. Parsing does not mutate it; only final completion settles. */
export class ClaudeSessionCostLedger {
  private baseline: number | undefined = 0;
  private lastReported: number | undefined;
  private resumePending = false;
  private models: ClaudeModelUsageSnapshot | undefined;
  private deltas: ModelUsageDelta[] | undefined;

  get lastTotalUsd(): number | undefined { return this.lastReported; }
  get lastModelUsage(): ClaudeModelUsageSnapshot | undefined { return this.models; }
  get byModel(): ModelUsageDelta[] | undefined { return this.deltas; }

  onSpawn(mode: 'fresh' | 'fork' | 'resume', seedTotalUsd?: number,
    seedModels?: ClaudeModelUsageSnapshot): void {
    this.resumePending = mode === 'resume';
    this.baseline = mode === 'resume' ? (valid(seedTotalUsd) ? seedTotalUsd : undefined) : 0;
    this.models = mode === 'resume' ? seedModels : undefined;
    this.deltas = undefined;
  }

  settle(reportedTotalUsd: number | undefined, mainThreadPricedUsd: number,
    reportedModels?: ClaudeModelUsageSnapshot): number | undefined {
    this.deltas = undefined;
    if (!valid(reportedTotalUsd)) return undefined;
    const baseline = this.baseline;
    const reset = baseline !== undefined && (reportedTotalUsd < baseline
      || (this.resumePending && reportedTotalUsd - baseline < 0.8 * mainThreadPricedUsd));
    const cost = baseline === undefined ? undefined : reset ? reportedTotalUsd : reportedTotalUsd - baseline;
    if (reportedModels) {
      if (baseline !== undefined) this.deltas = modelDifferences(reportedModels, reset ? undefined : this.models);
      this.models = structuredClone(reportedModels);
    }
    this.baseline = reportedTotalUsd;
    this.lastReported = reportedTotalUsd;
    this.resumePending = false;
    return cost;
  }
}

function modelDifferences(current: ClaudeModelUsageSnapshot, previous?: ClaudeModelUsageSnapshot): ModelUsageDelta[] {
  const keys = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'costUSD'] as const;
  return Object.entries(current).flatMap(([model, usage]) => {
    if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return [];
    if (keys.some(key => usage[key] !== undefined && !valid(usage[key]))) return [];
    const prior = previous?.[model];
    const reset = prior && keys.some(key => (usage[key] ?? 0) < (prior[key] ?? 0));
    const difference = (key: typeof keys[number]): number =>
      Math.max(0, (usage[key] ?? 0) - (!reset ? prior?.[key] ?? 0 : 0));
    return [{ model, inputTokens: difference('inputTokens'), outputTokens: difference('outputTokens'),
      cacheReadTokens: difference('cacheReadInputTokens'), cacheWriteTokens: difference('cacheCreationInputTokens'),
      ...(usage.costUSD !== undefined ? { costUsd: difference('costUSD') } : {}) }];
  });
}
