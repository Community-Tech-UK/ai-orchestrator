import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from './rlm-schema';
import { RLM_MIGRATIONS_056_060 } from './rlm-migrations-056-060';

const dbs: SqliteDriver[] = [];

function openMigratedDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

describe('governed proposals migration 056', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('creates both tables and their indexes, and is idempotent on re-run', () => {
    const db = openMigratedDb();
    runMigrations(db); // second run must be a no-op

    expect(
      db.prepare('SELECT name FROM _migrations WHERE name = ?').get<{ name: string }>('056_governed_proposals'),
    ).toEqual({ name: '056_governed_proposals' });

    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('governed_proposals', 'proposal_audit')
      ORDER BY name
    `).all<{ name: string }>().map((row) => row.name);
    expect(tables).toEqual(['governed_proposals', 'proposal_audit']);

    const indexes = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_governed_proposals%' OR name = 'idx_proposal_audit_proposal'
      ORDER BY name
    `).all<{ name: string }>().map((row) => row.name);
    expect(indexes).toEqual([
      'idx_governed_proposals_created_at',
      'idx_governed_proposals_kind',
      'idx_governed_proposals_source_session',
      'idx_governed_proposals_status',
      'idx_proposal_audit_proposal',
    ]);
  });

  it('enforces kind and status CHECK constraints', () => {
    const db = openMigratedDb();
    expect(() => db.prepare(`
      INSERT INTO governed_proposals (id, kind, status, provenance, title, created_at)
      VALUES ('p1', 'not-a-kind', 'pending', 'agent-derived', 'title', 1)
    `).run()).toThrow();

    expect(() => db.prepare(`
      INSERT INTO governed_proposals (id, kind, status, provenance, title, created_at)
      VALUES ('p1', 'memory', 'not-a-status', 'agent-derived', 'title', 1)
    `).run()).toThrow();

    expect(() => db.prepare(`
      INSERT INTO governed_proposals (id, kind, status, provenance, title, created_at)
      VALUES ('p1', 'memory', 'pending', 'agent-derived', 'title', 1)
    `).run()).not.toThrow();
  });

  it('cascades proposal_audit deletion when the parent proposal is deleted', () => {
    const db = openMigratedDb();
    db.pragma('foreign_keys = ON');
    db.prepare(`
      INSERT INTO governed_proposals (id, kind, status, provenance, title, created_at)
      VALUES ('p1', 'memory', 'pending', 'agent-derived', 'title', 1)
    `).run();
    db.prepare(`
      INSERT INTO proposal_audit (proposal_id, action, timestamp, metadata_json)
      VALUES ('p1', 'created', 1, '{}')
    `).run();

    db.prepare('DELETE FROM governed_proposals WHERE id = ?').run('p1');
    const rows = db.prepare('SELECT * FROM proposal_audit WHERE proposal_id = ?').all('p1');
    expect(rows).toEqual([]);
  });

  it('removes both tables on rollback', () => {
    const db = openMigratedDb();
    const migration = RLM_MIGRATIONS_056_060.find(({ name }) => name === '056_governed_proposals');
    if (!migration) throw new Error('Missing migration 056_governed_proposals');
    db.exec(migration.down);
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('governed_proposals', 'proposal_audit')
    `).all<{ name: string }>();
    expect(tables).toEqual([]);
  });
});

describe('learning scan checkpoints migration 057', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('creates the checkpoint table and is idempotent on re-run', () => {
    const db = openMigratedDb();
    runMigrations(db); // second run must be a no-op

    expect(
      db.prepare('SELECT name FROM _migrations WHERE name = ?').get<{ name: string }>('057_learning_scan_checkpoints'),
    ).toEqual({ name: '057_learning_scan_checkpoints' });

    const table = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'learning_scan_checkpoints'
    `).get<{ name: string }>();
    expect(table).toEqual({ name: 'learning_scan_checkpoints' });
  });

  it('defaults counters to zero and allows a scoped upsert', () => {
    const db = openMigratedDb();
    db.prepare(`
      INSERT INTO learning_scan_checkpoints (scope_key, updated_at)
      VALUES ('__global__', 1)
    `).run();

    const row = db.prepare('SELECT * FROM learning_scan_checkpoints WHERE scope_key = ?')
      .get<{ last_scanned_ended_at: number; sessions_scanned_total: number }>('__global__');
    expect(row).toMatchObject({ last_scanned_ended_at: 0, sessions_scanned_total: 0 });
  });

  it('removes the table on rollback', () => {
    const db = openMigratedDb();
    const migration = RLM_MIGRATIONS_056_060.find(({ name }) => name === '057_learning_scan_checkpoints');
    if (!migration) throw new Error('Missing migration 057_learning_scan_checkpoints');
    db.exec(migration.down);
    const table = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'learning_scan_checkpoints'
    `).get<{ name: string }>();
    expect(table).toBeUndefined();
  });
});
