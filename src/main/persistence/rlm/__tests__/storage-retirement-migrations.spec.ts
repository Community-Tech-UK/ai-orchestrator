import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../../db/sqlite-driver';
import {
  computeMigrationChecksum,
  createMigrationsTable,
  createTables,
  MIGRATIONS,
  runMigrations,
} from '../rlm-schema';

const dbs: SqliteDriver[] = [];

describe('storage retirement migrations', () => {
  afterEach(() => {
    for (const db of dbs.splice(0)) db.close();
  });

  it('drops legacy search_index and file_metadata while retaining context sections', () => {
    const db = defaultDriverFactory(':memory:');
    dbs.push(db);
    createTables(db);
    createMigrationsTable(db);
    markMigrationsBeforeRetirementApplied(db);
    db.exec(`
      CREATE TABLE search_index (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_id TEXT NOT NULL,
        term TEXT NOT NULL,
        section_id TEXT NOT NULL,
        line_number INTEGER,
        position INTEGER,
        snippet TEXT
      );
      CREATE INDEX idx_search_store_term ON search_index(store_id, term);
      CREATE INDEX idx_search_section ON search_index(section_id);
      INSERT INTO search_index (store_id, term, section_id) VALUES ('store-1', 'term', 'section-1');

      CREATE TABLE file_metadata (
        id TEXT PRIMARY KEY,
        store_id TEXT NOT NULL,
        path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        language TEXT NOT NULL,
        size INTEGER NOT NULL,
        lines INTEGER NOT NULL,
        hash TEXT NOT NULL,
        last_modified INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX idx_file_metadata_store ON file_metadata(store_id);
      CREATE INDEX idx_file_metadata_path ON file_metadata(path);
      CREATE INDEX idx_file_metadata_hash ON file_metadata(hash);
      CREATE INDEX idx_file_metadata_language ON file_metadata(language);
      INSERT INTO file_metadata (id, store_id, path, relative_path, language, size, lines, hash, last_modified, created_at, updated_at)
      VALUES ('file-1', 'store-1', '/repo/a.ts', 'a.ts', 'typescript', 1, 1, 'hash', 1, 1, 1);
    `);

    runMigrations(db);

    expect(schemaObjectExists(db, 'table', 'search_index')).toBe(false);
    expect(schemaObjectExists(db, 'index', 'idx_search_store_term')).toBe(false);
    expect(schemaObjectExists(db, 'index', 'idx_search_section')).toBe(false);
    expect(schemaObjectExists(db, 'table', 'file_metadata')).toBe(false);
    expect(schemaObjectExists(db, 'index', 'idx_file_metadata_store')).toBe(false);
    expect(schemaObjectExists(db, 'index', 'idx_file_metadata_path')).toBe(false);
    expect(schemaObjectExists(db, 'index', 'idx_file_metadata_hash')).toBe(false);
    expect(schemaObjectExists(db, 'index', 'idx_file_metadata_language')).toBe(false);
    expect(schemaObjectExists(db, 'table', 'context_sections')).toBe(true);
  });
});

function markMigrationsBeforeRetirementApplied(db: SqliteDriver): void {
  for (const migration of MIGRATIONS.filter(({ name }) => name < '042_drop_search_index')) {
    db.prepare('INSERT INTO _migrations (name, applied_at, checksum) VALUES (?, ?, ?)').run(
      migration.name,
      1,
      computeMigrationChecksum(migration),
    );
  }
}

function schemaObjectExists(db: SqliteDriver, type: 'table' | 'index', name: string): boolean {
  return db.prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?').get(type, name) !== undefined;
}
