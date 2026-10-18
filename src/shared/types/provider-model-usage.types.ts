/** Provider-reported cumulative Claude model spend, including subagents. */
export interface ClaudeModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  costUSD?: number;
  contextWindow?: number;
}
export type ClaudeModelUsageSnapshot = Record<string, ClaudeModelUsage>;

/** Per-turn model differences; parent cost_entries tokens stay main-thread only. */
export interface ModelUsageDelta {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd?: number;
}
