import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../../persistence/rlm/rlm-schema';
import { repairCostEntriesA0 } from './cost-entries-a0-repair';
import { _resetCostAttributionForTesting } from './cost-attribution';
import { CostPurposeSummaryService, getCostPurposeSummary } from './cost-purpose-summary';

describe('legacy resident Claude purpose totals', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'cost-purpose-history-'));
    vi.stubEnv('AIO_COST_ATTRIBUTION_DIR', directory);
    _resetCostAttributionForTesting();
    CostPurposeSummaryService._resetForTesting();
  });
  afterEach(() => {
    CostPurposeSummaryService._resetForTesting();
    _resetCostAttributionForTesting();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it('preserves legacy logs and excludes unreconciled totals without differencing new deltas', () => {
    const at = Date.parse('2026-10-10T12:00:00Z');
    const db = defaultDriverFactory(':memory:');
    try {
      createTables(db); createMigrationsTable(db); runMigrations(db);
      db.prepare("UPDATE maintenance_markers SET completed_at=? WHERE name='a0-per-turn-booking-live'").run(at + 2);
      const log = [0.5, 1.25, 0.3].map((cost, index) => {
        db.prepare(`INSERT INTO cost_entries(id,timestamp,instance_id,session_id,model,input_tokens,output_tokens,cost)
          VALUES(?,?,?,?,?,?,?,?)`).run(String(index), at + index, 'resident', 'native-session', 'opus', 10, 4, cost);
        // The original producer omitted sessionId and the new explicit costSource.
        return { ts: at + index, source: 'instance-turn', taskType: 'chat:build', instanceId: 'resident',
          provider: index === 1 ? 'claude-cli' : 'claude', model: 'opus', costKnown: true,
          usage: { inputTokens: 10, outputTokens: 4, cost }, ...(index === 2 ? { purpose: 'chat', costSource: 'provider' } : {}) };
      });
      const file = join(directory, 'cost-attribution-2026-10-10.jsonl');
      const original = log.map(row => JSON.stringify(row)).join('\n');
      writeFileSync(file, original);
      expect(repairCostEntriesA0(db, new Map())).toMatchObject({ status: 'repaired', beforeUsd: 1.75, afterUsd: 1.25 });
      expect(db.prepare('SELECT sum(cost) AS total FROM cost_entries').get<{ total: number }>()?.total).toBeCloseTo(1.55);
      const summary = getCostPurposeSummary().getSummary({ startTime: at, endTime: at + 3 });
      expect(summary.totals).toMatchObject({ calls: 3, cost: 0.3, unknownCostCalls: 2, historicalCostUnknownCalls: 2 });
      expect(summary.byPurpose.find(row => row.key === 'chat')?.cost).toBe(0.3);
      expect(summary.byProvider.find(row => row.key === 'claude-cli')?.cost).toBe(0);
      expect(getCostPurposeSummary().getSummary({ startTime: at + 2, endTime: at + 3 }).totals.cost).toBe(0.3);
      expect(readFileSync(file, 'utf8')).toBe(original);
    } finally { db.close(); }
  });
});
