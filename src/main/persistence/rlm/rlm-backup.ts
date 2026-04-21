/**
 * RLM Backup Module
 *
 * Backup and restore operations.
 * Note: This file uses better-sqlite3's db.exec() method for SQL,
 * not child_process.exec(). This is safe database SQL execution.
 */

import * as path from 'path';
import * as fs from 'fs';
import { defaultDriverFactory } from '../../db/better-sqlite3-driver';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { copyDirectoryRecursive, getDirectorySize } from './rlm-content';

/**
 * Create a backup of the database.
 * Uses SQLite's backup API for WAL-safe consistent backups.
 */
export function backupDatabase(
  db: SqliteDriver,
  contentDir: string,
  targetPath: string,
  options?: { includeContent?: boolean }
): {
  dbBackupPath: string;
  contentBackupPath?: string;
  dbSizeBytes: number;
  contentSizeBytes?: number;
} {
  const includeContent = options?.includeContent ?? true;

  // Ensure target directory exists
  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Use SQLite's backup API via better-sqlite3's backup method
  // This is WAL-safe and creates a consistent snapshot
  db.backup(targetPath);

  const dbStats = fs.statSync(targetPath);
  const result: {
    dbBackupPath: string;
    contentBackupPath?: string;
    dbSizeBytes: number;
    contentSizeBytes?: number;
  } = {
    dbBackupPath: targetPath,
    dbSizeBytes: dbStats.size,
  };

  // Optionally backup content directory
  if (includeContent && fs.existsSync(contentDir)) {
    const contentBackupPath = targetPath.replace(/\.db$/, '') + '_content';
    copyDirectoryRecursive(contentDir, contentBackupPath);
    result.contentBackupPath = contentBackupPath;
    result.contentSizeBytes = getDirectorySize(contentBackupPath);
  }

  return result;
}

/**
 * Restore the database from a backup file.
 */
export function restoreDatabase(
  sourcePath: string,
  dbPath: string,
  contentDir: string,
  options?: { includeContent?: boolean }
): void {
  const includeContent = options?.includeContent ?? true;

  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Backup file not found: ${sourcePath}`);
  }

  // Verify backup is a valid SQLite database
  try {
    const testDb = defaultDriverFactory(sourcePath, { readonly: true });
    testDb.pragma('integrity_check');
    testDb.close();
  } catch (error) {
    throw new Error(
      `Invalid backup file: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // In WAL mode, we need to checkpoint and remove WAL files
  const walPath = dbPath + '-wal';
  const shmPath = dbPath + '-shm';

  // Remove existing database files
  if (fs.existsSync(dbPath)) {
    fs.unlinkSync(dbPath);
  }
  if (fs.existsSync(walPath)) {
    fs.unlinkSync(walPath);
  }
  if (fs.existsSync(shmPath)) {
    fs.unlinkSync(shmPath);
  }

  // Copy backup to database location
  fs.copyFileSync(sourcePath, dbPath);

  // Restore content directory if present
  if (includeContent) {
    const contentBackupPath = sourcePath.replace(/\.db$/, '') + '_content';
    if (fs.existsSync(contentBackupPath)) {
      // Remove existing content directory
      if (fs.existsSync(contentDir)) {
        fs.rmSync(contentDir, { recursive: true, force: true });
      }
      copyDirectoryRecursive(contentBackupPath, contentDir);
    }
  }
}

/**
 * Create a WAL checkpoint.
 */
export function checkpoint(db: SqliteDriver): void {
  db.pragma('wal_checkpoint(TRUNCATE)');
}

/**
 * Vacuum the database.
 * Uses better-sqlite3's exec for SQL execution (not child_process).
 */
export function vacuum(db: SqliteDriver): void {
  db.exec('VACUUM');
}

/**
 * Get database statistics.
 */
export function getStats(
  db: SqliteDriver,
  dbPath: string
): {
  stores: number;
  sections: number;
  sessions: number;
  outcomes: number;
  patterns: number;
  experiences: number;
  insights: number;
  vectors: number;
  dbSizeBytes: number;
} {
  const counts = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM context_stores) as stores,
      (SELECT COUNT(*) FROM context_sections) as sections,
      (SELECT COUNT(*) FROM rlm_sessions) as sessions,
      (SELECT COUNT(*) FROM outcomes) as outcomes,
      (SELECT COUNT(*) FROM patterns) as patterns,
      (SELECT COUNT(*) FROM experiences) as experiences,
      (SELECT COUNT(*) FROM insights) as insights,
      (SELECT COUNT(*) FROM vectors) as vectors
  `).get() as {
    stores: number;
    sections: number;
    sessions: number;
    outcomes: number;
    patterns: number;
    experiences: number;
    insights: number;
    vectors: number;
  };

  const dbStats = fs.statSync(dbPath);

  return {
    stores: counts.stores,
    sections: counts.sections,
    sessions: counts.sessions,
    outcomes: counts.outcomes,
    patterns: counts.patterns,
    experiences: counts.experiences,
    insights: counts.insights,
    vectors: counts.vectors,
    dbSizeBytes: dbStats.size,
  };
}
