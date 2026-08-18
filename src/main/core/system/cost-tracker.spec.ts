import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CostTracker } from './cost-tracker';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../../persistence/rlm/rlm-schema';

function createDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

describe('CostTracker.recordUsage', () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  it('derives cost from the per-model token rate table when no override is given', () => {
    const entry = tracker.recordUsage('inst-1', 'sess-1', 'claude-sonnet-4-6', 1000, 500);
    expect(entry.cost).toBeGreaterThan(0);
    // calculateCost is the source of truth when there is no provider cost.
    expect(entry.cost).toBeCloseTo(
      tracker.calculateCost('claude-sonnet-4-6', 1000, 500),
      10,
    );
  });

  it('trusts a finite, non-negative provider-supplied cost verbatim', () => {
    const entry = tracker.recordUsage('inst-1', 'sess-1', 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.0731);
    expect(entry.cost).toBe(0.0731);
  });

  it('accepts a provider cost of exactly 0 (e.g. fully-cached / subscription turns)', () => {
    const entry = tracker.recordUsage('inst-1', 'sess-1', 'claude-sonnet-4-6', 1000, 500, 0, 0, 0);
    expect(entry.cost).toBe(0);
  });

  it('ignores a non-finite or negative override and falls back to computed cost', () => {
    const computed = tracker.calculateCost('claude-sonnet-4-6', 1000, 500);
    const nan = tracker.recordUsage('inst-1', 'sess-1', 'claude-sonnet-4-6', 1000, 500, 0, 0, Number.NaN);
    const negative = tracker.recordUsage('inst-1', 'sess-1', 'claude-sonnet-4-6', 1000, 500, 0, 0, -5);
    expect(nan.cost).toBeCloseTo(computed, 10);
    expect(negative.cost).toBeCloseTo(computed, 10);
  });

  it('stores cache token counts on the entry and in summaries', () => {
    tracker.recordUsage('inst-1', 'sess-1', 'claude-sonnet-4-6', 1000, 500, 200, 100, 0.01);
    const summary = tracker.getSummary();
    expect(summary.totalCacheReadTokens).toBe(200);
    expect(summary.totalCacheWriteTokens).toBe(100);
    expect(summary.totalCost).toBeCloseTo(0.01, 10);
  });

  it('stores reasoning token counts separately and bills them at the output rate', () => {
    const computed = tracker.calculateCost('claude-sonnet-4-6', 0, 0, 0, 0, 1_000_000);
    const entry = tracker.recordUsage(
      'inst-1',
      'sess-1',
      'claude-sonnet-4-6',
      0,
      0,
      0,
      0,
      undefined,
      1_000_000,
    );
    const summary = tracker.getSummary();
    expect(entry.reasoningTokens).toBe(1_000_000);
    expect(entry.cost).toBeCloseTo(computed, 10);
    expect(summary.totalReasoningTokens).toBe(1_000_000);
    expect(summary.byModel['claude-sonnet-4-6']?.reasoningTokens).toBe(1_000_000);
    expect(summary.bySession['sess-1']?.tokens).toBe(1_000_000);
  });

  it('emits cost-recorded so downstream consumers (e.g. the cost circuit breaker) observe spend', () => {
    const seen: Array<{ instanceId: string; cost: number }> = [];
    tracker.on('cost-recorded', (e) => seen.push({ instanceId: e.instanceId, cost: e.cost }));
    tracker.recordUsage('inst-9', 'sess-9', 'claude-sonnet-4-6', 100, 50, 0, 0, 0.005);
    expect(seen).toEqual([{ instanceId: 'inst-9', cost: 0.005 }]);
  });

  // LT-100: ACP-transport providers (Cursor/Grok/Copilot) whose server sends
  // no `usage` now record a heuristic-estimate entry instead of zero. Every
  // read surface must be able to tell it apart from a measured entry.
  describe('LT-100 — isEstimated', () => {
    it('defaults isEstimated to false when the caller does not pass it', () => {
      const entry = tracker.recordUsage('inst-1', 'sess-1', 'claude-sonnet-4-6', 100, 50, 0, 0, 0.001);
      expect(entry.isEstimated).toBe(false);
    });

    it('tags an entry isEstimated when the caller says so', () => {
      const entry = tracker.recordUsage(
        'inst-1', 'sess-1', 'cursor-composer', 40, 60, 0, 0, undefined, 0, true,
      );
      expect(entry.isEstimated).toBe(true);
    });

    it('rolls estimated entries into totalEstimatedCost and hasEstimatedEntries without hiding them from totalCost', () => {
      tracker.recordUsage('inst-1', 'sess-1', 'claude-sonnet-4-6', 100, 50, 0, 0, 0.01, 0, false);
      tracker.recordUsage('inst-2', 'sess-2', 'cursor-composer', 40, 60, 0, 0, 0.02, 0, true);

      const summary = tracker.getSummary();
      expect(summary.totalCost).toBeCloseTo(0.03, 10);
      expect(summary.hasEstimatedEntries).toBe(true);
      expect(summary.totalEstimatedCost).toBeCloseTo(0.02, 10);
    });

    it('reports hasEstimatedEntries: false and totalEstimatedCost: 0 when nothing is estimated', () => {
      tracker.recordUsage('inst-1', 'sess-1', 'claude-sonnet-4-6', 100, 50, 0, 0, 0.01);
      const summary = tracker.getSummary();
      expect(summary.hasEstimatedEntries).toBe(false);
      expect(summary.totalEstimatedCost).toBe(0);
    });

    it('flags hasEstimated per model and per session only when that group contains an estimate', () => {
      tracker.recordUsage('inst-1', 'sess-1', 'claude-sonnet-4-6', 100, 50, 0, 0, 0.01, 0, false);
      tracker.recordUsage('inst-2', 'sess-2', 'cursor-composer', 40, 60, 0, 0, 0.02, 0, true);

      const summary = tracker.getSummary();
      expect(summary.byModel['claude-sonnet-4-6']?.hasEstimated).toBe(false);
      expect(summary.byModel['cursor-composer']?.hasEstimated).toBe(true);
      expect(summary.bySession['sess-1']?.hasEstimated).toBe(false);
      expect(summary.bySession['sess-2']?.hasEstimated).toBe(true);
    });
  });
});

describe('CostTracker persistence (E15)', () => {
  let db: SqliteDriver;

  beforeEach(() => {
    db = createDb();
  });

  afterEach(() => {
    db.close();
  });

  it('creates the cost_entries table via migration 036', () => {
    const migration = db
      .prepare('SELECT name FROM _migrations WHERE name = ?')
      .get<{ name: string }>('036_add_cost_entries_table');
    expect(migration?.name).toBe('036_add_cost_entries_table');
  });

  it('adds reasoning token persistence via migration 037', () => {
    const migration = db
      .prepare('SELECT name FROM _migrations WHERE name = ?')
      .get<{ name: string }>('037_add_cost_entry_reasoning_tokens');
    const column = db
      .prepare('PRAGMA table_info(cost_entries)')
      .all<{ name: string }>()
      .find((c) => c.name === 'reasoning_tokens');
    expect(migration?.name).toBe('037_add_cost_entry_reasoning_tokens');
    expect(column?.name).toBe('reasoning_tokens');
  });

  it('write-through persists every recorded turn to the table', () => {
    const tracker = new CostTracker();
    tracker.setDatabase(db);
    tracker.recordUsage('inst-1', 'sess-1', 'claude-sonnet-4-6', 1000, 500, 10, 5, 0.0731, 12);

    const row = db
      .prepare('SELECT * FROM cost_entries')
      .get<{ instance_id: string; session_id: string; cost: number; cache_read_tokens: number; reasoning_tokens: number }>();
    expect(row?.instance_id).toBe('inst-1');
    expect(row?.session_id).toBe('sess-1');
    expect(row?.cost).toBeCloseTo(0.0731, 10);
    expect(row?.cache_read_tokens).toBe(10);
    expect(row?.reasoning_tokens).toBe(12);
  });

  it('adds is_estimated persistence via migration 059 (LT-100), defaulting existing/omitted rows to measured', () => {
    const migration = db
      .prepare('SELECT name FROM _migrations WHERE name = ?')
      .get<{ name: string }>('059_cost_entries_is_estimated');
    expect(migration?.name).toBe('059_cost_entries_is_estimated');

    const column = db
      .prepare('PRAGMA table_info(cost_entries)')
      .all<{ name: string; dflt_value: string }>()
      .find((c) => c.name === 'is_estimated');
    expect(column?.name).toBe('is_estimated');
    expect(column?.dflt_value).toBe('0');

    const tracker = new CostTracker();
    tracker.setDatabase(db);
    tracker.recordUsage('inst-est', 'sess-est', 'cursor-composer', 40, 60, 0, 0, undefined, 0, true);
    tracker.recordUsage('inst-measured', 'sess-measured', 'claude-sonnet-4-6', 100, 50, 0, 0, 0.01);

    const rows = db
      .prepare('SELECT instance_id, is_estimated FROM cost_entries ORDER BY instance_id')
      .all<{ instance_id: string; is_estimated: number }>();
    expect(rows).toEqual([
      { instance_id: 'inst-est', is_estimated: 1 },
      { instance_id: 'inst-measured', is_estimated: 0 },
    ]);

    // Rehydration round-trips the flag correctly too.
    const rehydrated = new CostTracker();
    rehydrated.setDatabase(db);
    const entries = rehydrated.getEntries();
    expect(entries.find((e) => e.instanceId === 'inst-est')?.isEstimated).toBe(true);
    expect(entries.find((e) => e.instanceId === 'inst-measured')?.isEstimated).toBe(false);
  });

  it('rehydrates history on a fresh tracker pointed at the same DB (survives restart)', () => {
    const first = new CostTracker();
    first.setDatabase(db);
    first.recordUsage('inst-1', 'sess-1', 'claude-sonnet-4-6', 1000, 500, 0, 0, 0.02);
    first.recordUsage('inst-2', 'sess-2', 'claude-sonnet-4-6', 2000, 800, 0, 0, 0.05);

    // Simulate a restart: brand-new tracker (empty in-memory) bound to the same DB.
    const second = new CostTracker();
    expect(second.getEntries()).toHaveLength(0);
    second.setDatabase(db);

    const entries = second.getEntries();
    expect(entries).toHaveLength(2);
    // Chronological order preserved.
    expect(entries.map((e) => e.instanceId)).toEqual(['inst-1', 'inst-2']);
    expect(second.getSummary().totalCost).toBeCloseTo(0.07, 10);
  });

  it('clearEntries removes persisted rows too', () => {
    const tracker = new CostTracker();
    tracker.setDatabase(db);
    tracker.recordUsage('inst-1', 'sess-1', 'claude-sonnet-4-6', 100, 50, 0, 0, 0.01);
    tracker.clearEntries();

    const count = db.prepare('SELECT COUNT(*) AS n FROM cost_entries').get<{ n: number }>();
    expect(count?.n).toBe(0);
    expect(tracker.getEntries()).toHaveLength(0);
  });

  it('cleanup deletes rows older than the cutoff from DB and memory', () => {
    const tracker = new CostTracker();
    tracker.setDatabase(db);
    const e = tracker.recordUsage('inst-1', 'sess-1', 'claude-sonnet-4-6', 100, 50, 0, 0, 0.01);
    // Backdate the persisted row well beyond the retention window.
    db.prepare('UPDATE cost_entries SET timestamp = ? WHERE id = ?').run(e.timestamp - 100_000, e.id);

    const deleted = tracker.cleanup(10_000);
    expect(deleted).toBe(1);
    const count = db.prepare('SELECT COUNT(*) AS n FROM cost_entries').get<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it('flushes entries recorded before setDatabase so none are lost on attach', () => {
    const tracker = new CostTracker();
    // Recorded while in-memory only (no DB yet).
    tracker.recordUsage('inst-early', 'sess-early', 'claude-sonnet-4-6', 100, 50, 0, 0, 0.03);
    tracker.setDatabase(db);

    const row = db
      .prepare('SELECT * FROM cost_entries WHERE instance_id = ?')
      .get<{ cost: number }>('inst-early');
    expect(row?.cost).toBeCloseTo(0.03, 10);
    // Still exactly one entry in memory (flush + reload is idempotent, no dupes).
    expect(tracker.getEntries()).toHaveLength(1);
  });

  it('stays in-memory-only and never throws when no DB is attached', () => {
    const tracker = new CostTracker();
    expect(() => tracker.recordUsage('inst-1', 'sess-1', 'claude-sonnet-4-6', 100, 50, 0, 0, 0.01)).not.toThrow();
    expect(tracker.getEntries()).toHaveLength(1);
    expect(tracker.cleanup(0)).toBe(0);
  });
});
