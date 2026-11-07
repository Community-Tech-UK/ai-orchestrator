import type { SqliteDriver } from '../../db/sqlite-driver';
import type { CopilotModelCache, SessionSpendBreakdown, SessionSpendModel } from '../../../shared/types/cost-session.types';
import { computeProviderTokenCost } from '../../../shared/data/model-pricing';

interface SpendRow {
  id: string; provider?: string; timestamp: number; model: string; cost: number; is_estimated: number;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; reasoning_tokens: number;
  ai_credits_nano: number | null; premium_requests: number | null;
  child_model: string | null; child_input: number; child_output: number; child_read: number; child_write: number; child_cost: number | null;
}
/** Complete session history comes from SQLite, never the bounded CostTracker window. */
export function getSessionSpendBreakdown(db: SqliteDriver, instanceId: string, sessionId?: string,
  copilotCache: CopilotModelCache[] = []): SessionSpendBreakdown {
  const rows = db.prepare(`SELECT e.*, m.model AS child_model, m.input_tokens AS child_input,
    m.output_tokens AS child_output, m.cache_read_tokens AS child_read, m.cache_write_tokens AS child_write,
    m.cost_usd AS child_cost FROM cost_entries e LEFT JOIN cost_entry_model_usage m ON m.entry_id = e.id
    WHERE e.instance_id = ? OR e.session_id = ? ORDER BY e.timestamp, e.id, m.model`).all<SpendRow>(instanceId, sessionId ?? null);
  const result: SessionSpendBreakdown = { turns: 0, totalCostUsd: 0, estimatedShare: 0, mainCostUsd: 0,
    helperCostUsd: 0, splitAvailable: true, byModel: [], copilotCache };
  const seen = new Set<string>();
  const models = new Map<string, SessionSpendModel>();
  let estimated = 0;
  for (const row of rows) {
    if (!seen.has(row.id)) {
      seen.add(row.id); result.turns++;
      result.totalCostUsd += row.cost;
      if (row.is_estimated) estimated += row.cost;
      result.firstAt = Math.min(result.firstAt ?? Infinity, row.timestamp);
      result.lastAt = Math.max(result.lastAt ?? 0, row.timestamp);
      // Only child-bearing Claude turns admit a main/helper split. Other rows
      // retain their actual cost, including Copilot's explicit zero dollars.
      const main = row.child_model ? computeProviderTokenCost(row.provider ?? 'claude', row.model, {
        inputTokens: row.input_tokens, outputTokens: row.output_tokens, cacheReadTokens: row.cache_read_tokens,
        cacheWriteTokens: row.cache_write_tokens, reasoningTokens: row.reasoning_tokens }) : row.cost;
      result.mainCostUsd += Math.min(row.cost, main ?? row.cost);
      if (main === undefined) result.splitAvailable = false;
      if (row.ai_credits_nano != null) result.aiCreditsNano = (result.aiCreditsNano ?? 0) + row.ai_credits_nano;
      if (row.premium_requests != null) result.premiumRequests = (result.premiumRequests ?? 0) + row.premium_requests;
    }
    const name = row.child_model ?? row.model;
    const model = models.get(name) ?? { model: name, costUsd: 0, inputTokens: 0, outputTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, isMainModel: false, costKnown: true };
    model.isMainModel ||= name === row.model;
    model.costUsd += row.child_model ? row.child_cost ?? 0 : row.cost;
    if (row.child_model && row.child_cost === null) model.costKnown = false;
    model.inputTokens += row.child_model ? row.child_input : row.input_tokens;
    model.outputTokens += row.child_model ? row.child_output : row.output_tokens;
    model.cacheReadTokens += row.child_model ? row.child_read : row.cache_read_tokens;
    model.cacheWriteTokens += row.child_model ? row.child_write : row.cache_write_tokens;
    models.set(name, model);
  }
  result.byModel = [...models.values()];
  result.helperCostUsd = Math.max(0, result.totalCostUsd - result.mainCostUsd);
  result.estimatedShare = result.totalCostUsd > 0 ? estimated / result.totalCostUsd : 0;
  return result;
}
