import { statfsSync, type StatsFs } from 'node:fs';
import type { SqliteDriver } from '../db/sqlite-driver';

export interface LedgerStorageStats {
  pageSize: number;
  pageCount: number;
  freePages: number;
  autoVacuum: number;
  databaseBytes: number;
  freeBytes: number;
  liveBytes: number;
  providerEvents: {
    lowestRowid: number | null;
    highestRowid: number | null;
    oldestCreatedAt: number | null;
    newestCreatedAt: number | null;
    /** Rowid span is an upper-bound estimate, not an exact row count. */
    estimatedRows: number;
    averageRowBytes: number;
    estimatedBytes: number;
  };
}

export interface LedgerCompactionResult { pagesFreed: number; freePages: number; }
export interface LedgerRebuildResult {
  before: LedgerStorageStats;
  after: LedgerStorageStats;
  durationMs: number;
  bytesFreed: number;
  requiredDiskBytes: number;
}

/** Index endpoints and a bounded sample only: never COUNT(*) or dbstat. */
export function getLedgerStorageStats(db: SqliteDriver): LedgerStorageStats {
  const pageSize = Number(db.pragma('page_size', { simple: true }));
  const pageCount = Number(db.pragma('page_count', { simple: true }));
  const freePages = Number(db.pragma('freelist_count', { simple: true }));
  const autoVacuum = Number(db.pragma('auto_vacuum', { simple: true }));
  const lowestRowid = db.prepare('SELECT rowid FROM provider_event_captures ORDER BY rowid ASC LIMIT 1').get<{ rowid: number }>()?.rowid ?? null;
  const highestRowid = db.prepare('SELECT rowid FROM provider_event_captures ORDER BY rowid DESC LIMIT 1').get<{ rowid: number }>()?.rowid ?? null;
  const oldestCreatedAt = db.prepare('SELECT created_at FROM provider_event_captures ORDER BY created_at ASC LIMIT 1').get<{ created_at: number }>()?.created_at ?? null;
  const newestCreatedAt = db.prepare('SELECT created_at FROM provider_event_captures ORDER BY created_at DESC LIMIT 1').get<{ created_at: number }>()?.created_at ?? null;
  const averageRowBytes = db.prepare(`SELECT AVG(bytes) AS average FROM (
    SELECT length(CAST(event_json AS BLOB)) + length(CAST(raw_json AS BLOB)) AS bytes
    FROM provider_event_captures ORDER BY rowid DESC LIMIT 32
  )`).get<{ average: number | null }>()?.average ?? 0;
  const estimatedRows = lowestRowid === null || highestRowid === null ? 0 : highestRowid - lowestRowid + 1;
  return { pageSize, pageCount, freePages, autoVacuum,
    databaseBytes: pageCount * pageSize, freeBytes: freePages * pageSize,
    liveBytes: (pageCount - freePages) * pageSize,
    providerEvents: { lowestRowid, highestRowid, oldestCreatedAt, newestCreatedAt,
      estimatedRows, averageRowBytes, estimatedBytes: estimatedRows * averageRowBytes } };
}

export function compactLedgerStorage(db: SqliteDriver, maxPages: number): LedgerCompactionResult {
  if (!Number.isSafeInteger(maxPages) || maxPages <= 0) throw new Error('Invalid incremental vacuum page limit');
  const before = Number(db.pragma('freelist_count', { simple: true }));
  if (Number(db.pragma('auto_vacuum', { simple: true })) === 2 && before > 0) {
    db.pragma(`incremental_vacuum(${maxPages})`);
    db.pragma('wal_checkpoint(PASSIVE)');
  }
  const freePages = Number(db.pragma('freelist_count', { simple: true }));
  return { pagesFreed: Math.max(0, before - freePages), freePages };
}

/** Explicit action only. The caller supplies the worker-owned database path. */
export function rebuildLedgerStorage(db: SqliteDriver, options: { dbPath: string; statfs?: (path: string) => Pick<StatsFs, 'bavail' | 'bsize'> }): LedgerRebuildResult {
  const before = getLedgerStorageStats(db);
  if (before.freePages * 2 < before.pageCount) throw new Error('At least half the ledger pages must be free before rebuilding');
  const disk = (options.statfs ?? statfsSync)(options.dbPath);
  const requiredDiskBytes = before.liveBytes * 2 + 1024 ** 3;
  if (disk.bavail * disk.bsize < requiredDiskBytes) throw new Error('Not enough free disk space to rebuild the conversation ledger');
  const startedAt = Date.now();
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.pragma('auto_vacuum = INCREMENTAL');
  db.exec('VACUUM');
  db.pragma('wal_checkpoint(TRUNCATE)');
  const after = getLedgerStorageStats(db);
  return { before, after, requiredDiskBytes, durationMs: Date.now() - startedAt,
    bytesFreed: Math.max(0, before.databaseBytes - after.databaseBytes) };
}
