/**
 * Cost Tracker - Model pricing and budget management (5.3)
 *
 * Tracks API costs per model, session, and overall with budget alerts.
 */

import type { ModelUsageDelta } from '../../../shared/types/provider-model-usage.types';
import { buildCostSummary } from './cost-summary-builder';
import { type CostEntryRow, rowToEntry } from './cost-entry-row';
import { EventEmitter } from 'events';
import { computeTokenCost } from '../../../shared/data/model-pricing';
import type { SqliteDriver, SqliteStatement } from '../../db/sqlite-driver';
import { getLogger } from '../../logging/logger';

const logger = getLogger('CostTracker');

/**
 * Cost entry for a single API call
 */
export interface CostEntry {
  id: string;
  timestamp: number;
  instanceId: string;
  sessionId: string;
  model: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  cost: number;
  byModel?: ModelUsageDelta[];
  /** Copilot's own AI-credit accounting for this turn; absent for other providers. */
  aiCreditsNano?: number;
  premiumRequests?: number;
  creditCheckpointId?: string;
  creditCheckpointTotalNano?: number;
  creditCheckpointPremiumTotal?: number;
  /**
   * True when the token counts (and therefore `cost`, unless a provider
   * cost override was also supplied) came from a heuristic estimate rather
   * than a provider-reported measurement — e.g. an ACP-transport turn
   * (Cursor/Grok/Copilot) whose server sent no `usage` at all (LT-100).
   * Every read surface (cost page, summaries, exports) must keep this
   * visibly distinguishable from a measured entry rather than blending it
   * into a total that reads as measured. Absent/false means measured.
   */
  isEstimated?: boolean;
  /** User or machine session origin; future open tags pass through unchanged. */
  origin?: string;
}

/**
 * Cost summary for a time period or session
 */
export interface CostSummary {
  totalCost: number;
  totalAiCreditsNano: number;
  providers?: string[];
  firstCreditsAt?: number;
  /**
   * Portion of `totalCost` contributed by entries with `isEstimated: true`.
   * Lets a total that mixes measured and estimated entries say so instead
   * of reading as a single measured number (LT-100).
   */
  totalEstimatedCost: number;
  /** True when at least one summed entry is an estimate. */
  hasEstimatedEntries: boolean;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  totalReasoningTokens: number;
  byModel: Record<string, {
    cost: number;
    aiCreditsNano?: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    requests: number;
    /** True when any request for this model contributed an estimated entry. */
    hasEstimated: boolean;
    hasUnknownCost?: boolean;
  }>;
  bySession: Record<string, {
    cost: number;
    instanceId?: string;
    provider?: string;
    aiCreditsNano?: number;
    tokens: number;
    requests: number;
    /** True when any request for this session contributed an estimated entry. */
    hasEstimated: boolean;
  }>;
  requestCount: number;
  startTime: number;
  endTime: number;
}

/**
 * Budget configuration
 */
export interface BudgetConfig {
  enabled: boolean;
  dailyLimit: number;        // USD
  weeklyLimit: number;       // USD
  monthlyLimit: number;      // USD
  perSessionLimit: number;   // USD
  alertThresholds: number[]; // Percentages to alert at (e.g., [50, 75, 90])
}

/**
 * Budget alert
 */
export interface BudgetAlert {
  type: 'daily' | 'weekly' | 'monthly' | 'session';
  threshold: number;  // Percentage
  currentUsage: number;
  limit: number;
  timestamp: number;
}

const DEFAULT_BUDGET: BudgetConfig = {
  enabled: false,
  dailyLimit: 10,
  weeklyLimit: 50,
  monthlyLimit: 200,
  perSessionLimit: 5,
  alertThresholds: [50, 75, 90, 100],
};

/**
 * Cost Tracker class
 */
export class CostTracker extends EventEmitter {
  private entries: CostEntry[] = [];
  /**
   * Ids of entries whose write-through to the persistence table has not
   * succeeded — either the INSERT failed (the entry is retained in
   * {@link entries} as real recorded spend) or persistence was not attached
   * yet. These entries live in memory only, and rehydration must carry them
   * across instead of erasing them: a maintenance reload (LT-707 restore/
   * undo) that dropped them would silently lose recorded costs.
   */
  private unpersistedIds = new Set<string>();
  private budget: BudgetConfig = { ...DEFAULT_BUDGET };
  private alertedThresholds = new Set<string>();
  private maxEntries = 10000;
  private db: SqliteDriver | null = null;
  private insertStmt: SqliteStatement | null = null;

  /**
   * Attach the RLM database so cost entries persist across restarts.
   *
   * Best-effort: if the table/statement can't be prepared, the tracker keeps
   * working in-memory only. On attach, the most recent `maxEntries` rows are
   * rehydrated into memory (chronological order) so summaries, budget windows
   * and the analytics page reflect history from before the restart.
   */
  setDatabase(db: SqliteDriver): void {
    try {
      this.insertStmt = db.prepare(`
        INSERT OR REPLACE INTO cost_entries
          (id, timestamp, instance_id, session_id, model, provider,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, cost, is_estimated, origin,
           ai_credits_nano, premium_requests, credit_checkpoint_id, credit_checkpoint_total_nano, credit_checkpoint_premium_total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.db = db;
      // Flush any entries recorded before persistence was attached (INSERT OR
      // REPLACE keyed by id makes this idempotent), then rehydrate the window so
      // nothing is lost regardless of call ordering.
      for (const entry of this.entries) {
        this.persistEntry(entry);
      }
      this.loadFromDb();
      logger.info('CostTracker persistence enabled', { loaded: this.entries.length });
    } catch (err) {
      this.db = null;
      this.insertStmt = null;
      logger.warn('CostTracker could not enable persistence — in-memory only', { error: String(err) });
    }
  }

  /**
   * Re-read the in-memory window from persistence without writing anything.
   *
   * Maintenance flows (LT-707 cost history restoration) rewrite stored rows
   * directly; once one has run, the cached window must be discarded and
   * reloaded or summaries, history and budgets keep serving the pre-repair
   * values until the next restart. Unlike {@link setDatabase} this never
   * flushes cached entries back into the database — reattaching the database
   * would overwrite the repaired rows with the stale cache. Entries whose
   * write-through failed are real recorded spend that lives only in memory;
   * the reload preserves them (and never persists them — this stays read-only)
   * rather than erasing them along with the stale cache. No-op while
   * persistence is not attached.
   */
  reloadFromDatabase(): void {
    if (!this.db) return;
    this.loadFromDb();
    logger.info('CostTracker reloaded from persistence', { loaded: this.entries.length });
  }

  /**
   * Rehydrate the in-memory window from the most recent persisted rows,
   * carrying memory-only entries (see {@link unpersistedIds}) across the
   * refresh in chronological order.
   */
  private loadFromDb(): void {
    if (!this.db) return;
    const rows = this.db
      .prepare(
        `SELECT id, timestamp, instance_id, session_id, model, provider,
                input_tokens, output_tokens, cache_read_tokens,
                cache_write_tokens, reasoning_tokens, cost, is_estimated, origin,
                ai_credits_nano, premium_requests, credit_checkpoint_id, credit_checkpoint_total_nano, credit_checkpoint_premium_total
         FROM cost_entries ORDER BY timestamp DESC LIMIT ?`,
      )
      .all<CostEntryRow>(this.maxEntries);
    // Rows came back newest-first; reverse so the array stays chronological
    // (matching push-on-record order).
    const persisted = rows.reverse().map(rowToEntry);
    const persistedIds = new Set(persisted.map((entry) => entry.id));
    // Preserve entries that never reached the database (failed write-throughs
    // or records made before persistence attached): they are real recorded
    // spend and are typically the newest entries, so dropping them would
    // under-report live cost surfaces until the next restart.
    const memoryOnly = this.entries.filter(
      (entry) => this.unpersistedIds.has(entry.id) && !persistedIds.has(entry.id),
    );
    const merged = [...persisted, ...memoryOnly].sort((a, b) => a.timestamp - b.timestamp);
    this.entries = merged.length > this.maxEntries ? merged.slice(-this.maxEntries) : merged;
    // Keep the flag set consistent with the window and with what actually
    // reached the database (a later successful write clears the flag).
    this.unpersistedIds = new Set(
      this.entries
        .filter((entry) => this.unpersistedIds.has(entry.id) && !persistedIds.has(entry.id))
        .map((entry) => entry.id),
    );
    const modelRows = this.db.prepare(`SELECT * FROM cost_entry_model_usage WHERE entry_id IN
      (SELECT id FROM cost_entries ORDER BY timestamp DESC LIMIT ?) ORDER BY model`).all<{
        entry_id: string; model: string; input_tokens: number; output_tokens: number;
        cache_read_tokens: number; cache_write_tokens: number; cost_usd: number | null;
      }>(this.maxEntries);
    const byEntry = new Map<string, ModelUsageDelta[]>();
    for (const row of modelRows) {
      const deltas = byEntry.get(row.entry_id) ?? [];
      deltas.push({ model: row.model, inputTokens: row.input_tokens, outputTokens: row.output_tokens,
        cacheReadTokens: row.cache_read_tokens, cacheWriteTokens: row.cache_write_tokens,
        ...(row.cost_usd !== null ? { costUsd: row.cost_usd } : {}) });
      byEntry.set(row.entry_id, deltas);
    }
    for (const entry of this.entries) if (byEntry.has(entry.id)) entry.byModel = byEntry.get(entry.id);
  }

  /**
   * Best-effort write-through of a single entry to the persistence table.
   * A failure keeps the entry in the in-memory window and flags it as
   * memory-only so rehydration never discards it.
   */
  private persistEntry(entry: CostEntry): void {
    if (!this.insertStmt) {
      this.unpersistedIds.add(entry.id);
      return;
    }
    try {
      const persist = (): void => {
        this.insertStmt!.run(
          entry.id,
          entry.timestamp,
          entry.instanceId,
          entry.sessionId,
          entry.model,
          entry.provider ?? null,
          entry.inputTokens,
          entry.outputTokens,
          entry.cacheReadTokens ?? 0,
          entry.cacheWriteTokens ?? 0,
          entry.reasoningTokens ?? 0,
          entry.cost,
          entry.isEstimated ? 1 : 0,
          entry.origin ?? null,
          entry.aiCreditsNano ?? null, entry.premiumRequests ?? null,
          entry.creditCheckpointId ?? null, entry.creditCheckpointTotalNano ?? null, entry.creditCheckpointPremiumTotal ?? null,
        );
        if (this.db && entry.byModel) {
          const statement = this.db.prepare(`INSERT OR REPLACE INTO cost_entry_model_usage
            (entry_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd)
            VALUES (?, ?, ?, ?, ?, ?, ?)`);
          for (const delta of entry.byModel) statement.run(entry.id, delta.model, delta.inputTokens,
            delta.outputTokens, delta.cacheReadTokens, delta.cacheWriteTokens, delta.costUsd ?? null);
        }
      };
      if (this.db) this.db.transaction(persist)(); else persist();
      this.unpersistedIds.delete(entry.id);
    } catch (err) {
      this.unpersistedIds.add(entry.id);
      logger.warn('Failed to persist cost entry', { error: String(err) });
    }
  }

  /**
   * Calculate cost for a given usage
   */
  calculateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    reasoningTokens = 0,
  ): number {
    // Delegate to the shared pricing helper so every cost path (this tracker
    // plus the provider adapters) uses one per-model input/output/cache table.
    return computeTokenCost(model, {
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
    });
  }

  /**
   * Record a cost entry.
   *
   * When `providerCostUsd` is a finite, non-negative number it is trusted as
   * the authoritative cost for this entry (e.g. the Claude CLI's
   * `total_cost_usd`, which already bakes in cache pricing) instead of deriving
   * cost from the per-model token rate table. Token counts are still stored for
   * analytics either way. When the override is absent, cost is computed from the
   * pricing table via {@link calculateCost}.
   *
   * `isEstimated` (LT-100) tags the whole entry — tokens and, unless
   * `providerCostUsd` overrides it, the derived cost — as a heuristic
   * estimate rather than a measurement. Every summary/export consumer must
   * keep it visibly distinguishable from a measured entry.
   */
  recordUsage(
    instanceId: string,
    sessionId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    providerCostUsd?: number,
    reasoningTokens = 0,
    isEstimated = false,
    options?: { provider?: string; byModel?: ModelUsageDelta[]; origin?: string },
  ): CostEntry {
    const cost =
      typeof providerCostUsd === 'number' &&
      Number.isFinite(providerCostUsd) &&
      providerCostUsd >= 0
        ? providerCostUsd
        : options?.provider === 'copilot' || options?.provider === 'cursor' ? 0 : this.calculateCost(
            model,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            reasoningTokens,
          );

    const entry: CostEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      instanceId,
      sessionId,
      model,
      provider: options?.provider,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      cost,
      isEstimated,
      ...(options?.origin !== undefined ? { origin: options.origin } : {}),
      ...(options?.byModel ? { byModel: structuredClone(options.byModel) } : {}),
    };

    this.entries.push(entry);

    // Prune old entries if needed (in-memory window only; the DB keeps history
    // until an explicit clearEntries()/cleanup()).
    if (this.entries.length > this.maxEntries) {
      const dropped = this.entries.slice(0, this.entries.length - this.maxEntries);
      this.entries = this.entries.slice(-this.maxEntries);
      for (const entry of dropped) this.unpersistedIds.delete(entry.id);
    }

    // Write-through to the persistence table so history survives a restart.
    this.persistEntry(entry);

    // Check budget alerts
    this.checkBudgetAlerts(sessionId);

    this.emit('cost-recorded', entry);
    return entry;
  }

  /**
   * Get cost summary for a time range
   */
  getSummary(startTime?: number, endTime?: number): CostSummary {
    const summary = buildCostSummary(this.entries, startTime, endTime);
    if (this.db) summary.firstCreditsAt = this.db.prepare(`SELECT MIN(timestamp) AS firstAt FROM cost_entries
      WHERE ai_credits_nano IS NOT NULL`).get<{ firstAt: number | null }>()?.firstAt ?? undefined;
    return summary;
  }

  /** Persist credits before updating memory or notifying live readers. */
  attachProviderCredits(entryId: string, credits: {
    creditsNano: number; premiumRequests: number; checkpointEventId: string; checkpointTotalNano: number; checkpointPremiumTotal?: number;
  }): boolean {
    if (![credits.creditsNano, credits.premiumRequests, credits.checkpointTotalNano].every(n => Number.isFinite(n) && n >= 0)) return false;
    let entry = this.entries.find(e => e.id === entryId);
    if (!entry && this.db) {
      const row = this.db.prepare('SELECT * FROM cost_entries WHERE id = ?').get<CostEntryRow>(entryId);
      if (!row) return false;
      entry = rowToEntry(row);
      const models = this.db.prepare('SELECT * FROM cost_entry_model_usage WHERE entry_id = ? ORDER BY model').all<{
        model: string; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; cost_usd: number | null;
      }>(entryId);
      if (models.length) entry.byModel = models.map(model => ({ model: model.model,
        inputTokens: model.input_tokens, outputTokens: model.output_tokens,
        cacheReadTokens: model.cache_read_tokens, cacheWriteTokens: model.cache_write_tokens,
        ...(model.cost_usd !== null ? { costUsd: model.cost_usd } : {}) }));
    }
    if (!entry) return false;
    const values = { aiCreditsNano: credits.creditsNano, premiumRequests: credits.premiumRequests,
      creditCheckpointId: credits.checkpointEventId, creditCheckpointTotalNano: credits.checkpointTotalNano,
      creditCheckpointPremiumTotal: credits.checkpointPremiumTotal };
    if (this.db) {
      const result = this.db.prepare(`UPDATE cost_entries SET ai_credits_nano = ?, premium_requests = ?,
        credit_checkpoint_id = ?, credit_checkpoint_total_nano = ?, credit_checkpoint_premium_total = ? WHERE id = ? AND credit_checkpoint_id IS NULL`)
        .run(credits.creditsNano, credits.premiumRequests, credits.checkpointEventId, credits.checkpointTotalNano, credits.checkpointPremiumTotal ?? null, entryId);
      if (!result.changes) return false;
    } else if (entry.creditCheckpointId) return false;
    Object.assign(entry, values);
    // Not 'cost-recorded': that event carries new spend, and this entry's cost was counted when it was recorded.
    this.emit('cost-updated', entry);
    return true;
  }

  getLastProviderCreditCheckpoint(sessionId: string): { eventId: string; totalNano: number; premiumTotal: number } | undefined {
    if (this.db) {
      const row = this.db.prepare(`SELECT credit_checkpoint_id AS eventId, credit_checkpoint_total_nano AS totalNano,
        COALESCE(credit_checkpoint_premium_total, 0) AS premiumTotal
        FROM cost_entries WHERE session_id = ? AND credit_checkpoint_id IS NOT NULL
        ORDER BY credit_checkpoint_total_nano DESC, timestamp DESC LIMIT 1`)
        .get<{ eventId: string; totalNano: number; premiumTotal: number }>(sessionId);
      return row;
    }
    const rows = this.entries.filter(e => e.sessionId === sessionId && e.creditCheckpointId);
    const last = rows.at(-1);
    return last ? { eventId: last.creditCheckpointId!, totalNano: last.creditCheckpointTotalNano!,
      premiumTotal: last.creditCheckpointPremiumTotal ?? 0 } : undefined;
  }

  /**
   * Get session cost
   */
  getSessionCost(sessionId: string): number {
    return this.entries
      .filter((e) => e.sessionId === sessionId)
      .reduce((sum, e) => sum + e.cost, 0);
  }

  /**
   * Get daily cost
   */
  getDailyCost(): number {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    return this.getSummary(startOfDay.getTime()).totalCost;
  }

  /**
   * Get weekly cost
   */
  getWeeklyCost(): number {
    const startOfWeek = new Date();
    startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());
    startOfWeek.setHours(0, 0, 0, 0);
    return this.getSummary(startOfWeek.getTime()).totalCost;
  }

  /**
   * Get monthly cost
   */
  getMonthlyCost(): number {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    return this.getSummary(startOfMonth.getTime()).totalCost;
  }

  /**
   * Set budget configuration
   */
  setBudget(config: Partial<BudgetConfig>): void {
    this.budget = { ...this.budget, ...config };
    this.alertedThresholds.clear(); // Reset alerts on config change
    this.emit('budget-updated', this.budget);
  }

  /**
   * Get budget configuration
   */
  getBudget(): BudgetConfig {
    return { ...this.budget };
  }

  /**
   * Get budget status
   */
  getBudgetStatus(): {
    daily: { usage: number; limit: number; percentage: number };
    weekly: { usage: number; limit: number; percentage: number };
    monthly: { usage: number; limit: number; percentage: number };
  } {
    const daily = this.getDailyCost();
    const weekly = this.getWeeklyCost();
    const monthly = this.getMonthlyCost();

    return {
      daily: {
        usage: daily,
        limit: this.budget.dailyLimit,
        percentage: this.budget.dailyLimit > 0 ? (daily / this.budget.dailyLimit) * 100 : 0,
      },
      weekly: {
        usage: weekly,
        limit: this.budget.weeklyLimit,
        percentage: this.budget.weeklyLimit > 0 ? (weekly / this.budget.weeklyLimit) * 100 : 0,
      },
      monthly: {
        usage: monthly,
        limit: this.budget.monthlyLimit,
        percentage: this.budget.monthlyLimit > 0 ? (monthly / this.budget.monthlyLimit) * 100 : 0,
      },
    };
  }

  /**
   * Check and emit budget alerts
   */
  private checkBudgetAlerts(sessionId: string): void {
    if (!this.budget.enabled) return;

    const checks: { type: BudgetAlert['type']; usage: number; limit: number }[] = [
      { type: 'daily', usage: this.getDailyCost(), limit: this.budget.dailyLimit },
      { type: 'weekly', usage: this.getWeeklyCost(), limit: this.budget.weeklyLimit },
      { type: 'monthly', usage: this.getMonthlyCost(), limit: this.budget.monthlyLimit },
      { type: 'session', usage: this.getSessionCost(sessionId), limit: this.budget.perSessionLimit },
    ];

    for (const check of checks) {
      if (check.limit <= 0) continue;

      const percentage = (check.usage / check.limit) * 100;

      for (const threshold of this.budget.alertThresholds) {
        // A threshold reached in one session must not silence every other
        // session. Dollar-based alerts already account for cache discounts;
        // gross token totals must not drive paid compaction here.
        const alertKey = check.type === 'session'
          ? `session-${JSON.stringify(sessionId)}-${threshold}`
          : `${check.type}-${threshold}`;
        if (percentage >= threshold && !this.alertedThresholds.has(alertKey)) {
          this.alertedThresholds.add(alertKey);

          const alert: BudgetAlert = {
            type: check.type,
            threshold,
            currentUsage: check.usage,
            limit: check.limit,
            timestamp: Date.now(),
          };

          this.emit('budget-alert', alert);
        }
      }
    }
  }

  /**
   * Get all entries for export
   */
  getEntries(limit?: number): CostEntry[] {
    if (limit) {
      return this.entries.slice(-limit);
    }
    return [...this.entries];
  }

  /**
   * Clear all entries
   */
  clearEntries(): void {
    this.entries = [];
    this.unpersistedIds.clear();
    this.alertedThresholds.clear();
    if (this.db) {
      try {
        this.db.transaction(() => {
          this.db!.prepare('DELETE FROM cost_entry_model_usage').run();
          this.db!.prepare('DELETE FROM cost_entries').run();
        })();
      } catch (err) {
        logger.warn('Failed to clear persisted cost entries', { error: String(err) });
      }
    }
    this.emit('entries-cleared');
  }

  /**
   * Delete persisted cost entries older than `olderThanMs` and drop them from
   * the in-memory window too. Returns the number of rows deleted. Best-effort;
   * no-op when persistence is not enabled.
   */
  cleanup(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    this.entries = this.entries.filter((e) => e.timestamp >= cutoff);
    const keptIds = new Set(this.entries.map((e) => e.id));
    this.unpersistedIds = new Set([...this.unpersistedIds].filter((id) => keptIds.has(id)));
    if (!this.db) return 0;
    try {
      const result = this.db.transaction(() => {
        this.db!.prepare('DELETE FROM cost_entry_model_usage WHERE entry_id IN (SELECT id FROM cost_entries WHERE timestamp < ?)').run(cutoff);
        return this.db!.prepare('DELETE FROM cost_entries WHERE timestamp < ?').run(cutoff);
      })();
      logger.info('CostTracker cleanup complete', { deleted: result.changes, cutoff });
      return result.changes;
    } catch (err) {
      logger.warn('CostTracker cleanup failed', { error: String(err) });
      return 0;
    }
  }

  /**
   * Reset daily alerts (call at midnight)
   */
  resetDailyAlerts(): void {
    for (const key of this.alertedThresholds) {
      if (key.startsWith('daily-')) {
        this.alertedThresholds.delete(key);
      }
    }
  }
}

// Singleton instance
let costTrackerInstance: CostTracker | null = null;

export function getCostTracker(): CostTracker {
  if (!costTrackerInstance) {
    costTrackerInstance = new CostTracker();
  }
  return costTrackerInstance;
}
