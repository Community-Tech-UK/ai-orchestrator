import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { SettingsMigrationStore } from '../../../core/config/settings-migrations';
import { getLogger } from '../../../logging/logger';
import { getAioCodexStateDir } from './codex-home-manager';
import { CODEX_RECONCILE_NAME, pruneAutoBackups, pruneCodexStateBackups } from './codex-state-backup-retention';

const logger = getLogger('CodexBackupRetentionPolicy');
const MIGRATION_KEY = '__migration_codex_backup_keep_three_20261020';
const backupDirectory = () => join(getAioCodexStateDir(), 'backups');

/** One startup run's backup removals: what was picked, removed, failed and freed. */
export interface CodexBackupPruneResult {
  selected: number;
  removed: number;
  failed: number;
  bytesFreed: number;
}

function hasLegacyBacklog(): boolean {
  try { return readdirSync(backupDirectory()).filter(name => CODEX_RECONCILE_NAME.test(name)).length > 3; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error; // Do not mark an unreadable migration complete.
  }
}

/** Decision 19(a): upgrade the existing automatic-copy backlog, keep fresh installs off. */
export function migrateCodexBackupRetention(store: SettingsMigrationStore, existingBacklog = hasLegacyBacklog): void {
  if (store.get(MIGRATION_KEY) === true) return;
  let backlog: boolean;
  try {
    backlog = existingBacklog();
  } catch (error) {
    logger.warn('Could not inspect Codex backups; retention migration will retry on next startup', { error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (backlog) store.persistSetting('codexBackupKeepThree', true);
  store.persistRawSetting(MIGRATION_KEY, true);
}

export function pruneConfiguredCodexBackups(enabled: boolean, directory = backupDirectory()): CodexBackupPruneResult {
  let bytesFreed = 0;
  if (!enabled) return { selected: 0, removed: 0, failed: 0, bytesFreed };
  try {
    const root = lstatSync(directory);
    if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Backup directory is not a regular directory');
    const result = pruneAutoBackups(directory, {
      // The authorised first upgrade contains 443 copies. Keep a bounded tripwire.
      maxRemove: 5000,
      list: dir => readdirSync(dir).filter(name => {
        try { return lstatSync(join(dir, name)).isFile(); } catch { return false; }
      }),
      remove: (dir, name) => {
        const file = join(dir, name);
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Backup is not a regular file');
        unlinkSync(file);
        bytesFreed += stat.size;
      },
    });
    logger.info('Codex backup keep-3 run', { ...result, bytesFreed });
    return { ...result, bytesFreed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') logger.warn('Could not prune Codex backups', { error: error instanceof Error ? error.message : String(error) });
    return { selected: 0, removed: 0, failed: 0, bytesFreed };
  }
}

/**
 * Startup pruning policy: exactly one pruner deletes per run, so the
 * `Codex backup keep-3 run` entry's removed/bytesFreed equal the run's whole
 * filesystem delta (the installed livetest checks that entry against a
 * before/after observation). The configured keep-3 policy, when on, supersedes
 * the older keep-5/week-age safety net: it is stricter for every recognised
 * reconcile copy that net manages, so running both would only add deletions the
 * keep-3 entry cannot account for. Unrecognised `state_5-before-*` names age
 * out only while the setting is off, which is the conservative direction (the
 * prune tripwires prefer leaving an unknown file over removing it wrongly).
 * Clean-up and archive backups and links stay either way.
 */
export function pruneCodexBackupsAtStartup(
  keepThree: boolean,
  directory = backupDirectory(),
): CodexBackupPruneResult {
  if (keepThree) return pruneConfiguredCodexBackups(true, directory);
  const { removed, failed, bytesFreed } = pruneCodexStateBackups({ backupDir: directory });
  return { selected: removed + failed, removed, failed, bytesFreed };
}
