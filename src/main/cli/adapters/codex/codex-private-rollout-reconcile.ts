import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultDriverFactory } from '../../../db/better-sqlite3-driver';
import type { SqliteDriver, SqliteDriverFactory } from '../../../db/sqlite-driver';
import { getLogger } from '../../../logging/logger';
import { getAioCodexSessionsDir, getAioCodexStateDir } from './codex-home-manager';
import {
  isOwnedAioRolloutPath,
  persistentRolloutPathFor,
  resolveCodexTempRoots,
} from './codex-state-leak-snapshot';

const logger = getLogger('CodexPrivateRolloutReconcile');

export interface ReconcilePrivateRolloutOptions {
  privateStatePath?: string;
  sessionsDir?: string;
  backupDir?: string;
  driverFactory?: SqliteDriverFactory;
  createBackup?: (db: SqliteDriver, backupPath: string) => void;
  tempRoots?: readonly string[];
  fileExists?: (path: string) => boolean;
  now?: () => number;
}

export type ReconcilePrivateRolloutResult =
  | { status: 'skipped'; reason: 'missing-database' | 'incompatible-schema' | 'no-stale-rows' }
  | {
    status: 'failed';
    reason: 'database-open-failed' | 'backup-failed' | 'reconcile-failed';
    error: string;
  }
  | {
    status: 'reconciled';
    backupPath: string;
    candidates: number;
    rewritten: number;
    skippedMissingFile: number;
  };

/**
 * Reconcile AIO-owned rows in the private Codex state database whose
 * `rollout_path` still points at a disposable temp `CODEX_HOME` (deleted after
 * the session ends) to the persistent AIO session store, where the rollout file
 * physically lives. Unlike the user-database cleanup, live AIO sessions write
 * these rows directly into the private database, so their paths are never
 * rewritten by the migration in `codex-state-cleanup.ts`.
 *
 * Safety: never touches the user database, only rewrites a row when the
 * destination file exists on disk, backs up before mutating, runs the rewrite
 * in a single immediate transaction, is idempotent (rewritten rows no longer
 * match the temp-home predicate), and never throws through startup.
 */
export function reconcilePrivateCodexRolloutPaths(
  options: ReconcilePrivateRolloutOptions = {},
): ReconcilePrivateRolloutResult {
  const privateStatePath = options.privateStatePath ?? join(getAioCodexStateDir(), 'state_5.sqlite');
  if (!existsSync(privateStatePath)) {
    return { status: 'skipped', reason: 'missing-database' };
  }

  const driverFactory = options.driverFactory ?? defaultDriverFactory;
  let db: SqliteDriver;
  try {
    db = driverFactory(privateStatePath);
  } catch (error) {
    return failed('database-open-failed', error);
  }

  try {
    if (!hasThreadsSchema(db)) {
      return { status: 'skipped', reason: 'incompatible-schema' };
    }

    const sessionsDir = options.sessionsDir ?? getAioCodexSessionsDir();
    const tempRoots = resolveCodexTempRoots(options.tempRoots);
    const fileExists = options.fileExists ?? existsSync;

    const rows = db.prepare('SELECT id, rollout_path FROM threads ORDER BY id')
      .all<{ id: string; rollout_path: string }>();
    let candidates = 0;
    let skippedMissingFile = 0;
    const rewrites: { id: string; dest: string }[] = [];
    for (const row of rows) {
      if (!isOwnedAioRolloutPath(row.rollout_path, tempRoots)) continue;
      candidates += 1;
      const dest = persistentRolloutPathFor(row.rollout_path, sessionsDir);
      if (dest === null || !fileExists(dest)) {
        skippedMissingFile += 1;
        continue;
      }
      rewrites.push({ id: row.id, dest });
    }

    if (rewrites.length === 0) {
      return { status: 'skipped', reason: 'no-stale-rows' };
    }

    const backupDir = options.backupDir ?? join(getAioCodexStateDir(), 'backups');
    let backupPath: string;
    try {
      mkdirSync(backupDir, { recursive: true });
      backupPath = uniqueBackupPath(backupDir, options.now?.() ?? Date.now());
      (options.createBackup ?? createConsistentBackup)(db, backupPath);
    } catch (error) {
      logger.warn('Could not back up private Codex state before rollout-path reconcile; leaving database unchanged', {
        error: message(error),
      });
      return failed('backup-failed', error);
    }

    try {
      const rewritten = runImmediateTransaction(db, () => {
        const update = db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?');
        let count = 0;
        for (const { id, dest } of rewrites) {
          count += update.run(dest, id).changes;
        }
        return count;
      });
      logger.info('Reconciled private Codex rollout paths to the persistent AIO session store', {
        candidates,
        rewritten,
        skippedMissingFile,
      });
      return { status: 'reconciled', backupPath, candidates, rewritten, skippedMissingFile };
    } catch (error) {
      logger.warn('Failed to reconcile private Codex rollout paths; transaction rolled back', {
        error: message(error),
      });
      return failed('reconcile-failed', error);
    }
  } finally {
    db.close();
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
      logger.warn('Failed to roll back private Codex rollout reconcile transaction', {
        error: message(rollbackError),
      });
    }
    throw error;
  }
}

function createConsistentBackup(db: SqliteDriver, backupPath: string): void {
  db.prepare('VACUUM INTO ?').run(backupPath);
}

function hasThreadsSchema(db: SqliteDriver): boolean {
  const columns = db.pragma('main.table_info(threads)');
  if (!Array.isArray(columns)) return false;
  const names = new Set(columns.flatMap((column) => {
    if (!column || typeof column !== 'object') return [];
    const name = (column as { name?: unknown }).name;
    return typeof name === 'string' ? [name] : [];
  }));
  return ['id', 'rollout_path'].every((column) => names.has(column));
}

function uniqueBackupPath(backupDir: string, timestamp: number): string {
  const stamp = new Date(timestamp).toISOString().replace(/[.:-]/g, '');
  const base = join(backupDir, `state_5-before-rollout-reconcile-${stamp}`);
  let candidate = `${base}.sqlite`;
  let suffix = 1;
  while (existsSync(candidate)) {
    candidate = `${base}-${suffix}.sqlite`;
    suffix += 1;
  }
  return candidate;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failed(
  reason: 'database-open-failed' | 'backup-failed' | 'reconcile-failed',
  error: unknown,
): Extract<ReconcilePrivateRolloutResult, { status: 'failed' }> {
  return { status: 'failed', reason, error: message(error) };
}
