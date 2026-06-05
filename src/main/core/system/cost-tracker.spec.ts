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

  it('emits cost-recorded so downstream consumers (e.g. the cost circuit breaker) observe spend', () => {
    const seen: Array<{ instanceId: string; cost: number }> = [];
    tracker.on('cost-recorded', (e) => seen.push({ instanceId: e.instanceId, cost: e.cost }));
    tracker.recordUsage('inst-9', 'sess-9', 'claude-sonnet-4-6', 100, 50, 0, 0, 0.005);
    expect(seen).toEqual([{ instanceId: 'inst-9', cost: 0.005 }]);
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

  it('write-through persists every recorded turn to the table', () => {
    const tracker = new CostTracker();
    tracker.setDatabase(db);
    tracker.recordUsage('inst-1', 'sess-1', 'claude-sonnet-4-6', 1000, 500, 10, 5, 0.0731);

    const row = db
      .prepare('SELECT * FROM cost_entries')
      .get<{ instance_id: string; session_id: string; cost: number; cache_read_tokens: number }>();
    expect(row?.instance_id).toBe('inst-1');
    expect(row?.session_id).toBe('sess-1');
    expect(row?.cost).toBeCloseTo(0.0731, 10);
    expect(row?.cache_read_tokens).toBe(10);
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
