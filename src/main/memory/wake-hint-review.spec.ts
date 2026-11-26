import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabaseWithExport, openSqliteWasmFileReadOnly } from '../db/sqlite-wasm-driver';
import { createTables, createMigrationsTable, runMigrations } from '../persistence/rlm/rlm-schema';
import { upsertProjectKnowledgeSource, linkProjectKnowledgeWakeHint, clearProjectKnowledgeLinksForSource } from '../persistence/rlm/rlm-project-knowledge';

const state = vi.hoisted(() => ({ db: null as SqliteDriver | null }));
vi.mock('../persistence/rlm-database', () => ({ getRLMDatabase: () => ({ getRawDb: () => state.db }) }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
import { getWakeContextBuilder, WakeContextBuilder } from './wake-context-builder';
import { reviewWakeHintsForRoom } from './wake-hint-review';

describe('source-backed project note review', () => {
  let db: SqliteDriver;
  let folder: string;
  let exportBytes: () => Uint8Array;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'wake-review-'));
    const fixture = createSqliteWasmDatabaseWithExport();
    db = fixture.driver;
    exportBytes = fixture.exportBytes;
    state.db = db;
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
    WakeContextBuilder._resetForTesting();
  });
  afterEach(async () => {
    WakeContextBuilder._resetForTesting();
    vi.restoreAllMocks();
    db.close();
    state.db = null;
    await rm(folder, { recursive: true, force: true });
  });

  it('compares the captured source bytes, even after mining prunes its current evidence link', async () => {
    const file = join(folder, 'README.md');
    await writeFile(file, 'original facts');
    const builder = getWakeContextBuilder();
    const id = builder.addHint('Original project fact.', { room: folder });
    const source = upsertProjectKnowledgeSource(db, {
      projectKey: folder, sourceKind: 'readme', sourceUri: file,
      contentFingerprint: createHash('sha256').update('original facts').digest('hex'),
    }).source;
    linkProjectKnowledgeWakeHint(db, { projectKey: folder, sourceId: source.id, hintId: id });
    for (let i = 0; i < 10; i++) builder.getWakeUpText(folder);
    const read = async () => (await reviewWakeHintsForRoom()).find((note) => note.id === id)!;
    expect((await read()).review).toMatchObject({ shownIn30Days: 10, sourceStatus: 'matches' });
    await writeFile(file, 'changed facts');
    upsertProjectKnowledgeSource(db, {
      projectKey: folder, sourceKind: 'readme', sourceUri: file,
      contentFingerprint: createHash('sha256').update('changed facts').digest('hex'),
    });
    clearProjectKnowledgeLinksForSource(db, folder, source.id, ['wake_hint']);
    expect((await read()).review).toMatchObject({ sourceStatus: 'changed', suggestion: 'source changed' });
    expect(builder.getHint(id)).toBeDefined(); // Review never deletes.
    await rm(file);
    expect((await read()).review?.sourceStatus).toBe('changed');
  });

  it('requires 60 observed days without a showing and never invents legacy history or a fingerprint', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const id = getWakeContextBuilder().addHint('Legacy note');
    db.prepare('UPDATE wake_hints SET created_at = ?, last_used = ?, usage_count = 20 WHERE id = ?')
      .run(now - 90 * 86_400_000, now - 40 * 86_400_000, id);
    const note = (await reviewWakeHintsForRoom())[0];
    expect(note.review).toMatchObject({ shownIn30Days: 0, sourceStatus: 'unknown' });
    expect(note.review?.suggestion).toBeUndefined();
    db.prepare('UPDATE wake_hint_tracking SET started_at = ?').run(now - 31 * 86_400_000);
    expect((await reviewWakeHintsForRoom())[0].review?.suggestion).toBeUndefined();
    db.prepare('UPDATE wake_hint_tracking SET started_at = ?').run(now - 61 * 86_400_000);
    // Even with complete observed history, a showing 40 days ago is too recent.
    expect((await reviewWakeHintsForRoom())[0].review?.suggestion).toBeUndefined();
    db.prepare('UPDATE wake_hints SET last_used = ? WHERE id = ?').run(now - 60 * 86_400_000, id);
    expect((await reviewWakeHintsForRoom())[0].review?.suggestion).toBeUndefined();
    db.prepare('UPDATE wake_hints SET last_used = ? WHERE id = ?').run(now - 61 * 86_400_000, id);
    db.prepare('UPDATE wake_hint_tracking SET started_at = ?').run(now - 31 * 86_400_000);
    expect((await reviewWakeHintsForRoom())[0].review?.suggestion).toBeUndefined();
    db.prepare('UPDATE wake_hint_tracking SET started_at = ?').run(now - 61 * 86_400_000);
    expect((await reviewWakeHintsForRoom())[0].review).toMatchObject({
      shownIn30Days: 0, sourceStatus: 'unknown', suggestion: 'never shown',
    });
  });

  it('suggests a changed source only after 10 showings inside the last 30 days', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const builder = getWakeContextBuilder();
    const id = builder.addHint('Source-backed note.');
    const source = upsertProjectKnowledgeSource(db, {
      projectKey: folder, sourceKind: 'readme', sourceUri: join(folder, 'missing.md'),
      contentFingerprint: createHash('sha256').update('recorded facts').digest('hex'),
    }).source;
    linkProjectKnowledgeWakeHint(db, { projectKey: folder, sourceId: source.id, hintId: id });
    db.prepare('UPDATE wake_hints SET created_at = ?, last_used = ?, usage_count = 10 WHERE id = ?')
      .run(now - 90 * 86_400_000, now - 31 * 86_400_000, id);
    for (let i = 0; i < 10; i++) {
      db.prepare('INSERT INTO wake_hint_showings (hint_id, showing_id, shown_at) VALUES (?, ?, ?)')
        .run(id, `start-${i}`, now - 31 * 86_400_000);
    }
    const read = async () => (await reviewWakeHintsForRoom())[0].review;
    expect(await read()).toMatchObject({ shownIn30Days: 0, sourceStatus: 'changed', suggestion: undefined });
    db.prepare('UPDATE wake_hint_showings SET shown_at = ?').run(now - 30 * 86_400_000);
    expect(await read()).toMatchObject({ shownIn30Days: 10, suggestion: 'source changed' });
    db.prepare('UPDATE wake_hint_showings SET shown_at = ? WHERE showing_id = ?').run(now + 1, 'start-0');
    expect(await read()).toMatchObject({ shownIn30Days: 9, sourceStatus: 'changed', suggestion: undefined });
  });

  it('retains actual showings when exported SQLite bytes are reopened', async () => {
    const id = getWakeContextBuilder().addHint('Persist this starting note.');
    getWakeContextBuilder().getWakeUpText(folder);
    // The Vitest driver intentionally ignores filenames. Use its existing
    // export/read-only fixture boundary to verify persisted bytes instead.
    await writeFile(join(folder, 'memory.sqlite'), exportBytes());
    db.close();
    db = openSqliteWasmFileReadOnly(join(folder, 'memory.sqlite'));
    state.db = db;
    WakeContextBuilder._resetForTesting();
    const note = (await reviewWakeHintsForRoom()).find((hint) => hint.id === id)!;
    expect(note.usageCount).toBe(1);
    expect(note.review?.shownIn30Days).toBe(1);
    expect(note.review?.suggestion).toBeUndefined();
  });
});
