import type { CostEntry } from './cost-tracker';

/** Persisted row shape for the `cost_entries` table (snake_case columns). */
export interface CostEntryRow {
  id: string;
  timestamp: number;
  instance_id: string;
  session_id: string;
  model: string;
  provider: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  cost: number;
  is_estimated: number;
  origin: string | null;
  ai_credits_nano: number | null;
  premium_requests: number | null;
  credit_checkpoint_id: string | null;
  credit_checkpoint_total_nano: number | null;
  credit_checkpoint_premium_total: number | null;
}

export function rowToEntry(row: CostEntryRow): CostEntry {
  return {
    id: row.id,
    timestamp: row.timestamp,
    instanceId: row.instance_id,
    sessionId: row.session_id,
    model: row.model,
    ...(row.provider ? { provider: row.provider } : {}),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    reasoningTokens: row.reasoning_tokens,
    cost: row.cost,
    isEstimated: row.is_estimated === 1,
    ...(row.origin !== null ? { origin: row.origin } : {}),
    ...(row.credit_checkpoint_premium_total != null ? { creditCheckpointPremiumTotal: row.credit_checkpoint_premium_total } : {}),
    ...(row.ai_credits_nano != null ? { aiCreditsNano: row.ai_credits_nano } : {}),
    ...(row.premium_requests != null ? { premiumRequests: row.premium_requests } : {}),
    ...(row.credit_checkpoint_id != null ? { creditCheckpointId: row.credit_checkpoint_id } : {}),
    ...(row.credit_checkpoint_total_nano != null ? { creditCheckpointTotalNano: row.credit_checkpoint_total_nano } : {}),
  };
}
