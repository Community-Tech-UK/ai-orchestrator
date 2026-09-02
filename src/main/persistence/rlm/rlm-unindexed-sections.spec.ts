import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { listUnindexedRootSections } from './rlm-sections';

describe('listUnindexedRootSections', () => {
  const databases: SqliteDriver[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('returns only missing root-vector metadata without materializing inline content', () => {
    const database = createDatabase(databases);
    insertSection(database, {
      id: 'missing-root', storeId: 'store-1', depth: 0, startOffset: 20,
      contentInline: 'payload that must stay in SQLite',
    });
    insertSection(database, {
      id: 'indexed-root', storeId: 'store-1', depth: 0, startOffset: 10,
      contentInline: 'already embedded',
    });
    insertSection(database, {
      id: 'missing-summary', storeId: 'store-1', depth: 1, startOffset: 30,
      contentInline: 'summary payload',
    });
    insertSection(database, {
      id: 'other-store-root', storeId: 'store-2', depth: 0, startOffset: 0,
      contentInline: null, contentFile: 'external-content-marker',
    });
    insertVector(database, 'indexed-root', 'store-1');

    const rows = listUnindexedRootSections(database, 'store-1');

    expect(rows).toEqual([{
      id: 'missing-root',
      store_id: 'store-1',
      type: 'external',
      name: 'missing-root.txt',
      file_path: null,
      language: null,
      content_file: null,
      content_is_inline: 1,
    }]);
    expect(rows[0]).not.toHaveProperty('content_inline');
  });

  it('excludes removed rows and bounds deterministic repair batches', () => {
    const database = createDatabase(databases);
    insertSection(database, {
      id: 'third', storeId: 'store-1', depth: 0, startOffset: 30, contentInline: 'third',
    });
    insertSection(database, {
      id: 'first', storeId: 'store-1', depth: 0, startOffset: 10, contentInline: 'first',
    });
    insertSection(database, {
      id: 'second', storeId: 'store-1', depth: 0, startOffset: 20, contentInline: 'second',
    });
    insertSection(database, {
      id: 'removed', storeId: 'store-1', depth: 0, startOffset: 0, contentInline: 'removed',
    });
    database.prepare('DELETE FROM context_sections WHERE id = ?').run('removed');

    expect(listUnindexedRootSections(database, 'store-1', { limit: 2 }).map((row) => row.id))
      .toEqual(['first', 'second']);
  });
});

function createDatabase(databases: SqliteDriver[]): SqliteDriver {
  const database = defaultDriverFactory(':memory:');
  databases.push(database);
  database.exec(`
    CREATE TABLE context_sections (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      start_offset INTEGER NOT NULL,
      depth INTEGER NOT NULL,
      file_path TEXT,
      language TEXT,
      content_file TEXT,
      content_inline TEXT
    );
    CREATE TABLE vectors (
      id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      section_id TEXT NOT NULL
    );
  `);
  return database;
}

function insertSection(
  database: SqliteDriver,
  section: {
    id: string;
    storeId: string;
    depth: number;
    startOffset: number;
    contentInline: string | null;
    contentFile?: string | null;
  },
): void {
  database.prepare(`
    INSERT INTO context_sections (
      id, store_id, type, name, start_offset, depth, file_path, language,
      content_file, content_inline
    ) VALUES (?, ?, 'external', ?, ?, ?, NULL, NULL, ?, ?)
  `).run(
    section.id,
    section.storeId,
    `${section.id}.txt`,
    section.startOffset,
    section.depth,
    section.contentFile ?? null,
    section.contentInline,
  );
}

function insertVector(database: SqliteDriver, sectionId: string, storeId: string): void {
  database.prepare(`
    INSERT INTO vectors (id, store_id, section_id) VALUES (?, ?, ?)
  `).run(`vec-${storeId}-${sectionId}`, storeId, sectionId);
}
