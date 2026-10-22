import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../../../logging/logger';
import { getAioCodexStateDir } from './codex-home-manager';

const logger = getLogger('CodexStateBackupRetention');

/**
 * `VACUUM INTO` copies of ~/.codex/state_5.sqlite written before the leaked-
 * thread cleanup and rollout-path reconcile change it. Each is ~160 MB and
 * startup can write one per launch; with no pruning they reached 445 files
 * (41 GB) by October 2026.
 */
const BACKUP_FILE_PATTERN = /^state_5-before-.+\.sqlite$/;

/** Always keep this many of the newest backups, whatever their age. */
export const CODEX_STATE_BACKUPS_TO_KEEP = 5;
/** Older backups are removed only once they are at least this old. */
export const CODEX_STATE_BACKUP_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface CodexStateBackupRetentionOptions {
  backupDir?: string;
  keep?: number;
  minAgeMs?: number;
  now?: () => number;
}

/**
 * Delete Codex state backups beyond the newest few once they are a week old.
 * Returns the number of files removed. Never throws.
 */
export function pruneCodexStateBackups(options: CodexStateBackupRetentionOptions = {}): number {
  const backupDir = options.backupDir ?? join(getAioCodexStateDir(), 'backups');
  const keep = options.keep ?? CODEX_STATE_BACKUPS_TO_KEEP;
  const minAgeMs = options.minAgeMs ?? CODEX_STATE_BACKUP_MIN_AGE_MS;
  const now = (options.now ?? Date.now)();

  let backups: { path: string; mtimeMs: number }[];
  try {
    backups = readdirSync(backupDir)
      .filter((name) => BACKUP_FILE_PATTERN.test(name))
      .flatMap((name) => {
        const fullPath = join(backupDir, name);
        try {
          const stat = statSync(fullPath);
          return stat.isFile() ? [{ path: fullPath, mtimeMs: stat.mtimeMs }] : [];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
  } catch {
    // No backups folder yet, or it is unreadable: nothing to prune.
    return 0;
  }

  let removed = 0;
  for (const backup of backups.slice(keep)) {
    if (now - backup.mtimeMs < minAgeMs) continue;
    try {
      rmSync(backup.path, { force: true });
      removed++;
    } catch (error) {
      logger.warn('Could not remove old Codex state backup', {
        path: backup.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (removed > 0) {
    logger.info('Pruned old Codex state backups', { removed, kept: backups.length - removed });
  }
  return removed;
}
