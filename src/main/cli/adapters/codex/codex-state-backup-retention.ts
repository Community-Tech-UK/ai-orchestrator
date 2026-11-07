/** Keep-three selectors and pruning for the configured Codex backup policy. */
import { lstatSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger } from '../../../logging/logger';
import { getAioCodexStateDir } from './codex-home-manager';

const logger = getLogger('CodexStateBackupRetention');

/** How many automatic reconcile copies Harness keeps by itself. */
export const CODEX_AUTO_BACKUPS_KEEP = 3;
/** Tripwire: refuse to remove more than this in one prune (selector mistake). */
export const CODEX_AUTO_PRUNE_MAX = 5;

const STAMP = String.raw`\d{8}T\d{9}Z`;
const SUFFIX = String.raw`(?:-\d+)?`;
/** The automatic copies `codex-private-rollout-reconcile.ts` (`uniqueBackupPath`) writes before each reconcile. */
export const CODEX_RECONCILE_NAME = new RegExp(`^state_5-before-rollout-reconcile-${STAMP}${SUFFIX}\\.sqlite$`);
const CODEX_CLEANUP_NAME = /^state_5-before-aio-cleanup-.*\.sqlite$/;
const CODEX_ARCHIVE_NAME = /^state_5-before-aio-archive-.*\.sqlite$/;

const AGE_RE = new RegExp(`(${STAMP})(${SUFFIX})`);
function parts(name: string): { stamp: string; suffix: number } {
  const match = AGE_RE.exec(name);
  return { stamp: match?.[1] ?? '', suffix: match?.[2] ? Number(match[2].slice(1)) : 0 };
}

/** Oldest first: creation stamp, then the `-n` suffix after the plain name. */
function byAgeAscending(a: string, b: string): number {
  const left = parts(a);
  const right = parts(b);
  return left.stamp.localeCompare(right.stamp) || left.suffix - right.suffix;
}

/**
 * Older automatic reconcile copies beyond the newest `keep`, oldest first.
 * Only the exact reconcile name matches; clean-up and archive copies never do.
 */
export function selectAutoBackupsToPrune(names: readonly string[], keep = CODEX_AUTO_BACKUPS_KEEP): string[] {
  const auto = names.filter((name) => CODEX_RECONCILE_NAME.test(name)).sort(byAgeAscending);
  const keepCount = Math.max(0, keep);
  return auto.slice(0, Math.max(0, auto.length - keepCount));
}

export interface PruneAutoBackupOptions {
  keep?: number;
  maxRemove?: number;
  list?: (dir: string) => string[];
  remove?: (dir: string, name: string) => void;
}

/**
 * Remove older automatic copies beyond `keep`. Never throws. The tripwire
 * removes nothing when a selector mistake would take more than `maxRemove`.
 */
export function pruneAutoBackups(
  backupDir: string,
  options: PruneAutoBackupOptions = {},
): { selected: number; removed: number; failed: number } {
  const keep = options.keep ?? CODEX_AUTO_BACKUPS_KEEP;
  const maxRemove = options.maxRemove ?? CODEX_AUTO_PRUNE_MAX;
  const list = options.list ?? ((dir: string) => { try { return readdirSync(dir); } catch { return []; } });
  const remove = options.remove ?? ((dir: string, name: string) => { rmSync(join(dir, name), { force: true }); });
  let names: string[];
  try {
    names = list(backupDir);
  } catch (error) {
    logger.warn('Could not list automatic Codex safety copies', { error: error instanceof Error ? error.message : String(error) });
    return { selected: 0, removed: 0, failed: 0 };
  }
  const selected = selectAutoBackupsToPrune(names, keep);
  if (selected.length > maxRemove) {
    logger.info(`${selected.length} automatic Codex safety copies are waiting to be removed; leaving them`);
    return { selected: selected.length, removed: 0, failed: 0 };
  }
  let removed = 0;
  let failed = 0;
  for (const name of selected) {
    try {
      remove(backupDir, name);
      removed += 1;
    } catch (error) {
      failed += 1;
      logger.warn('Could not remove an automatic Codex safety copy', { error: error instanceof Error ? error.message : String(error) });
    }
  }
  if (selected.length > 0) logger.info('Pruned automatic Codex safety copies', { selected: selected.length, removed, failed });
  return { selected: selected.length, removed, failed };
}

/**
 * `VACUUM INTO` copies of ~/.codex/state_5.sqlite written before the leaked-
 * thread cleanup and rollout-path reconcile change it. Each is ~160 MB and
 * startup can write one per launch; with no pruning they reached 445 files
 * (41 GB) by October 2026. Clean-up and archive backups stay (the Storage
 * card promises they do), and so do links and non-regular files.
 */
const BACKUP_FILE_PATTERN = /^state_5-before-.+\.sqlite$/;

/** `state_5-before-*` copies the age-gated safety net may remove. */
function isPrunableStateBackup(name: string): boolean {
  return BACKUP_FILE_PATTERN.test(name) && !CODEX_CLEANUP_NAME.test(name) && !CODEX_ARCHIVE_NAME.test(name);
}

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

export interface CodexStateBackupPruneResult {
  removed: number;
  failed: number;
  bytesFreed: number;
}

/**
 * Delete pre-change Codex state backups beyond the newest few once they are a
 * week old. Never removes clean-up or archive backups (promised to stay) or
 * anything that is not a regular file. Never throws; reports the files removed
 * and the bytes freed so a run's accounting matches the filesystem delta.
 */
export function pruneCodexStateBackups(options: CodexStateBackupRetentionOptions = {}): CodexStateBackupPruneResult {
  const backupDir = options.backupDir ?? join(getAioCodexStateDir(), 'backups');
  const keep = options.keep ?? CODEX_STATE_BACKUPS_TO_KEEP;
  const minAgeMs = options.minAgeMs ?? CODEX_STATE_BACKUP_MIN_AGE_MS;
  const now = (options.now ?? Date.now)();

  let backups: { path: string; mtimeMs: number; size: number }[];
  try {
    const root = lstatSync(backupDir);
    if (!root.isDirectory() || root.isSymbolicLink()) return { removed: 0, failed: 0, bytesFreed: 0 };
    backups = readdirSync(backupDir)
      .filter((name) => isPrunableStateBackup(name))
      .flatMap((name) => {
        const fullPath = join(backupDir, name);
        try {
          const stat = lstatSync(fullPath);
          return stat.isFile() ? [{ path: fullPath, mtimeMs: stat.mtimeMs, size: stat.size }] : [];
        } catch {
          return [];
        }
      })
      .sort((left, right) => right.mtimeMs - left.mtimeMs);
  } catch {
    // No backups folder yet, or it is unreadable: nothing to prune.
    return { removed: 0, failed: 0, bytesFreed: 0 };
  }

  let removed = 0;
  let failed = 0;
  let bytesFreed = 0;
  for (const backup of backups.slice(keep)) {
    if (now - backup.mtimeMs < minAgeMs) continue;
    try {
      rmSync(backup.path, { force: true });
      removed++;
      bytesFreed += backup.size;
    } catch (error) {
      failed++;
      logger.warn('Could not remove old Codex state backup', {
        path: backup.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (removed > 0) {
    logger.info('Pruned old Codex state backups', { removed, failed, bytesFreed, kept: backups.length - removed });
  }
  return { removed, failed, bytesFreed };
}
