import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import * as verbatimStore from '../../../main/persistence/rlm/rlm-verbatim';
import { createTables, createMigrationsTable, runMigrations } from '../../../main/persistence/rlm/rlm-schema';

describe('rlm-verbatim persistence', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  // ── addSegment ─────────────────────────────────────────────────────────────

  describe('addSegment', () => {
    it('inserts a segment and returns deterministic id', () => {
      const id = verbatimStore.addSegment(db, {
        content: 'Hello world',
        sourceFile: 'chat.json',
        chunkIndex: 0,
        wing: 'alpha',
        room: 'general',
      });

      expect(id).toMatch(/^vseg_[0-9a-f]{24}$/);

      const row = verbatimStore.getSegment(db, id);
      expect(row).toBeDefined();
      expect(row!.content).toBe('Hello world');
      expect(row!.source_file).toBe('chat.json');
      expect(row!.chunk_index).toBe(0);
      expect(row!.wing).toBe('alpha');
      expect(row!.room).toBe('general');
      expect(row!.importance).toBe(3.0);
      expect(row!.added_by).toBe('system');
    });

    it('generates same id for same sourceFile+chunkIndex', () => {
      const id1 = verbatimStore.addSegment(db, {
        content: 'First insert',
        sourceFile: 'chat.json',
        chunkIndex: 5,
        wing: 'alpha',
        room: 'general',
      });
      const id2 = verbatimStore.addSegment(db, {
        content: 'Updated content',
        sourceFile: 'chat.json',
        chunkIndex: 5,
        wing: 'alpha',
        room: 'lab',
      });

      expect(id1).toBe(id2);
    });

    it('upserts on duplicate id — updates content, wing, room, importance', () => {
      verbatimStore.addSegment(db, {
        content: 'Original',
        sourceFile: 'f.json',
        chunkIndex: 0,
        wing: 'alpha',
        room: 'room1',
        importance: 2.0,
      });

      const id = verbatimStore.addSegment(db, {
        content: 'Updated',
        sourceFile: 'f.json',
        chunkIndex: 0,
        wing: 'beta',
        room: 'room2',
        importance: 5.0,
      });

      expect(verbatimStore.getSegmentCount(db)).toBe(1);

      const row = verbatimStore.getSegment(db, id);
      expect(row!.content).toBe('Updated');
      expect(row!.wing).toBe('beta');
      expect(row!.room).toBe('room2');
      expect(row!.importance).toBe(5.0);
    });

    it('respects custom importance and addedBy', () => {
      const id = verbatimStore.addSegment(db, {
        content: 'Important note',
        sourceFile: 'notes.json',
        chunkIndex: 1,
        wing: 'gamma',
        room: 'inbox',
        importance: 9.5,
        addedBy: 'importer-v2',
      });

      const row = verbatimStore.getSegment(db, id);
      expect(row!.importance).toBe(9.5);
      expect(row!.added_by).toBe('importer-v2');
    });
  });

  // ── queryByWingRoom ────────────────────────────────────────────────────────

  describe('queryByWingRoom', () => {
    beforeEach(() => {
      verbatimStore.addSegment(db, { content: 'A1', sourceFile: 'a.json', chunkIndex: 0, wing: 'alpha', room: 'room1', importance: 3 });
      verbatimStore.addSegment(db, { content: 'A2', sourceFile: 'a.json', chunkIndex: 1, wing: 'alpha', room: 'room2', importance: 5 });
      verbatimStore.addSegment(db, { content: 'B1', sourceFile: 'b.json', chunkIndex: 0, wing: 'beta',  room: 'room1', importance: 4 });
    });

    it('returns all segments when no filter provided', () => {
      const results = verbatimStore.queryByWingRoom(db, {});
      expect(results).toHaveLength(3);
    });

    it('filters by wing only', () => {
      const results = verbatimStore.queryByWingRoom(db, { wing: 'alpha' });
      expect(results).toHaveLength(2);
      expect(results.every(r => r.wing === 'alpha')).toBe(true);
    });

    it('filters by wing and room', () => {
      const results = verbatimStore.queryByWingRoom(db, { wing: 'alpha', room: 'room1' });
      expect(results).toHaveLength(1);
      expect(results[0].content).toBe('A1');
    });

    it('filters by room only', () => {
      const results = verbatimStore.queryByWingRoom(db, { room: 'room1' });
      expect(results).toHaveLength(2);
    });

    it('returns results ordered by importance DESC', () => {
      const results = verbatimStore.queryByWingRoom(db, { wing: 'alpha' });
      expect(results[0].importance).toBeGreaterThanOrEqual(results[1].importance);
    });

    it('respects limit', () => {
      const results = verbatimStore.queryByWingRoom(db, { limit: 2 });
      expect(results).toHaveLength(2);
    });
  });

  // ── getTopByImportance ─────────────────────────────────────────────────────

  describe('getTopByImportance', () => {
    beforeEach(() => {
      verbatimStore.addSegment(db, { content: 'Low',  sourceFile: 'x.json', chunkIndex: 0, wing: 'alpha', room: 'r', importance: 1 });
      verbatimStore.addSegment(db, { content: 'High', sourceFile: 'x.json', chunkIndex: 1, wing: 'alpha', room: 'r', importance: 9 });
      verbatimStore.addSegment(db, { content: 'Mid',  sourceFile: 'x.json', chunkIndex: 2, wing: 'alpha', room: 'r', importance: 5 });
      verbatimStore.addSegment(db, { content: 'Beta', sourceFile: 'y.json', chunkIndex: 0, wing: 'beta',  room: 'r', importance: 8 });
    });

    it('returns segments sorted by importance DESC', () => {
      const results = verbatimStore.getTopByImportance(db, 4);
      expect(results).toHaveLength(4);
      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i].importance).toBeGreaterThanOrEqual(results[i + 1].importance);
      }
    });

    it('respects the limit', () => {
      const results = verbatimStore.getTopByImportance(db, 2);
      expect(results).toHaveLength(2);
      expect(results[0].importance).toBe(9);
      expect(results[1].importance).toBe(8);
    });

    it('filters by wing when provided', () => {
      const results = verbatimStore.getTopByImportance(db, 10, 'alpha');
      expect(results).toHaveLength(3);
      expect(results.every(r => r.wing === 'alpha')).toBe(true);
      expect(results[0].importance).toBe(9);
    });
  });

  // ── deleteBySource ─────────────────────────────────────────────────────────

  describe('deleteBySource', () => {
    it('removes all segments from a source file and returns change count', () => {
      verbatimStore.addSegment(db, { content: 'A', sourceFile: 'target.json', chunkIndex: 0, wing: 'alpha', room: 'r' });
      verbatimStore.addSegment(db, { content: 'B', sourceFile: 'target.json', chunkIndex: 1, wing: 'alpha', room: 'r' });
      verbatimStore.addSegment(db, { content: 'C', sourceFile: 'other.json',  chunkIndex: 0, wing: 'alpha', room: 'r' });

      const deleted = verbatimStore.deleteBySource(db, 'target.json');
      expect(deleted).toBe(2);
      expect(verbatimStore.getSegmentCount(db)).toBe(1);
    });

    it('returns 0 when source file has no segments', () => {
      const deleted = verbatimStore.deleteBySource(db, 'nonexistent.json');
      expect(deleted).toBe(0);
    });
  });

  // ── recordImport ───────────────────────────────────────────────────────────

  describe('recordImport', () => {
    it('records an import and returns an id', () => {
      const id = verbatimStore.recordImport(db, {
        filePath: '/path/to/chat.json',
        format: 'claude',
        wing: 'alpha',
        messageCount: 42,
      });

      expect(id).toMatch(/^imp_/);

      const row = verbatimStore.getImport(db, id);
      expect(row).toBeDefined();
      expect(row!.file_path).toBe('/path/to/chat.json');
      expect(row!.format).toBe('claude');
      expect(row!.wing).toBe('alpha');
      expect(row!.message_count).toBe(42);
      expect(row!.status).toBe('pending');
    });

    it('rejects duplicate file paths', () => {
      verbatimStore.recordImport(db, {
        filePath: '/path/to/chat.json',
        format: 'claude',
        wing: 'alpha',
        messageCount: 1,
      });

      expect(() =>
        verbatimStore.recordImport(db, {
          filePath: '/path/to/chat.json',
          format: 'gemini',
          wing: 'beta',
          messageCount: 2,
        })
      ).toThrow();
    });
  });

  // ── isFileImported ─────────────────────────────────────────────────────────

  describe('isFileImported', () => {
    it('returns false for a file that has not been imported', () => {
      expect(verbatimStore.isFileImported(db, '/nonexistent.json')).toBe(false);
    });

    it('returns false for a pending import', () => {
      verbatimStore.recordImport(db, {
        filePath: '/pending.json',
        format: 'claude',
        wing: 'alpha',
        messageCount: 5,
      });

      expect(verbatimStore.isFileImported(db, '/pending.json')).toBe(false);
    });

    it('returns true after status is set to imported', () => {
      const id = verbatimStore.recordImport(db, {
        filePath: '/done.json',
        format: 'claude',
        wing: 'alpha',
        messageCount: 10,
      });

      verbatimStore.updateImportStatus(db, id, 'imported', 10);

      expect(verbatimStore.isFileImported(db, '/done.json')).toBe(true);
    });

    it('returns false for a failed import', () => {
      const id = verbatimStore.recordImport(db, {
        filePath: '/failed.json',
        format: 'claude',
        wing: 'alpha',
        messageCount: 3,
      });

      verbatimStore.updateImportStatus(db, id, 'failed', undefined, 'Parse error');

      expect(verbatimStore.isFileImported(db, '/failed.json')).toBe(false);
    });
  });

  // ── updateImportStatus ─────────────────────────────────────────────────────

  describe('updateImportStatus', () => {
    it('updates status and segments_created', () => {
      const id = verbatimStore.recordImport(db, {
        filePath: '/update-test.json',
        format: 'claude',
        wing: 'alpha',
        messageCount: 20,
      });

      verbatimStore.updateImportStatus(db, id, 'imported', 15);

      const row = verbatimStore.getImport(db, id);
      expect(row!.status).toBe('imported');
      expect(row!.segments_created).toBe(15);
      expect(row!.error).toBeNull();
    });

    it('records error message on failed status', () => {
      const id = verbatimStore.recordImport(db, {
        filePath: '/fail-test.json',
        format: 'claude',
        wing: 'alpha',
        messageCount: 5,
      });

      verbatimStore.updateImportStatus(db, id, 'failed', undefined, 'File not found');

      const row = verbatimStore.getImport(db, id);
      expect(row!.status).toBe('failed');
      expect(row!.error).toBe('File not found');
    });
  });
});
