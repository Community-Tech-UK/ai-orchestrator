import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { RLM_MIGRATIONS_046_050 } from './rlm-migrations-046-050';
import { createMigrationsTable, createTables, runMigrations } from './rlm-schema';

const dbs: SqliteDriver[] = [];

function openMigratedDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  return db;
}

describe('doc-review RLM migration', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('creates both durable review tables through migration 046', () => {
    const db = openMigratedDb();
    const migration = db.prepare('SELECT name FROM _migrations WHERE name = ?')
      .get<{ name: string }>('046_doc_review_sessions');
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('doc_review_sessions', 'doc_review_metadata')
      ORDER BY name
    `).all<{ name: string }>().map((row) => row.name);

    expect(migration?.name).toBe('046_doc_review_sessions');
    expect(tables).toEqual(['doc_review_metadata', 'doc_review_sessions']);
  });

  it('removes both review tables when migration 046 is rolled back', () => {
    const db = openMigratedDb();
    const migration = RLM_MIGRATIONS_046_050.find(({ name }) => name === '046_doc_review_sessions');
    if (!migration) throw new Error('Missing doc-review migration 046');

    db.exec(migration.down);
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('doc_review_sessions', 'doc_review_metadata')
    `).all<{ name: string }>();

    expect(tables).toEqual([]);
  });
});
