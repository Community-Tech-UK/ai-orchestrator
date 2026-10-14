import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogger } from '../logging/logger';
import { listStorageFiles, mapStorageFiles } from '../storage/storage-files';

const logger = getLogger('RlmBackupRetention');
const BACKUP_NAME = /^rlm-maintenance-.*\.db$/;
const TIMESTAMPED_BACKUP_NAME = /^rlm-maintenance-(\d{8}T\d{9}Z)-.*\.db$/;
const STAGING_NAME = /^\.rlm-backup-prune-(rlm-maintenance-.*\.db)-\d+-\d+$/;

export interface RlmBackupPruneSummary {
  deleted: number;
  bytesFreed: number;
  failed: number;
}

export interface RlmBackupSet {
  name: string;
  createdAt: number;
  bytes: number;
}

export function listBackupSets(directory: string): RlmBackupSet[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && BACKUP_NAME.test(entry.name))
    .map((entry) => {
      const dbPath = path.join(directory, entry.name);
      return { name: entry.name, createdAt: parseBackupTimestamp(entry.name) ?? fs.statSync(dbPath).mtimeMs,
        bytes: backupSetPaths(dbPath).reduce((sum, item) => sum + (fs.existsSync(item) ? sizeOf(item) : 0), 0) };
    }).sort((a, b) => b.createdAt - a.createdAt || b.name.localeCompare(a.name));
}

/** Background storage-card listing: asynchronous filesystem work, bounded traversal, no links. */
export async function listBackupSetsAsync(directory: string): Promise<RlmBackupSet[]> {
  const files = await listStorageFiles(directory, false);
  const bytesByPath = new Map(files.map((file) => [file.path, file.bytes]));
  const databases = files.filter((file) => BACKUP_NAME.test(path.basename(file.path)));
  const backups = await mapStorageFiles(databases, async (file): Promise<RlmBackupSet> => {
    const paths = backupSetPaths(file.path);
    const contentFiles = await listStorageFiles(paths[3]!);
    return {
      name: path.basename(file.path),
      createdAt: parseBackupTimestamp(path.basename(file.path)) ?? file.modifiedAt,
      bytes: paths.slice(0, 3).reduce((sum, item) => sum + (bytesByPath.get(item) ?? 0), 0)
        + contentFiles.reduce((sum, content) => sum + content.bytes, 0),
    };
  }, 1);
  return backups.sort((left, right) => right.createdAt - left.createdAt || right.name.localeCompare(left.name));
}

/** Re-enumerates managed names; callers cannot supply paths or remove the newest set. */
export function removeBackupSetByName(directory: string, name: string): RlmBackupPruneSummary {
  const backups = listBackupSets(directory);
  if (!backups.slice(1).some((backup) => backup.name === name)) {
    throw new Error('Backup is unknown or is the newest protected backup');
  }
  const summary = { deleted: 0, bytesFreed: 0, failed: 0 };
  removeBackupSet(path.join(directory, name), summary);
  return summary;
}

interface BackupSet {
  dbPath: string;
  sortTime: number;
}

/**
 * Prune older maintenance backups without ever affecting unrelated files.
 *
 * A backup set consists of its database, SQLite sidecars, and external-content
 * directory. Failures are isolated to the affected path so maintenance remains
 * successful after its newly-created backup has been verified.
 */
export function pruneOldBackups(directory: string, keepCount: number, onlyNames?: ReadonlySet<string>): RlmBackupPruneSummary {
  const summary: RlmBackupPruneSummary = { deleted: 0, bytesFreed: 0, failed: 0 };
  if (!fs.existsSync(directory)) return summary;

  let backups: BackupSet[];
  try {
    pruneStagedBackupSets(directory, summary, onlyNames);
    backups = fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && BACKUP_NAME.test(entry.name))
      .map((entry) => {
        const dbPath = path.join(directory, entry.name);
        const mtimeMs = fs.statSync(dbPath).mtimeMs;
        return { dbPath, sortTime: parseBackupTimestamp(entry.name) ?? mtimeMs };
      })
      .sort(compareBackupSets);
  } catch (error) {
    logger.warn('Failed to enumerate RLM maintenance backups', {
      directory,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ...summary, failed: 1 };
  }

  for (const backup of backups.slice(Math.max(0, keepCount))) {
    if (onlyNames && !onlyNames.has(path.basename(backup.dbPath))) continue;
    removeBackupSet(backup.dbPath, summary);
  }
  return summary;
}

function compareBackupSets(left: BackupSet, right: BackupSet): number {
  return right.sortTime - left.sortTime || path.basename(right.dbPath).localeCompare(path.basename(left.dbPath));
}

function backupSetPaths(dbPath: string): string[] {
  const stem = dbPath.slice(0, -'.db'.length);
  return [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${stem}_content`];
}

function removeBackupSet(dbPath: string, summary: RlmBackupPruneSummary): void {
  const paths = backupSetPaths(dbPath);
  const stagingDirectory = path.join(
    path.dirname(dbPath),
    `.rlm-backup-prune-${path.basename(dbPath)}-${process.pid}-${Date.now()}`,
  );
  const moved: { source: string; staged: string }[] = [];
  let stagedBytes = 0;

  try {
    fs.mkdirSync(stagingDirectory);
    for (const source of paths) {
      if (!fs.existsSync(source)) continue;
      const staged = path.join(stagingDirectory, path.basename(source));
      stagedBytes += sizeOf(source);
      fs.renameSync(source, staged);
      moved.push({ source, staged });
    }
  } catch (error) {
    summary.failed += 1;
    const restored = restoreMovedBackupPaths(moved);
    if (restored) removeEmptyStagingDirectory(stagingDirectory);
    logger.warn('Failed to stage old RLM maintenance backup for removal', {
      dbPath,
      restored,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  try {
    fs.rmSync(stagingDirectory, { recursive: true, force: false });
    summary.deleted += 1;
    summary.bytesFreed += stagedBytes;
  } catch (error) {
    summary.failed += 1;
    const restored = restoreMovedBackupPaths(moved);
    if (restored) removeEmptyStagingDirectory(stagingDirectory);
    logger.warn('Failed to remove staged old RLM maintenance backup set; inspect backup paths', {
      stagingDirectory,
      restored,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function pruneStagedBackupSets(directory: string, summary: RlmBackupPruneSummary, onlyNames?: ReadonlySet<string>): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const match = entry.name.match(STAGING_NAME);
    if (!entry.isDirectory() || !match || (onlyNames && !onlyNames.has(match[1]!))) continue;
    const stagingDirectory = path.join(directory, entry.name);
    const originalDbPath = path.join(directory, match[1]!);
    if (backupSetPaths(originalDbPath).some((backupPath) => fs.existsSync(backupPath))) {
      summary.failed += 1;
      logger.warn('Skipping incomplete staged RLM maintenance backup', { stagingDirectory });
      continue;
    }
    try {
      const bytes = sizeOf(stagingDirectory);
      fs.rmSync(stagingDirectory, { recursive: true, force: false });
      summary.deleted += 1;
      summary.bytesFreed += bytes;
    } catch (error) {
      summary.failed += 1;
      logger.warn('Failed to retry staged RLM maintenance backup removal', {
        stagingDirectory,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function restoreMovedBackupPaths(entries: { source: string; staged: string }[]): boolean {
  let restored = true;
  for (const entry of [...entries].reverse()) {
    if (!fs.existsSync(entry.staged)) {
      if (!fs.existsSync(entry.source)) restored = false;
      continue;
    }
    try {
      fs.renameSync(entry.staged, entry.source);
    } catch {
      restored = false;
    }
  }
  return restored;
}

function removeEmptyStagingDirectory(stagingDirectory: string): void {
  try {
    fs.rmdirSync(stagingDirectory);
  } catch {
    // The staged paths remain intact if a rollback could not be completed.
  }
}

function parseBackupTimestamp(name: string): number | null {
  const timestamp = name.match(TIMESTAMPED_BACKUP_NAME)?.[1];
  if (!timestamp) return null;
  const iso = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(9, 11)}:${timestamp.slice(11, 13)}:${timestamp.slice(13, 15)}.${timestamp.slice(15, 18)}Z`;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
}

function sizeOf(targetPath: string): number {
  const stat = fs.lstatSync(targetPath);
  if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(targetPath, { withFileTypes: true }).reduce(
    (total, entry) => total + sizeOf(path.join(targetPath, entry.name)),
    0,
  );
}
