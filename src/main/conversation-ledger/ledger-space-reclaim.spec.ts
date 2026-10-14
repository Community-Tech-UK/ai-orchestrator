import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runConversationLedgerMigrations } from './conversation-ledger-schema';
import { compactLedgerStorage, getLedgerStorageStats, rebuildLedgerStorage } from './ledger-space-reclaim';
const disk = { available: 10 * 1024 ** 3 };
const options = { dbPath: 'scratch.db', statfs: () => ({ bavail: disk.available, bsize: 1 }) };
const databases: SqliteDriver[] = [];
afterEach(() => { databases.splice(0).forEach((db) => db.close()); disk.available = 10 * 1024 ** 3; });
function makeDb(incremental = false) {
  const db = new Database(':memory:') as unknown as SqliteDriver;
  databases.push(db);
  if (incremental) db.pragma('auto_vacuum = INCREMENTAL');
  runConversationLedgerMigrations(db);
  const insert = db.prepare(`INSERT INTO provider_event_captures VALUES (?, 'codex', 'instance', NULL, ?, ?, ?, 'test', ?)`);
  db.transaction(() => { for (let i = 0; i < 200; i++) insert.run(`event-${i}`, i, i, 'x'.repeat(8192), 'y'.repeat(8192)); })();
  return db;
}
describe('ledger space reclaim', () => {
  it('rebuilds a real scratch file with native SQLite and preserves conversation records', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aio-ledger-native-test-'));
    try {
      const script = String.raw`
        require('tsx/cjs');
        const path = require('node:path');
        const fs = require('node:fs');
        const { defaultDriverFactory } = require(path.join(process.cwd(), 'src/main/db/better-sqlite3-driver.ts'));
        const { runConversationLedgerMigrations } = require(path.join(process.cwd(), 'src/main/conversation-ledger/conversation-ledger-schema.ts'));
        const { ConversationLedgerStore } = require(path.join(process.cwd(), 'src/main/conversation-ledger/conversation-ledger-store.ts'));
        const filename = process.argv[1];
        const db = defaultDriverFactory(filename);
        try {
          db.pragma('journal_mode=WAL');
          runConversationLedgerMigrations(db);
          const store = new ConversationLedgerStore(db, filename);
          store.upsertThread({ id: 'preserved', provider: 'orchestrator', sourceKind: 'orchestrator' });
          store.upsertMessages('preserved', [{ role: 'user', content: 'Keep this conversation', sequence: 1 }]);
          const insert = db.prepare("INSERT INTO provider_event_captures VALUES (?, 'codex', 'scratch', NULL, ?, ?, ?, 'test', ?)");
          db.transaction(() => { for (let i = 0; i < 300; i++) insert.run('event-' + i, i, i, 'x'.repeat(8192), 'y'.repeat(8192)); })();
          db.pragma('wal_checkpoint(TRUNCATE)');
          const before = fs.statSync(filename).size;
          store.pruneProviderEventCapturesBefore(280, 20000);
          const rebuild = store.rebuildLedgerStorage();
          console.log(JSON.stringify({ before, after: fs.statSync(filename).size,
            autoVacuum: rebuild.after.autoVacuum, captures: store.listProviderEventCaptures({ instanceId: 'scratch' }).length,
            messages: store.getMessages('preserved').map((message) => message.content), integrity: db.pragma('quick_check') }));
        } finally { db.close(); }
      `;
      const { stdout } = await promisify(execFile)(createRequire(import.meta.url)('electron') as string,
        ['-e', script, join(directory, 'ledger.db')], { cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 10_000 });
      const result = JSON.parse(stdout.trim()) as { before: number; after: number; autoVacuum: number; captures: number; messages: string[]; integrity: unknown };
      expect(result.after).toBeLessThan(result.before / 2);
      expect(result.autoVacuum).toBe(2);
      expect(result.captures).toBe(20);
      expect(result.messages).toEqual(['Keep this conversation']);
      expect(result.integrity).toEqual([{ quick_check: 'ok' }]);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }, 15_000);

  it('uses indexed endpoints and a bounded recent sample, never a full table scan', () => {
    const db = makeDb();
    const prepare = vi.spyOn(db, 'prepare');
    const stats = getLedgerStorageStats(db);
    expect(stats.providerEvents).toMatchObject({ lowestRowid: 1, highestRowid: 200, oldestCreatedAt: 0, newestCreatedAt: 199, estimatedRows: 200, averageRowBytes: 16384 });
    for (const [sql] of [...prepare.mock.calls]) {
      expect(sql).not.toMatch(/COUNT\s*\(|dbstat/i);
      expect(sql).toMatch(/LIMIT (1|32)/);
      expect(db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all<{ detail: string }>().some((row) => /TEMP B-TREE/.test(row.detail))).toBe(false);
    }
  });
  it('refuses a rebuild with less than half the pages free', () => {
    const db = makeDb();
    expect(() => rebuildLedgerStorage(db, options)).toThrow('half');
    expect(getLedgerStorageStats(db).autoVacuum).toBe(0);
  });
  it('refuses insufficient disk and succeeds just above the guard, preserving rows', () => {
    const db = makeDb();
    db.prepare('DELETE FROM provider_event_captures WHERE sequence < 180').run();
    const before = getLedgerStorageStats(db);
    disk.available = before.liveBytes * 2 + 1024 ** 3 - 1;
    expect(() => rebuildLedgerStorage(db, options)).toThrow('free disk');
    disk.available += 2;
    const result = rebuildLedgerStorage(db, options);
    expect(result.after.autoVacuum).toBe(2);
    expect(result.bytesFreed).toBeGreaterThan(0);
    expect(result.after.databaseBytes).toBeLessThan(before.databaseBytes);
    expect(db.prepare('SELECT COUNT(*) AS count FROM provider_event_captures').get<{ count: number }>()?.count).toBe(20);
  });
  it('does no compaction before rebuilding and frees at most the explicit limit afterwards', () => {
    const db = makeDb();
    db.prepare('DELETE FROM provider_event_captures WHERE sequence < 180').run();
    const before = getLedgerStorageStats(db);
    expect(compactLedgerStorage(db, 10)).toEqual({ pagesFreed: 0, freePages: before.freePages });
    const incremental = makeDb(true);
    incremental.prepare('DELETE FROM provider_event_captures WHERE sequence < 180').run();
    const result = compactLedgerStorage(incremental, 10);
    expect(result.pagesFreed).toBeGreaterThan(0);
    expect(result.pagesFreed).toBeLessThanOrEqual(10);
    expect(() => compactLedgerStorage(incremental, NaN)).toThrow('limit');
  });
});
