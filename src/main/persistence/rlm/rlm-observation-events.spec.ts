import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import type { ObservationEvent } from '../../../shared/types/observation-event.types';
import { MIGRATIONS, createMigrationsTable, createTables, runMigrations } from './rlm-schema';
import { listObservationEvents, recordObservationEvents } from './rlm-observation-events';
import { extractObservationEvents } from '../../context/observation-extractor';

const dbs: SqliteDriver[] = [];

function openMigratedDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

function event(overrides: Partial<ObservationEvent> = {}): ObservationEvent {
  return {
    id: 'obs_1',
    instanceId: 'inst-1',
    timestamp: 100,
    turn: 0,
    type: 'decision',
    priority: 1,
    content: 'use sqlite',
    sourceType: 'heuristic',
    ...overrides,
  };
}

describe('session_observation_events (migration 066)', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('does not duplicate decisions when the same transcript is extracted at a later compaction', () => {
    const db = openMigratedDb();
    const transcript = [
      { type: 'assistant', content: 'DECISION: store rows in SQLite', timestamp: 10 },
      { type: 'error', content: 'build failed', timestamp: 20 },
    ];

    recordObservationEvents(db, extractObservationEvents(transcript, { instanceId: 'inst-1' }));
    recordObservationEvents(db, extractObservationEvents(transcript, { instanceId: 'inst-1' }));

    expect(listObservationEvents(db, 'inst-1', { limit: 50 })).toHaveLength(2);
  });

  it('creates the table and its indexes, and is idempotent on re-run', () => {
    const db = openMigratedDb();
    runMigrations(db);

    expect(
      db.prepare('SELECT name FROM _migrations WHERE name = ?').get<{ name: string }>('066_session_observation_events'),
    ).toEqual({ name: '066_session_observation_events' });
    const columns = db.prepare('PRAGMA table_info(session_observation_events)').all<{ name: string }>().map((c) => c.name);
    expect(columns).toEqual([
      'id', 'instance_id', 'compaction_marker_id', 'timestamp', 'turn', 'type', 'priority',
      'content', 'metadata_json', 'source_type', 'created_at',
    ]);
    const indexes = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_session_observation_events%' ORDER BY name
    `).all<{ name: string }>().map((row) => row.name);
    expect(indexes).toEqual([
      'idx_session_observation_events_instance',
      'idx_session_observation_events_priority',
      'idx_session_observation_events_type',
    ]);
  });

  it('rejects unknown types and priorities', () => {
    const db = openMigratedDb();
    expect(() => recordObservationEvents(db, [event({ type: 'nope' as ObservationEvent['type'] })])).toThrow();
    expect(() => recordObservationEvents(db, [event({ priority: 7 as ObservationEvent['priority'] })])).toThrow();
  });

  it('round-trips events, ignores duplicate ids, and filters by instance and priority', () => {
    const db = openMigratedDb();
    const inserted = recordObservationEvents(db, [
      event({ metadata: { tag: 'DECISION' }, compactionMarkerId: 'cmark_1' }),
      event({ id: 'obs_2', turn: 1, type: 'tool_result', priority: 3, content: 'ls output' }),
      event({ id: 'obs_3', instanceId: 'inst-2' }),
    ], 5000);
    expect(inserted).toBe(3);
    expect(recordObservationEvents(db, [event({ content: 'changed' })])).toBe(0);

    expect(listObservationEvents(db, 'inst-1')).toEqual([
      event({ metadata: { tag: 'DECISION' }, compactionMarkerId: 'cmark_1' }),
      event({ id: 'obs_2', turn: 1, type: 'tool_result', priority: 3, content: 'ls output' }),
    ]);
    expect(listObservationEvents(db, 'inst-1', { maxPriority: 2 }).map((e) => e.id)).toEqual(['obs_1']);
    expect(listObservationEvents(db, 'inst-1', { limit: 1 }).map((e) => e.id)).toEqual(['obs_2']);
    expect(recordObservationEvents(db, [])).toBe(0);
  });

  it('down SQL removes the table', () => {
    const db = openMigratedDb();
    const migration = MIGRATIONS.find((m) => m.name === '066_session_observation_events');
    if (!migration) throw new Error('migration 066 missing');
    db.exec(migration.down);
    expect(db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'session_observation_events'`).get()).toBeUndefined();
  });
});
