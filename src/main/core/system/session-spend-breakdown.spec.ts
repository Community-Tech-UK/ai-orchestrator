import { describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../../persistence/rlm/rlm-schema';
import { CostTracker } from './cost-tracker';
import { getSessionSpendBreakdown } from './session-spend-breakdown';
describe('database session spend', () => {
  it('joins all child rows once and matches either instance or resumed session, including credits', () => {
    const db = defaultDriverFactory(':memory:'); createTables(db); createMigrationsTable(db); runMigrations(db);
    try {
      const tracker = new CostTracker(); tracker.setDatabase(db);
      tracker.recordUsage('old', 'resumed', 'claude-sonnet-4-6', 1000, 100, 0, 0, 0.5, 0, true, { byModel: [
        { model: 'claude-sonnet-4-6', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.2 },
        { model: 'claude-haiku-4-5-20251001', inputTokens: 5000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.3 },
      ] });
      const second = tracker.recordUsage('live', 'different', 'gpt', 10, 2, 0, 0, 0);
      tracker.attachProviderCredits(second.id, { creditsNano: 2e9, premiumRequests: 1, checkpointEventId: 'c', checkpointTotalNano: 2e9 });
      tracker.recordUsage('unrelated', 'other', 'model', 999, 999, 0, 0, 99);
      const result = getSessionSpendBreakdown(db, 'live', 'resumed');
      expect(result.turns).toBe(2);
      expect(result.totalCostUsd).toBe(0.5);
      expect(result.byModel).toHaveLength(3);
      expect(result.byModel.find(m => m.model.includes('haiku'))?.inputTokens).toBe(5000);
      expect(result.mainCostUsd + result.helperCostUsd).toBeCloseTo(result.totalCostUsd);
      expect(result.estimatedShare).toBe(1);
      expect(result.aiCreditsNano).toBe(2e9);
    } finally { db.close(); }
  });
});
