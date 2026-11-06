import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver, SqliteStatement } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import type { LocalAiRoutingEvent } from '../../shared/types/local-ai-guard.types';
import { getLocalAiFallbackSpend, type LocalAiFallbackSpendQuery } from './local-ai-fallback-spend';
import { LocalAiHealthRepository } from './local-ai-health-repository';

const dbs: SqliteDriver[] = [];

function openMigratedDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

function routingEvent(
  id: string,
  patch: Partial<LocalAiRoutingEvent> = {},
): LocalAiRoutingEvent {
  return {
    id,
    slot: 'compression',
    intendedRoute: 'local',
    actualRoute: 'local',
    policy: 'notify-and-allow',
    disposition: 'not-needed',
    decisionReason: 'health',
    provider: 'openai-compatible',
    model: 'qwen/qwen3.6-35b-a3b',
    inputTokens: 1_000,
    outputTokens: 100,
    estimatedCostUsd: 0.5,
    createdAt: 1_000,
    completedAt: 1_000,
    ...patch,
  };
}

/** Run one spend query and return SQLite's plan for the SQL it actually executed. */
function spendPlan(db: SqliteDriver, query: LocalAiFallbackSpendQuery): string {
  const original = db.prepareCached.bind(db);
  let plan = '';
  const spy = vi.spyOn(db, 'prepareCached').mockImplementation((sql) => {
    const statement = original(sql);
    if (!sql.includes('unknown_reservations')) return statement;
    const explained: SqliteStatement = {
      run: (...params) => statement.run(...params),
      all: <T = unknown>(...params: unknown[]) => statement.all<T>(...params),
      get<T = unknown>(...params: unknown[]) {
        plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all<{ detail: string }>(...params)
          .map((row) => row.detail)
          .join('\n');
        return statement.get<T>(...params);
      },
    };
    return explained;
  });
  getLocalAiFallbackSpend(db, query);
  spy.mockRestore();
  return plan;
}

describe('getLocalAiFallbackSpend', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('sums only paid-fallback rows and ignores local completions', () => {
    const db = openMigratedDb();
    const health = new LocalAiHealthRepository(db);
    health.appendRoutingEvent(routingEvent('local-1'));
    health.appendRoutingEvent(routingEvent('paid-1', {
      actualRoute: 'frontier',
      disposition: 'allowed',
      decisionReason: 'policy',
      estimatedCostUsd: 0.25,
    }));

    expect(getLocalAiFallbackSpend(db, { since: 0, until: 2_000 })).toEqual({
      knownCostUsd: 0,
      estimatedCostUsd: 0.25,
      unknownReservations: 0,
    });
  });

  // Local completions are written for every successful local auxiliary call
  // (~2.7k rows/day). Budget checks run on each fallback, so they must not
  // read those rows: migration 068 adds partial indexes over paid rows only.
  it.each([
    ['global day', { since: 0, until: 2_000 }, 'idx_local_ai_routing_events_spend'],
    ['per target', { since: 0, until: 2_000, targetId: 'target-1' }, 'idx_local_ai_routing_events_spend_target'],
    ['per incident', { since: 0, until: 2_000, incidentId: 'incident-1', excludeEventId: 'x' }, 'idx_local_ai_routing_events_spend_incident'],
    ['open reservations', { since: 0, until: 2_000, reservationsOnly: true }, 'idx_local_ai_routing_events_spend'],
  ] as const)('reads the %s spend through a paid-rows-only index', (_label, query, index) => {
    const db = openMigratedDb();
    const health = new LocalAiHealthRepository(db);
    for (let n = 0; n < 200; n += 1) {
      health.appendRoutingEvent(routingEvent(`local-${n}`, { targetId: undefined }));
    }
    db.exec('ANALYZE');

    const plan = spendPlan(db, query);

    expect(plan).toContain(index);
    expect(plan).not.toMatch(/SCAN local_ai_routing_events(?! USING)/);
  });

  it('registers migration 068 and is idempotent on re-run', () => {
    const db = openMigratedDb();
    runMigrations(db);

    expect(db.prepare('SELECT name FROM _migrations WHERE name = ?')
      .get<{ name: string }>('068_local_ai_routing_spend_indexes'))
      .toEqual({ name: '068_local_ai_routing_spend_indexes' });
    const indexes = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'idx_local_ai_routing_events_spend%'
      ORDER BY name
    `).all<{ name: string }>().map((row) => row.name);
    expect(indexes).toEqual([
      'idx_local_ai_routing_events_spend',
      'idx_local_ai_routing_events_spend_incident',
      'idx_local_ai_routing_events_spend_target',
    ]);
  });
});

describe('getLocalAiFallbackSpend unknown-cost reservations (Step 7)', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const UNTIL = 10 * DAY_MS;

  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  function paid(id: string, patch: Partial<LocalAiRoutingEvent> = {}): LocalAiRoutingEvent {
    const { estimatedCostUsd: _estimate, completedAt: _completed, ...base } = routingEvent(id);
    return {
      ...base,
      actualRoute: 'frontier',
      disposition: 'allowed',
      decisionReason: 'policy',
      createdAt: UNTIL - 1_000,
      ...patch,
    };
  }

  it('counts a fresh open reservation with no cost as unknown', () => {
    const db = openMigratedDb();
    const health = new LocalAiHealthRepository(db);
    health.appendRoutingEvent(paid('fresh-open', { createdAt: UNTIL - 60 * 60 * 1000 }));

    expect(getLocalAiFallbackSpend(db, { since: UNTIL - DAY_MS, until: UNTIL }))
      .toEqual({ knownCostUsd: 0, estimatedCostUsd: 0, unknownReservations: 1 });
  });

  it('ignores open unknown reservations older than 24 hours, however many there are', () => {
    const db = openMigratedDb();
    const health = new LocalAiHealthRepository(db);
    for (let n = 0; n < 50; n += 1) {
      health.appendRoutingEvent(paid(`stale-${n}`, { createdAt: UNTIL - DAY_MS - 1 - n * 1_000 }));
    }

    expect(getLocalAiFallbackSpend(db, { since: UNTIL - DAY_MS, until: UNTIL }).unknownReservations)
      .toBe(0);
    expect(getLocalAiFallbackSpend(db, { since: 0, until: UNTIL, reservationsOnly: true }).unknownReservations)
      .toBe(0);
  });

  it('keeps the boundary at exactly 24 hours inside the bound', () => {
    const db = openMigratedDb();
    const health = new LocalAiHealthRepository(db);
    health.appendRoutingEvent(paid('exactly-24h', { createdAt: UNTIL - DAY_MS }));
    health.appendRoutingEvent(paid('just-over-24h', { createdAt: UNTIL - DAY_MS - 1 }));

    expect(getLocalAiFallbackSpend(db, { since: 0, until: UNTIL }).unknownReservations).toBe(1);
  });

  it('still counts a completed row with no cost as unknown, whatever its age', () => {
    const db = openMigratedDb();
    const health = new LocalAiHealthRepository(db);
    health.appendRoutingEvent(paid('completed-unknown', {
      createdAt: UNTIL - 5 * DAY_MS,
      completedAt: UNTIL - 1_000,
    }));

    expect(getLocalAiFallbackSpend(db, { since: UNTIL - DAY_MS, until: UNTIL }).unknownReservations)
      .toBe(1);
  });

  it('never ages out an open reservation that carries an estimate or a known cost', () => {
    const db = openMigratedDb();
    const health = new LocalAiHealthRepository(db);
    health.appendRoutingEvent(paid('old-estimated', {
      createdAt: UNTIL - 3 * DAY_MS,
      estimatedCostUsd: 0.25,
    }));
    health.appendRoutingEvent(paid('old-known', {
      createdAt: UNTIL - 3 * DAY_MS,
      knownCostUsd: 0.5,
    }));

    expect(getLocalAiFallbackSpend(db, { since: UNTIL - DAY_MS, until: UNTIL })).toEqual({
      knownCostUsd: 0.5,
      estimatedCostUsd: 0.25,
      unknownReservations: 0,
    });
  });
});
