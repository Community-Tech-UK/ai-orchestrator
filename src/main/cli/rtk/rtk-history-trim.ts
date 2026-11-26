import { existsSync, statSync } from 'node:fs';
import { getLogger } from '../../logging/logger';
import type { SqliteDriver, SqliteDriverFactory } from '../../db/sqlite-driver';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import { getRtkTrackingDbPath } from './rtk-tracking-reader';

const logger = getLogger('RtkHistoryTrim');

/** Ask-first trim window; RTK itself forgets after 90 days. */
export const RTK_HISTORY_KEEP_DAYS = 30;
const BATCH = 2000;
const BATCH_PAUSE_MS = 25;
const MAX_BUSY_IN_A_ROW = 3;

export interface RtkHistoryTrimPreview {
  available: boolean;
  dbPath: string;
  fileBytes: number;
  commandsToRemove: number;
  failuresToRemove: number;
  oldestAt: number | null;
  newestAt: number | null;
  cutoffAt: number;
  estimatedBytes: number;
}

export interface RtkHistoryTrimResult {
  removedCommands: number;
  removedFailures: number;
  stoppedEarly: boolean;
}

function isBusy(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && /SQLITE_BUSY|database is locked/i.test(String((error as { code?: unknown }).code ?? (error as Error).message ?? error));
}

function hasTimestampColumn(db: SqliteDriver, table: string): boolean {
  const columns = db.pragma(`main.table_info(${table})`);
  if (!Array.isArray(columns)) return false;
  return columns.some((column) => typeof column === 'object' && column !== null
    && (column as { name?: unknown }).name === 'timestamp');
}

function openExisting(dbPath: string, factory: SqliteDriverFactory): SqliteDriver | null {
  if (!existsSync(dbPath)) return null;
  let db: SqliteDriver | null = null;
  let valid = false;
  try {
    db = factory(dbPath, { readonly: true });
    valid = hasTimestampColumn(db, 'commands') && hasTimestampColumn(db, 'parse_failures');
    return valid ? db : null;
  } catch (error) {
    logger.warn('Could not open the RTK history database', { error: error instanceof Error ? error.message : String(error) });
    return null;
  } finally {
    if (db && !valid) {
      try { db.close(); } catch (error) {
        logger.warn('Could not close the RTK history database', { error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
}

export function previewRtkHistoryTrim(
  keepDays: number = RTK_HISTORY_KEEP_DAYS,
  options: { dbPath?: string; now?: () => number; driverFactory?: SqliteDriverFactory } = {},
): RtkHistoryTrimPreview {
  const dbPath = options.dbPath ?? getRtkTrackingDbPath();
  const now = options.now?.() ?? Date.now();
  const cutoffAt = now - keepDays * 86_400_000;
  const empty: RtkHistoryTrimPreview = {
    available: false, dbPath, fileBytes: 0, commandsToRemove: 0, failuresToRemove: 0,
    oldestAt: null, newestAt: null, cutoffAt, estimatedBytes: 0,
  };
  const db = openExisting(dbPath, options.driverFactory ?? defaultDriverFactory);
  if (!db) return empty;
  try {
    const cutoffIso = new Date(cutoffAt).toISOString();
    const fileBytes = statSync(dbPath).size;
    const commands = db.prepare('SELECT COUNT(*) AS total FROM commands').get<{ total: number }>()?.total ?? 0;
    const failures = db.prepare('SELECT COUNT(*) AS total FROM parse_failures').get<{ total: number }>()?.total ?? 0;
    const commandsToRemove = db.prepare('SELECT COUNT(*) AS total FROM commands WHERE timestamp < ?').get<{ total: number }>(cutoffIso)?.total ?? 0;
    const failuresToRemove = db.prepare('SELECT COUNT(*) AS total FROM parse_failures WHERE timestamp < ?').get<{ total: number }>(cutoffIso)?.total ?? 0;
    const range = db.prepare('SELECT MIN(timestamp) AS oldest, MAX(timestamp) AS newest FROM commands')
      .get<{ oldest: string | null; newest: string | null }>();
    const totalRows = commands + failures;
    const removeRows = commandsToRemove + failuresToRemove;
    return {
      available: true,
      dbPath,
      fileBytes,
      commandsToRemove,
      failuresToRemove,
      oldestAt: range?.oldest ? Date.parse(range.oldest) : null,
      newestAt: range?.newest ? Date.parse(range.newest) : null,
      cutoffAt,
      estimatedBytes: totalRows > 0 ? Math.round(fileBytes * (removeRows / totalRows)) : 0,
    };
  } catch (error) {
    logger.warn('Could not preview the RTK history trim', { error: error instanceof Error ? error.message : String(error) });
    return empty;
  } finally {
    db.close();
  }
}

async function trimTable(
  db: SqliteDriver,
  table: 'commands' | 'parse_failures',
  cutoffIso: string,
  onProgress?: (removed: number) => void,
  shouldAbort?: () => boolean,
): Promise<{ removed: number; stoppedEarly: boolean }> {
  let removed = 0;
  let busyInARow = 0;
  for (;;) {
    if (shouldAbort?.()) return { removed, stoppedEarly: true };
    try {
      db.exec('BEGIN IMMEDIATE');
      const result = db.prepare(
        `DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE timestamp < ? LIMIT ${BATCH})`,
      ).run(cutoffIso);
      db.exec('COMMIT');
      const count = result.changes;
      removed += count;
      busyInARow = 0;
      if (count > 0) onProgress?.(count);
      if (count < BATCH) return { removed, stoppedEarly: false };
      await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
      if (isBusy(error)) {
        busyInARow += 1;
        if (busyInARow >= MAX_BUSY_IN_A_ROW) {
          logger.info('RTK history trim stopped on a busy database', { table, removed });
          return { removed, stoppedEarly: true };
        }
        await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
        continue;
      }
      logger.warn('RTK history trim failed', { table, error: error instanceof Error ? error.message : String(error) });
      return { removed, stoppedEarly: true };
    }
  }
}

/**
 * Ask-first removal of RTK history rows older than `keepDays`. Batched
 * transactions so RTK's own writers keep their lock most of the time; never
 * VACUUM (an exclusive lock would time RTK writers out). The file keeps its
 * size on disk; RTK reuses the freed pages.
 */
export async function trimRtkHistory(
  keepDays: number = RTK_HISTORY_KEEP_DAYS,
  options: {
    dbPath?: string;
    now?: () => number;
    driverFactory?: SqliteDriverFactory;
    onProgress?: (removed: number) => void;
    shouldAbort?: () => boolean;
  } = {},
): Promise<RtkHistoryTrimResult> {
  const dbPath = options.dbPath ?? getRtkTrackingDbPath();
  const now = options.now?.() ?? Date.now();
  const cutoffIso = new Date(now - keepDays * 86_400_000).toISOString();
  if (!existsSync(dbPath)) return { removedCommands: 0, removedFailures: 0, stoppedEarly: false };
  let db: SqliteDriver;
  try {
    db = (options.driverFactory ?? defaultDriverFactory)(dbPath);
  } catch (error) {
    logger.warn('Could not open the RTK history database for trimming', { error: error instanceof Error ? error.message : String(error) });
    return { removedCommands: 0, removedFailures: 0, stoppedEarly: true };
  }
  try {
    if (!hasTimestampColumn(db, 'commands') || !hasTimestampColumn(db, 'parse_failures')) {
      return { removedCommands: 0, removedFailures: 0, stoppedEarly: false };
    }
    db.exec('PRAGMA busy_timeout = 250');
    const commands = await trimTable(db, 'commands', cutoffIso, options.onProgress, options.shouldAbort);
    const failures = await trimTable(db, 'parse_failures', cutoffIso, options.onProgress, options.shouldAbort);
    try { db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch { /* best effort */ }
    return {
      removedCommands: commands.removed,
      removedFailures: failures.removed,
      stoppedEarly: commands.stoppedEarly || failures.stoppedEarly,
    };
  } finally {
    db.close();
  }
}
