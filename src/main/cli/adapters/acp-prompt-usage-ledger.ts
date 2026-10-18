import type { AcpPromptUsage } from '../../../shared/types/cli.types';
const COUNTERS = ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cachedWriteTokens', 'thoughtTokens', 'totalTokens'] as const;

/** Copilot reports gross cumulative input, including both cache counters. */
export class AcpCumulativePromptUsageLedger {
  private previous: AcpPromptUsage | undefined;
  private total = 0;
  get sessionTotalTokens(): number { return this.total; }
  reset(): void { this.previous = undefined; this.total = 0; }

  settle(usage: AcpPromptUsage | undefined): AcpPromptUsage | undefined {
    if (!usage || !COUNTERS.some(key => usage[key] !== undefined)) return undefined;
    if (COUNTERS.some(key => usage[key] !== undefined
      && (typeof usage[key] !== 'number' || !Number.isFinite(usage[key]) || usage[key]! < 0))) return undefined;
    const previous = this.previous;
    const reset = !previous || COUNTERS.some(key => (usage[key] ?? 0) < (previous[key] ?? 0));
    const delta = (key: typeof COUNTERS[number]): number => (usage[key] ?? 0) - (reset ? 0 : previous![key] ?? 0);
    this.previous = { ...usage };
    this.total = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
    if (!COUNTERS.some(key => delta(key) > 0)) return undefined;
    const read = delta('cachedReadTokens'); const write = delta('cachedWriteTokens');
    return { inputTokens: Math.max(0, delta('inputTokens') - read - write), outputTokens: delta('outputTokens'),
      cachedReadTokens: read, cachedWriteTokens: write,
      totalTokens: usage.totalTokens !== undefined ? delta('totalTokens') : delta('inputTokens') + delta('outputTokens'),
      ...(usage.thoughtTokens !== undefined ? { thoughtTokens: delta('thoughtTokens') } : {}),
      ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd } : {}) };
  }
}
