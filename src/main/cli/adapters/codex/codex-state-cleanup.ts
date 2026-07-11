import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { defaultDriverFactory } from '../../../db/better-sqlite3-driver';
import type { SqliteDriver, SqliteDriverFactory } from '../../../db/sqlite-driver';
import { getLogger } from '../../../logging/logger';
import { getAioCodexSessionsDir, getAioCodexStateDir } from './codex-home-manager';
import { captureLeakedCodexState, resolveCodexTempRoots } from './codex-state-leak-snapshot';

const logger = getLogger('CodexStateCleanup');

export interface CodexStateCleanupOptions {
  statePath?: string;
  privateStatePath?: string;
  backupDir?: string;
  driverFactory?: SqliteDriverFactory;
  createBackup?: (db: SqliteDriver, backupPath: string) => void;
  migrateLeakedThreads?: (context: CodexStateMigrationContext) => number;
  tempRoots?: readonly string[];
  now?: () => number;
}

export interface CodexStateMigrationContext {
  backupPath: string;
  privateStatePath: string;
  sessionsDir: string;
  expectedThreads: number;
  threadIds: readonly string[];
  driverFactory: SqliteDriverFactory;
}

export type CodexStateCleanupResult =
  | { status: 'skipped'; reason: 'missing-database' | 'incompatible-schema' | 'no-leaked-threads' }
  | {
    status: 'failed';
    reason:
      | 'database-open-failed'
      | 'backup-failed'
      | 'migration-failed'
      | 'concurrent-state-change'
      | 'cleanup-failed';
    error: string;
  }
  | {
    status: 'cleaned';
    backupPath: string;
    migratedThreads: number;
    removedThreads: number;
    removedSpawnEdges: number;
    removedDynamicTools: number;
    clearedJobAssignments: number;
  };

export function cleanupLeakedAioCodexThreads(
  options: CodexStateCleanupOptions = {},
): CodexStateCleanupResult {
  const statePath = options.statePath ?? join(homedir(), '.codex', 'state_5.sqlite');
  if (!existsSync(statePath)) {
    return { status: 'skipped', reason: 'missing-database' };
  }

  const driverFactory = options.driverFactory ?? defaultDriverFactory;
  let db: SqliteDriver;
  try {
    db = driverFactory(statePath);
  } catch (error) {
    return failed('database-open-failed', error);
  }

  try {
    if (!hasExpectedThreadsSchema(db)) {
      return { status: 'skipped', reason: 'incompatible-schema' };
    }

    const tempRoots = resolveCodexTempRoots(options.tempRoots);
    const initialSnapshot = captureLeakedCodexState(db, tempRoots);
    const leakedThreadIds = initialSnapshot.threadIds;
    const leakedCount = leakedThreadIds.length;
    if (leakedCount === 0) {
      return { status: 'skipped', reason: 'no-leaked-threads' };
    }

    const backupDir = options.backupDir ?? join(getAioCodexStateDir(), 'backups');
    let backupPath: string;
    try {
      mkdirSync(backupDir, { recursive: true });
      backupPath = uniqueBackupPath(backupDir, options.now?.() ?? Date.now());
      (options.createBackup ?? createConsistentBackup)(db, backupPath);
    } catch (error) {
      logger.warn('Could not back up Codex state before AIO leak cleanup; leaving database unchanged', {
        error: error instanceof Error ? error.message : String(error),
      });
      return failed('backup-failed', error);
    }

    const privateStatePath = options.privateStatePath ?? join(getAioCodexStateDir(), 'state_5.sqlite');
    let migratedThreads: number;
    try {
      const migrate = options.migrateLeakedThreads ?? migrateLeakedAioThreadsToPrivateState;
      migratedThreads = migrate({
        backupPath,
        privateStatePath,
        sessionsDir: getAioCodexSessionsDir(),
        expectedThreads: leakedCount,
        threadIds: leakedThreadIds,
        driverFactory,
      });
      if (migratedThreads !== leakedCount) {
        throw new Error(`Expected to migrate ${leakedCount} AIO threads, migrated ${migratedThreads}`);
      }
    } catch (error) {
      logger.warn('Could not migrate leaked AIO threads into private state; leaving user database unchanged', {
        error: error instanceof Error ? error.message : String(error),
      });
      return failed('migration-failed', error);
    }

    try {
      const counts = runImmediateTransaction(db, () => {
        const currentSnapshot = captureLeakedCodexState(db, tempRoots);
        if (currentSnapshot.fingerprint !== initialSnapshot.fingerprint) {
          throw new ConcurrentStateChangeError(initialSnapshot.threadIds, currentSnapshot.threadIds);
        }

        const idList = sqlList(leakedThreadIds);
        const removedSpawnEdges = hasColumns(db, 'thread_spawn_edges', ['parent_thread_id', 'child_thread_id'])
          ? db.prepare(`
              DELETE FROM thread_spawn_edges
              WHERE parent_thread_id IN (${idList})
                 OR child_thread_id IN (${idList})
            `).run(...leakedThreadIds, ...leakedThreadIds).changes
          : 0;
        const removedDynamicTools = hasColumns(db, 'thread_dynamic_tools', ['thread_id'])
          ? db.prepare(`DELETE FROM thread_dynamic_tools WHERE thread_id IN (${idList})`)
            .run(...leakedThreadIds).changes
          : 0;
        const clearedJobAssignments = hasColumns(db, 'agent_job_items', ['assigned_thread_id'])
          ? db.prepare(`
              UPDATE agent_job_items
              SET assigned_thread_id = NULL
              WHERE assigned_thread_id IN (${idList})
            `).run(...leakedThreadIds).changes
          : 0;
        const removedThreads = db.prepare(`DELETE FROM threads WHERE id IN (${idList})`)
          .run(...leakedThreadIds).changes;

        return { removedThreads, removedSpawnEdges, removedDynamicTools, clearedJobAssignments };
      });
      logger.info('Removed leaked AIO threads from the user Codex state database', counts);
      return { status: 'cleaned', backupPath, migratedThreads, ...counts };
    } catch (error) {
      if (error instanceof ConcurrentStateChangeError) {
        logger.warn('Codex thread state changed during AIO leak migration; leaving user database unchanged', {
          beforeCount: error.beforeCount,
          currentCount: error.currentCount,
        });
        return failed('concurrent-state-change', error);
      }
      logger.warn('Failed to remove leaked AIO threads; transaction rolled back', {
        error: error instanceof Error ? error.message : String(error),
      });
      return failed('cleanup-failed', error);
    }
  } finally {
    db.close();
  }
}

class ConcurrentStateChangeError extends Error {
  readonly beforeCount: number;
  readonly currentCount: number;

  constructor(before: readonly string[], current: readonly string[]) {
    super('Codex thread state changed after the cleanup snapshot');
    this.name = 'ConcurrentStateChangeError';
    this.beforeCount = before.length;
    this.currentCount = current.length;
  }
}

function runImmediateTransaction<T>(db: SqliteDriver, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      logger.warn('Failed to roll back Codex state cleanup transaction', {
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
    }
    throw error;
  }
}

export function migrateLeakedAioThreadsToPrivateState(
  context: CodexStateMigrationContext,
): number {
  const { backupPath, privateStatePath, sessionsDir, expectedThreads, threadIds, driverFactory } = context;
  mkdirSync(dirname(privateStatePath), { recursive: true });
  const privateStateExisted = existsSync(privateStatePath);
  const seedPrivateState = !privateStateExisted || statSync(privateStatePath).size === 0;
  let privateDb: SqliteDriver | null = null;
  let migrationCompleted = false;

  try {
    if (seedPrivateState) {
      rmSync(`${privateStatePath}-wal`, { force: true });
      rmSync(`${privateStatePath}-shm`, { force: true });
      copyFileSync(backupPath, privateStatePath);
    }

    privateDb = driverFactory(privateStatePath);
    if (!hasExpectedThreadsSchema(privateDb)) {
      throw new Error('Private Codex state database has an incompatible threads schema');
    }

    let migratedThreads: number;
    if (seedPrivateState) {
      pruneSeededPrivateState(privateDb, threadIds);
      migratedThreads = countThreads(privateDb, 'main', threadIds);
    } else {
      migratedThreads = mergeLeakedThreadsFromBackup(privateDb, backupPath, threadIds);
    }
    rewritePrivateRolloutPaths(privateDb, sessionsDir, threadIds);

    if (migratedThreads !== expectedThreads) {
      throw new Error(`Private Codex state contains ${migratedThreads} of ${expectedThreads} expected AIO threads`);
    }
    migrationCompleted = true;
    return migratedThreads;
  } finally {
    try {
      privateDb?.close();
    } finally {
      if (seedPrivateState && !migrationCompleted) {
        rmSync(privateStatePath, { force: true });
        rmSync(`${privateStatePath}-wal`, { force: true });
        rmSync(`${privateStatePath}-shm`, { force: true });
        if (privateStateExisted) {
          writeFileSync(privateStatePath, '');
        }
      }
    }
  }
}

function pruneSeededPrivateState(db: SqliteDriver, threadIds: readonly string[]): void {
  const idList = sqlList(threadIds);
  const prune = db.transaction(() => {
    if (hasColumns(db, 'thread_spawn_edges', ['parent_thread_id', 'child_thread_id'])) {
      db.prepare(`
        DELETE FROM thread_spawn_edges
        WHERE parent_thread_id NOT IN (${idList})
           OR child_thread_id NOT IN (${idList})
      `).run(...threadIds, ...threadIds);
    }
    if (hasColumns(db, 'thread_dynamic_tools', ['thread_id'])) {
      db.prepare(`DELETE FROM thread_dynamic_tools WHERE thread_id NOT IN (${idList})`).run(...threadIds);
    }
    if (hasColumns(db, 'agent_job_items', ['assigned_thread_id'])) {
      if (hasColumns(db, 'agent_job_items', ['job_id'])) {
        db.prepare(`
          DELETE FROM agent_job_items
          WHERE job_id NOT IN (
            SELECT DISTINCT job_id
            FROM agent_job_items
            WHERE assigned_thread_id IN (${idList})
          )
        `).run(...threadIds);
        if (hasColumns(db, 'agent_jobs', ['id'])) {
          db.prepare('DELETE FROM agent_jobs WHERE id NOT IN (SELECT DISTINCT job_id FROM agent_job_items)').run();
        }
      }
      db.prepare(`
        UPDATE agent_job_items
        SET assigned_thread_id = NULL
        WHERE assigned_thread_id IS NOT NULL
          AND assigned_thread_id NOT IN (${idList})
      `).run(...threadIds);
    }
    db.prepare(`DELETE FROM threads WHERE id NOT IN (${idList})`).run(...threadIds);
  });
  prune();
}

function mergeLeakedThreadsFromBackup(
  db: SqliteDriver,
  backupPath: string,
  threadIds: readonly string[],
): number {
  db.prepare('ATTACH DATABASE ? AS aio_leak_source').run(backupPath);
  try {
    return mergeAttachedCodexThreads(db, threadIds);
  } finally {
    db.prepare('DETACH DATABASE aio_leak_source').run();
  }
}

export function mergeAttachedCodexThreads(db: SqliteDriver, threadIds: readonly string[]): number {
  const idList = sqlList(threadIds);
  const merge = db.transaction(() => {
    copyMatchingRows(db, 'threads', `source.id IN (${idList})`, ['id'], threadIds);

    if (hasColumnsInBothSchemas(db, 'thread_spawn_edges', ['parent_thread_id', 'child_thread_id'])) {
      copyMatchingRows(db, 'thread_spawn_edges', `
        source.parent_thread_id IN (SELECT id FROM main.threads)
        AND source.child_thread_id IN (SELECT id FROM main.threads)
        AND (source.parent_thread_id IN (${idList}) OR source.child_thread_id IN (${idList}))
      `, ['child_thread_id'], [...threadIds, ...threadIds]);
    }
    if (hasColumnsInBothSchemas(db, 'thread_dynamic_tools', ['thread_id', 'position'])) {
      copyMatchingRows(
        db,
        'thread_dynamic_tools',
        `source.thread_id IN (${idList})`,
        ['thread_id', 'position'],
        threadIds,
      );
    }
    copyJobMetadata(db, threadIds);
    return countThreads(db, 'main', threadIds);
  });
  return merge();
}

function copyJobMetadata(db: SqliteDriver, threadIds: readonly string[]): void {
  if (!hasColumnsInBothSchemas(db, 'agent_job_items', ['job_id', 'item_id', 'assigned_thread_id'])) return;
  const idList = sqlList(threadIds);
  const jobIds = `SELECT DISTINCT job_id FROM aio_leak_source.agent_job_items WHERE assigned_thread_id IN (${idList})`;
  if (hasColumnsInBothSchemas(db, 'agent_jobs', ['id'])) {
    copyMatchingRows(db, 'agent_jobs', `source.id IN (${jobIds})`, ['id'], threadIds);
  }
  copyMatchingRows(
    db,
    'agent_job_items',
    `source.job_id IN (${jobIds})`,
    ['job_id', 'item_id'],
    threadIds,
  );
  db.prepare(`
    UPDATE main.agent_job_items
    SET assigned_thread_id = NULL
    WHERE job_id IN (${jobIds})
      AND assigned_thread_id IS NOT NULL
      AND assigned_thread_id NOT IN (${idList})
  `).run(...threadIds, ...threadIds);
}

function copyMatchingRows(
  db: SqliteDriver,
  table: string,
  where: string,
  conflictKeys: readonly string[],
  params: readonly string[],
): void {
  const targetColumns = getColumns(db, 'main', table);
  const sourceColumns = new Set(getColumns(db, 'aio_leak_source', table));
  const columns = targetColumns.filter((column) => sourceColumns.has(column));
  if (columns.length === 0) {
    throw new Error(`No compatible columns for private Codex table ${table}`);
  }

  const identifiers = columns.map(quoteIdentifier).join(', ');
  const selections = columns.map((column) => `source.${quoteIdentifier(column)}`).join(', ');
  const updates = columns
    .filter((column) => !conflictKeys.includes(column))
    .map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`)
    .join(', ');
  const conflictAction = updates.length > 0 ? `DO UPDATE SET ${updates}` : 'DO NOTHING';
  db.prepare(`
    INSERT INTO main.${quoteIdentifier(table)} (${identifiers})
    SELECT ${selections}
    FROM aio_leak_source.${quoteIdentifier(table)} AS source
    WHERE ${where}
    ON CONFLICT (${conflictKeys.map(quoteIdentifier).join(', ')}) ${conflictAction}
  `).run(...params);
}

function rewritePrivateRolloutPaths(
  db: SqliteDriver,
  sessionsDir: string,
  threadIds: readonly string[],
): void {
  const normalized = "replace(rollout_path, char(92), '/')";
  db.prepare(`
    UPDATE threads
    SET rollout_path = ? || replace(
      substr(${normalized}, instr(${normalized}, '/sessions/') + length('/sessions/')),
      '/',
      ?
    )
    WHERE id IN (${sqlList(threadIds)})
      AND instr(${normalized}, '/sessions/') > 0
  `).run(`${sessionsDir}${sep}`, sep, ...threadIds);
}

function createConsistentBackup(db: SqliteDriver, backupPath: string): void {
  db.prepare('VACUUM INTO ?').run(backupPath);
}

function hasExpectedThreadsSchema(db: SqliteDriver): boolean {
  return hasColumns(db, 'threads', ['id', 'rollout_path']);
}

function hasColumns(db: SqliteDriver, table: string, required: readonly string[]): boolean {
  return hasColumnsInSchema(db, 'main', table, required);
}

function hasColumnsInSchema(
  db: SqliteDriver,
  schema: 'main' | 'aio_leak_source',
  table: string,
  required: readonly string[],
): boolean {
  const names = new Set(getColumns(db, schema, table));
  return required.every((column) => names.has(column));
}

function hasColumnsInBothSchemas(db: SqliteDriver, table: string, required: readonly string[]): boolean {
  return hasColumnsInSchema(db, 'main', table, required)
    && hasColumnsInSchema(db, 'aio_leak_source', table, required);
}

function getColumns(db: SqliteDriver, schema: 'main' | 'aio_leak_source', table: string): string[] {
  const tableRow = db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = ? AND name = ?`)
    .get<{ name: string }>('table', table);
  if (!tableRow) return [];

  const columns = db.pragma(`${schema}.table_info(${table})`);
  if (!Array.isArray(columns)) return [];
  return columns.flatMap((column) => {
    if (!column || typeof column !== 'object') return [];
    const name = (column as { name?: unknown }).name;
    return typeof name === 'string' ? [name] : [];
  });
}

function countThreads(
  db: SqliteDriver,
  schema: 'main' | 'aio_leak_source',
  threadIds: readonly string[],
): number {
  if (threadIds.length === 0) return 0;
  return db.prepare(`SELECT COUNT(*) AS count FROM ${schema}.threads WHERE id IN (${sqlList(threadIds)})`)
    .get<{ count: number }>(...threadIds)?.count ?? 0;
}

function sqlList(values: readonly unknown[]): string {
  if (values.length === 0) throw new Error('Cannot build an empty SQLite value list');
  return values.map(() => '?').join(', ');
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function uniqueBackupPath(backupDir: string, timestamp: number): string {
  const stamp = new Date(timestamp).toISOString().replace(/[.:-]/g, '');
  const base = join(backupDir, `state_5-before-aio-cleanup-${stamp}`);
  let candidate = `${base}.sqlite`;
  let suffix = 1;
  while (existsSync(candidate)) {
    candidate = `${base}-${suffix}.sqlite`;
    suffix += 1;
  }
  return candidate;
}

function failed(
  reason:
    | 'database-open-failed'
    | 'backup-failed'
    | 'migration-failed'
    | 'concurrent-state-change'
    | 'cleanup-failed',
  error: unknown,
): Extract<CodexStateCleanupResult, { status: 'failed' }> {
  return {
    status: 'failed',
    reason,
    error: error instanceof Error ? error.message : String(error),
  };
}
