import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RLMDatabase } from '../persistence/rlm-database';
import { RlmMaintenanceDatabaseAdapter } from './rlm-storage-maintenance-database';

const CUTOFF = Date.UTC(2026, 4, 12);

describe('RlmMaintenanceDatabaseAdapter (native SQLite)', () => {
  let root: string;
  let database: RLMDatabase;
  let adapter: RlmMaintenanceDatabaseAdapter;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rlm-maintenance-'));
    RLMDatabase._resetForTesting();
    database = RLMDatabase.getInstance({
      dbPath: path.join(root, 'rlm.db'),
      contentDir: path.join(root, 'content'),
    });
    adapter = new RlmMaintenanceDatabaseAdapter(database);
  });

  afterEach(() => {
    RLMDatabase._resetForTesting();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('classifies exact candidates and transactionally cascades only stale unprotected stores', () => {
    seedStore('stale', 'old-session', CUTOFF - 1, null, true);
    seedStore('cutoff', 'cutoff-session', CUTOFF, null, true);
    seedStore('recent', 'recent-session', CUTOFF + 1, null, true);
    seedStore('live', 'live-session', CUTOFF - 1, null, true);
    seedStore('codebase', 'codebase-session', CUTOFF - 1, { kind: 'codebase-auto' }, true);

    expect(adapter.inspect(CUTOFF, new Set(['live-session']))).toEqual({
      eligibleStoreCount: 2,
      protectedLiveStoreCount: 1,
      protectedCodebaseAutoStoreCount: 1,
    });

    const pruned = adapter.prune(CUTOFF, new Set(['live-session']));
    expect(pruned.storesDeleted).toBe(2);
    expect(pruned.externalContentFiles).toHaveLength(2);
    expect(rowCount('context_sections', 'stale')).toBe(0);
    expect(rowCount('context_sections', 'cutoff')).toBe(0);
    expect(rowCount('rlm_sessions', 'stale')).toBe(0);
    expect(rowCount('vectors', 'stale')).toBe(0);
    expect(rowCount('search_index', 'stale')).toBe(0);
    expect(rowCount('context_stores', 'recent')).toBe(1);
    expect(rowCount('context_stores', 'live')).toBe(1);
    expect(rowCount('context_stores', 'codebase')).toBe(1);

    // These files must actually exist before the delete, otherwise the
    // assertions below pass vacuously against paths that were never written.
    for (const file of pruned.externalContentFiles) {
      expect(fs.existsSync(file)).toBe(true);
    }
    expect(adapter.deleteExternalContent(pruned.externalContentFiles)).toEqual({
      deleted: 2,
      missing: 0,
      refused: 0,
      failed: 0,
    });
    expect(fs.existsSync(pruned.externalContentFiles[0]!)).toBe(false);
    expect(fs.existsSync(contentFile(sectionIdFor('recent')))).toBe(true);
  });

  it('reports content that was never at its canonical path as missing, not deleted', () => {
    seedStore('stale', 'old-session', CUTOFF - 1, null, true);
    const pruned = adapter.prune(CUTOFF, new Set());

    // Simulate content written under a previous userData root: the row says the
    // section has external content, but nothing is at the canonical path. This
    // must not be laundered into a successful delete, which is what rmSync
    // force did and what hid the store-id/section-id mismatch.
    fs.rmSync(pruned.externalContentFiles[0]!, { force: true });

    expect(adapter.deleteExternalContent(pruned.externalContentFiles)).toEqual({
      deleted: 0,
      missing: 1,
      refused: 0,
      failed: 0,
    });
  });

  it('refuses to delete a path outside the managed content directory', () => {
    const outsider = path.join(root, 'outside.txt');
    fs.writeFileSync(outsider, 'not ours to delete');

    expect(adapter.deleteExternalContent([outsider])).toEqual({
      deleted: 0,
      missing: 0,
      refused: 1,
      failed: 0,
    });
    expect(fs.existsSync(outsider)).toBe(true);
  });

  it('removes the prefix directory once its last section is reclaimed', () => {
    seedStore('stale', 'old-session', CUTOFF - 1, null, true);
    const prefixDirectory = path.dirname(contentFile(sectionIdFor('stale')));
    expect(fs.existsSync(prefixDirectory)).toBe(true);

    const pruned = adapter.prune(CUTOFF, new Set());
    adapter.deleteExternalContent(pruned.externalContentFiles);

    expect(fs.existsSync(prefixDirectory)).toBe(false);
  });

  it('measures database/content storage and leaves no freelist after vacuum', () => {
    seedStore('stale', 'old-session', CUTOFF - 1, null, true);
    const pruned = adapter.prune(CUTOFF, new Set());
    adapter.deleteExternalContent(pruned.externalContentFiles);
    const beforeVacuum = adapter.measure();
    adapter.vacuum();
    const measured = adapter.measure();
    expect(database.getDatabasePath()).toBe(path.join(root, 'rlm.db'));
    expect(measured.databaseSizeBytes).toBeGreaterThan(0);
    expect(measured.externalContentSizeBytes).toBe(0);
    expect(measured.reclaimableDatabaseBytes).toBeLessThanOrEqual(beforeVacuum.reclaimableDatabaseBytes);
  });

  function seedStore(
    id: string,
    instanceId: string,
    lastAccessed: number,
    config: Record<string, unknown> | null,
    withExternalContent: boolean,
  ): void {
    const db = database.getRawDb();
    db.prepare(`
      INSERT INTO context_stores (id, instance_id, created_at, last_accessed, config_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, instanceId, lastAccessed, lastAccessed, config ? JSON.stringify(config) : null);
    const sectionId = sectionIdFor(id);
    const file = withExternalContent ? contentFile(sectionId) : null;
    if (file) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `external content for ${id}`);
    }
    db.prepare(`
      INSERT INTO context_sections
        (id, store_id, type, name, start_offset, end_offset, tokens, created_at, content_file)
      VALUES (?, ?, 'conversation', ?, 0, 10, 3, ?, ?)
    `).run(sectionId, id, id, lastAccessed, file);
    db.prepare(`
      INSERT INTO rlm_sessions
        (id, store_id, instance_id, started_at, last_activity_at, estimated_direct_tokens)
      VALUES (?, ?, ?, ?, ?, 3)
    `).run(`session-${id}`, id, instanceId, lastAccessed, lastAccessed);
    db.prepare(`
      INSERT INTO vectors
        (id, store_id, section_id, embedding, dimensions, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(`vector-${id}`, id, `section-${id}`, 'embedding', lastAccessed);
    db.prepare(`
      INSERT INTO search_index
        (store_id, term, section_id, line_number, position, snippet)
      VALUES (?, ?, ?, 1, 0, ?)
    `).run(id, id, `section-${id}`, id);
  }

  function rowCount(table: string, storeId: string): number {
    const column = table === 'context_stores' ? 'id' : 'store_id';
    return database.getRawDb().prepare(
      `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
    ).get<{ count: number }>(storeId)?.count ?? 0;
  }

  function sectionIdFor(storeId: string): string {
    return `section-${storeId}`;
  }

  /**
   * Mirrors getContentPath() in persistence/rlm/rlm-content.ts:
   * <contentDir>/<sectionId[0:2]>/<sectionId>.txt.
   *
   * Keyed on the SECTION id, not the store id. Maintenance resolves external
   * content canonically from context_sections.id, so a store-id-keyed fixture
   * writes a file production never looks at: prune() returns a path that does
   * not exist, deleteExternalContent() no-ops on it (rmSync force), and the
   * real file survives to inflate externalContentSizeBytes.
   */
  function contentFile(sectionId: string): string {
    return path.join(root, 'content', sectionId.slice(0, 2), `${sectionId}.txt`);
  }
});
