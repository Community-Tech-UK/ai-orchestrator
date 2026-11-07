import { describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from './rlm-schema';
import { CostTracker } from '../../core/system/cost-tracker';
describe('Copilot credits migration and persistence', () => {
  it('adds nullable columns, persists a booking, reloads it and refuses a duplicate checkpoint', () => {
    const db = defaultDriverFactory(':memory:'); createTables(db); createMigrationsTable(db); runMigrations(db);
    try {
      const columns = db.prepare('PRAGMA table_info(cost_entries)').all<{ name: string; notnull: number }>();
      for (const name of ['ai_credits_nano', 'premium_requests', 'credit_checkpoint_id', 'credit_checkpoint_total_nano', 'credit_checkpoint_premium_total', 'provider']) {
        expect(columns.find(c => c.name === name)?.notnull).toBe(0);
      }
      const tracker = new CostTracker(); tracker.setDatabase(db);
      const entry = tracker.recordUsage('i', 's', 'gpt', 1, 1, 0, 0, 0, 0, false, { provider: 'copilot' });
      expect(db.prepare('SELECT ai_credits_nano FROM cost_entries WHERE id = ?').get(entry.id)).toEqual({ ai_credits_nano: null });
      expect(tracker.attachProviderCredits(entry.id, { creditsNano: 3e9, premiumRequests: 1, checkpointEventId: 'booked', checkpointTotalNano: 8e9, checkpointPremiumTotal: 6 })).toBe(true);
      expect(entry.aiCreditsNano).toBe(3e9);
      const restored = new CostTracker(); restored.setDatabase(db);
      expect(restored.getEntries()[0]).toMatchObject({ aiCreditsNano: 3e9, provider: 'copilot' });
      expect(restored.getLastProviderCreditCheckpoint('s')).toEqual({ eventId: 'booked', totalNano: 8e9, premiumTotal: 6 });
      expect(restored.attachProviderCredits(entry.id, { creditsNano: 99, premiumRequests: 99, checkpointEventId: 'booked', checkpointTotalNano: 99 })).toBe(false);
    } finally { db.close(); }
  });
});
