import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import {
  createMigrationsTable,
  createTables,
  runMigrations,
} from './rlm-schema';
import {
  getCompactionMarker,
  recordCompactionMarker,
} from './rlm-compaction-markers';

const dbs: SqliteDriver[] = [];

function openMigratedDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

describe('RLM compaction markers', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) {
      db.close();
    }
  });

  it('creates the marker table via migration 039', () => {
    const db = openMigratedDb();
    const migration = db
      .prepare('SELECT name FROM _migrations WHERE name = ?')
      .get<{ name: string }>('039_add_session_compaction_markers');
    const columns = db
      .prepare('PRAGMA table_info(session_compaction_markers)')
      .all<{ name: string }>()
      .map((column) => column.name);

    expect(migration?.name).toBe('039_add_session_compaction_markers');
    expect(columns).toEqual([
      'id',
      'instance_id',
      'thread_id',
      'project_key',
      'method',
      'created_at',
      'utilization_before',
      'utilization_after',
      'ledger_anchor',
      'metadata_json',
    ]);
  });

  it('records marker metadata', () => {
    const db = openMigratedDb();
    recordCompactionMarker(db, {
      id: 'old',
      instanceId: 'inst-1',
      threadId: 'thread-1',
      projectKey: '/repo',
      method: 'native',
      createdAt: 100,
      utilizationBefore: 92,
      utilizationAfter: 0,
      ledgerAnchor: 99,
      metadata: { source: 'manual' },
    });
    recordCompactionMarker(db, {
      id: 'new',
      instanceId: 'inst-1',
      projectKey: '/repo',
      method: 'thread-compacted',
      createdAt: 200,
    });

    expect(getCompactionMarker(db, 'old')).toMatchObject({
      id: 'old',
      threadId: 'thread-1',
      utilizationBefore: 92,
      utilizationAfter: 0,
      metadata: { source: 'manual' },
    });
    expect(getCompactionMarker(db, 'new')).toMatchObject({
      id: 'new',
      method: 'thread-compacted',
      ledgerAnchor: 200,
    });
  });

  it('retrieves one marker by id', () => {
    const db = openMigratedDb();
    recordCompactionMarker(db, {
      id: 'marker-1',
      instanceId: 'inst-1',
      threadId: 'thread-1',
      projectKey: '/repo',
      method: 'self-managed',
      createdAt: 100,
      ledgerAnchor: 90,
      metadata: { source: 'provider-thread-compacted' },
    });

    expect(getCompactionMarker(db, 'marker-1')).toMatchObject({
      id: 'marker-1',
      instanceId: 'inst-1',
      threadId: 'thread-1',
      projectKey: '/repo',
      method: 'self-managed',
      ledgerAnchor: 90,
      metadata: { source: 'provider-thread-compacted' },
    });
    expect(getCompactionMarker(db, 'missing')).toBeNull();
  });
});
