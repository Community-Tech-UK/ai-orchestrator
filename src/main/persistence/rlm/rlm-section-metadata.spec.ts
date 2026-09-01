import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import {
  getSectionCountsByStore,
  getSectionMetadata,
  getSectionStatsByType,
} from './rlm-sections';

describe('RLM section metadata projection', () => {
  const databases: SqliteDriver[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) {
      database.close();
    }
  });

  it('returns a UTF-8 size estimate without returning inline content', () => {
    const database = createDatabase(databases);
    insertSection(database, {
      id: 'inline-section',
      storeId: 'store-1',
      startOffset: 0,
      contentInline: '£🙂',
    });

    const [section] = getSectionMetadata(database, 'store-1');

    expect(section).toMatchObject({
      id: 'inline-section',
      store_id: 'store-1',
      content_size_bytes: 6,
    });
    expect(section).not.toHaveProperty('content_inline');
  });

  it('orders metadata by offset and applies deterministic limit and offset paging', () => {
    const database = createDatabase(databases);
    insertSection(database, {
      id: 'third',
      storeId: 'store-1',
      startOffset: 30,
      contentInline: null,
    });
    insertSection(database, {
      id: 'first',
      storeId: 'store-1',
      startOffset: 10,
      contentInline: null,
    });
    insertSection(database, {
      id: 'second',
      storeId: 'store-1',
      startOffset: 20,
      contentInline: null,
    });

    const sections = getSectionMetadata(database, 'store-1', { limit: 1, offset: 1 });

    expect(sections.map((section) => section.id)).toEqual(['second']);
  });

  it('applies offset without a limit while retaining offset order', () => {
    const database = createDatabase(databases);
    insertSection(database, {
      id: 'first',
      storeId: 'store-1',
      startOffset: 10,
      contentInline: null,
    });
    insertSection(database, {
      id: 'second',
      storeId: 'store-1',
      startOffset: 20,
      contentInline: null,
    });
    insertSection(database, {
      id: 'third',
      storeId: 'store-1',
      startOffset: 30,
      contentInline: null,
    });

    const sections = getSectionMetadata(database, 'store-1', { offset: 1 });

    expect(sections.map((section) => section.id)).toEqual(['second', 'third']);
  });

  it('uses the stored offset span as a content-free estimate for file-backed non-ASCII content', () => {
    const database = createDatabase(databases);
    insertSection(database, {
      id: 'file-backed-section',
      storeId: 'store-1',
      startOffset: 100,
      endOffset: 102,
      contentFile: 'content-file-marker',
      contentInline: null,
    });

    const [section] = getSectionMetadata(database, 'store-1');

    // A file containing `£🙂` has six UTF-8 bytes, but metadata reads must not
    // open the content file. The controller verifies actual bytes after admission.
    expect(section).toMatchObject({
      content_file: 'content-file-marker',
      content_size_bytes: 2,
    });
    expect(Buffer.byteLength('£🙂', 'utf8')).toBe(6);
  });

  it('counts sections for every store with one grouped projection', () => {
    const database = createDatabase(databases);
    insertSection(database, {
      id: 'store-1-first',
      storeId: 'store-1',
      startOffset: 0,
      contentInline: null,
    });
    insertSection(database, {
      id: 'store-1-second',
      storeId: 'store-1',
      startOffset: 10,
      contentInline: null,
    });
    insertSection(database, {
      id: 'store-2-first',
      storeId: 'store-2',
      startOffset: 0,
      contentInline: null,
    });

    expect(getSectionCountsByStore(database)).toEqual([
      { store_id: 'store-1', section_count: 2 },
      { store_id: 'store-2', section_count: 1 },
    ]);
  });

  it('aggregates section counts and tokens by type without selecting content', () => {
    const database = createDatabase(databases);
    insertSection(database, {
      id: 'file-one',
      storeId: 'store-1',
      startOffset: 0,
      contentInline: 'payload that must not be returned',
      type: 'file',
      tokens: 3,
    });
    insertSection(database, {
      id: 'file-two',
      storeId: 'store-2',
      startOffset: 10,
      contentInline: null,
      type: 'file',
      tokens: 5,
    });
    insertSection(database, {
      id: 'external-one',
      storeId: 'store-2',
      startOffset: 20,
      contentInline: 'another secret payload',
      type: 'external',
      tokens: 7,
    });

    expect(getSectionStatsByType(database)).toEqual([
      { type: 'external', section_count: 1, total_tokens: 7 },
      { type: 'file', section_count: 2, total_tokens: 8 },
    ]);
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
      source TEXT,
      start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL,
      tokens INTEGER NOT NULL,
      checksum TEXT,
      depth INTEGER NOT NULL,
      summarizes_json TEXT,
      parent_summary_id TEXT,
      file_path TEXT,
      language TEXT,
      source_url TEXT,
      created_at INTEGER NOT NULL,
      content_file TEXT,
      content_inline TEXT
    );
  `);
  return database;
}

function insertSection(
  database: SqliteDriver,
  section: {
    id: string;
    storeId: string;
    startOffset: number;
    endOffset?: number;
    contentFile?: string | null;
    contentInline: string | null;
    type?: string;
    tokens?: number;
  },
): void {
  database.prepare(`
    INSERT INTO context_sections (
      id, store_id, type, name, source, start_offset, end_offset, tokens,
      checksum, depth, summarizes_json, parent_summary_id, file_path, language,
      source_url, created_at, content_file, content_inline
    ) VALUES (?, ?, ?, 'source.ts', NULL, ?, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, NULL, 1, ?, ?)
  `).run(
    section.id,
    section.storeId,
    section.type ?? 'file',
    section.startOffset,
    section.endOffset ?? section.startOffset + 10,
    section.tokens ?? 1,
    section.contentFile ?? null,
    section.contentInline,
  );
}
