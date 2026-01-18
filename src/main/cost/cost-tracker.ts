/**
 * Cost Tracker - Model pricing and budget management (5.3)
 *
 * Tracks API costs per model, session, and overall with budget alerts.
 */

import { EventEmitter } from 'events';
import { MODEL_PRICING } from '../../shared/types/provider.types';

/**
 * Cost entry for a single API call
 */
export interface CostEntry {
  id: string;
  timestamp: number;
  instanceId: string;
  sessionId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost: number;
}

/**
 * Cost summary for a time period or session
 */
export interface CostSummary {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  byModel: Record<string, {
    cost: number;
    inputTokens: number;
    outputTokens: number;
    requests: number;
  }>;
  bySession: Record<string, {
    cost: number;
    tokens: number;
    requests: number;
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
  private budget: BudgetConfig = { ...DEFAULT_BUDGET };
  private alertedThresholds: Set<string> = new Set();
  private maxEntries: number = 10000;

  /**
   * Calculate cost for a given usage
   */
  calculateCost(
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number = 0,
    cacheWriteTokens: number = 0
  ): number {
    const pricing = MODEL_PRICING[model];
    if (!pricing) {
      // Use default pricing if model not found
      return (inputTokens * 3 + outputTokens * 15) / 1_000_000;
    }

    // Cache read tokens are typically 90% cheaper
    // Cache write tokens have same cost as regular input
    const inputCost = (inputTokens * pricing.input) / 1_000_000;
    const outputCost = (outputTokens * pricing.output) / 1_000_000;
    const cacheReadCost = (cacheReadTokens * pricing.input * 0.1) / 1_000_000;
    const cacheWriteCost = (cacheWriteTokens * pricing.input) / 1_000_000;

    return inputCost + outputCost + cacheReadCost + cacheWriteCost;
  }

  /**
   * Record a cost entry
   */
  recordUsage(
    instanceId: string,
    sessionId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens: number = 0,
    cacheWriteTokens: number = 0
  ): CostEntry {
    const cost = this.calculateCost(model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens);

    const entry: CostEntry = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      instanceId,
      sessionId,
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      cost,
    };

    this.entries.push(entry);

    // Prune old entries if needed
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(-this.maxEntries);
    }

    // Check budget alerts
    this.checkBudgetAlerts(sessionId);

    this.emit('cost-recorded', entry);
    return entry;
  }

  /**
   * Get cost summary for a time range
   */
  getSummary(startTime?: number, endTime?: number): CostSummary {
    const start = startTime || 0;
    const end = endTime || Date.now();

    const filtered = this.entries.filter(
      (e) => e.timestamp >= start && e.timestamp <= end
    );

    const byModel: CostSummary['byModel'] = {};
    const bySession: CostSummary['bySession'] = {};
    let totalCost = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheReadTokens = 0;
    let totalCacheWriteTokens = 0;

    for (const entry of filtered) {
      totalCost += entry.cost;
      totalInputTokens += entry.inputTokens;
      totalOutputTokens += entry.outputTokens;
      totalCacheReadTokens += entry.cacheReadTokens || 0;
      totalCacheWriteTokens += entry.cacheWriteTokens || 0;

      // By model
      if (!byModel[entry.model]) {
        byModel[entry.model] = { cost: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
      }
      byModel[entry.model].cost += entry.cost;
      byModel[entry.model].inputTokens += entry.inputTokens;
      byModel[entry.model].outputTokens += entry.outputTokens;
      byModel[entry.model].requests += 1;

      // By session
      if (!bySession[entry.sessionId]) {
        bySession[entry.sessionId] = { cost: 0, tokens: 0, requests: 0 };
      }
      bySession[entry.sessionId].cost += entry.cost;
      bySession[entry.sessionId].tokens += entry.inputTokens + entry.outputTokens;
      bySession[entry.sessionId].requests += 1;
    }

    return {
      totalCost,
      totalInputTokens,
      totalOutputTokens,
      totalCacheReadTokens,
      totalCacheWriteTokens,
      byModel,
      bySession,
      requestCount: filtered.length,
      startTime: start,
      endTime: end,
    };
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

    const checks: Array<{ type: BudgetAlert['type']; usage: number; limit: number }> = [
      { type: 'daily', usage: this.getDailyCost(), limit: this.budget.dailyLimit },
      { type: 'weekly', usage: this.getWeeklyCost(), limit: this.budget.weeklyLimit },
      { type: 'monthly', usage: this.getMonthlyCost(), limit: this.budget.monthlyLimit },
      { type: 'session', usage: this.getSessionCost(sessionId), limit: this.budget.perSessionLimit },
    ];

    for (const check of checks) {
      if (check.limit <= 0) continue;

      const percentage = (check.usage / check.limit) * 100;

      for (const threshold of this.budget.alertThresholds) {
        const alertKey = `${check.type}-${threshold}`;
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
    this.alertedThresholds.clear();
    this.emit('entries-cleared');
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
