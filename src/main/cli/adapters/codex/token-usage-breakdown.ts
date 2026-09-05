/**
 * LT-090: parses the per-call input/output/cache/reasoning split out of a
 * `thread/tokenUsage/updated` notification's `last` sample. Field names may
 * be camelCase or snake_case depending on the Codex app-server version.
 *
 * Extracted so `codex-app-server-notification-adapter.ts` doesn't have to
 * carry the four `??`-chained field lookups inline — that file sits right at
 * the production-file LOC ceiling.
 */
export interface CodexTurnUsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
}

export function resolveCodexTurnUsageBreakdown(
  last: Record<string, unknown> | undefined,
): CodexTurnUsageBreakdown {
  return {
    inputTokens: tokenCount(last?.['inputTokens'] ?? last?.['input_tokens']),
    outputTokens: tokenCount(last?.['outputTokens'] ?? last?.['output_tokens']),
    cacheReadTokens: tokenCount(last?.['cachedInputTokens'] ?? last?.['cached_input_tokens']),
    reasoningTokens: tokenCount(last?.['reasoningOutputTokens'] ?? last?.['reasoning_output_tokens']),
  };
}

export function tokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Native cache/reasoning counts are subsets; AIO pricing expects disjoint buckets. */
export function disjointCodexUsage(raw: CodexTurnUsageBreakdown): CodexTurnUsageBreakdown {
  const cacheReadTokens = Math.min(raw.inputTokens, raw.cacheReadTokens);
  const reasoningTokens = Math.min(raw.outputTokens, raw.reasoningTokens);
  return {
    inputTokens: raw.inputTokens - cacheReadTokens,
    outputTokens: raw.outputTokens - reasoningTokens,
    cacheReadTokens,
    reasoningTokens,
  };
}
