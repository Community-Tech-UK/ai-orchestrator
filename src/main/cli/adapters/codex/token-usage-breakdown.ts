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
    inputTokens: Number(last?.['inputTokens'] ?? last?.['input_tokens'] ?? 0) || 0,
    outputTokens: Number(last?.['outputTokens'] ?? last?.['output_tokens'] ?? 0) || 0,
    cacheReadTokens: Number(last?.['cachedInputTokens'] ?? last?.['cached_input_tokens'] ?? 0) || 0,
    reasoningTokens: Number(last?.['reasoningOutputTokens'] ?? last?.['reasoning_output_tokens'] ?? 0) || 0,
  };
}
