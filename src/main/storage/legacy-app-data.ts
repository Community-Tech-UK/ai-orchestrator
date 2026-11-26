import { promises as fs, type Stats } from 'fs';
import { createHash } from 'node:crypto';
import { safeStorageDirectory } from './storage-files';
import * as path from 'path';
import { getLogger } from '../logging/logger';

const logger = getLogger('LegacyAppData');

/** Old app-data folder names from before the Harness renames. */
export const LEGACY_APP_DATA_NAMES = ['claude-orchestrator'] as const;

/** Walk cap so a runaway folder cannot stall the disk-space scan. */
const MAX_WALKED_FILES = 50_000;

export interface LegacyAppDataInfo {
  path: string;
  name: string;
  bytes: number;
  files: number;
  newestModified: number;
  /** Metadata generation of the directory and every entry; no content reads. */
  generation: string;
}

/**
 * The old pre-rename data folder, when it is a direct child of the app-data
 * directory and is not the live user-data folder. Link-safe: a linked folder
 * is ignored, and the size walk never follows links.
 */
export async function listLegacyAppData(
  appDataPath: string,
  currentUserData: string,
): Promise<LegacyAppDataInfo | null> {
  for (const name of LEGACY_APP_DATA_NAMES) {
    const candidate = path.join(appDataPath, name);
    if (path.resolve(candidate) === path.resolve(currentUserData)) continue;
    let stat;
    try {
      stat = await fs.lstat(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error('The old data folder could not be fully checked. Review again.', { cause: error });
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    const walk = await walkSize(candidate);
    return { path: candidate, name, ...walk };
  }
  return null;
}

function metadata(stat: Stats): string {
  return JSON.stringify([stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink]);
}

async function walkSize(root: string): Promise<Pick<LegacyAppDataInfo, 'bytes' | 'files' | 'newestModified' | 'generation'>> {
  let bytes = 0;
  let files = 0;
  let newestModified = 0;
  const digest = createHash('sha256');
  const observed = new Map<string, string>();
  const queue = [root];
  try {
    if (!await safeStorageDirectory(root)) throw new Error('Unsafe directory');
    observed.set(root, metadata(await fs.lstat(root)));
    while (queue.length > 0) {
      const directory = queue.pop()!;
      if (!await safeStorageDirectory(directory)) throw new Error('Unsafe directory');
      const entries = await fs.readdir(directory, { withFileTypes: true });
      // Count every entry, including empty directories and links, against the cap.
      if (observed.size + entries.length > MAX_WALKED_FILES) throw new Error('Scan limit reached');
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const entryPath = path.join(directory, entry.name);
        const stat = await fs.lstat(entryPath);
        observed.set(entryPath, metadata(stat));
        if (stat.isDirectory() && !stat.isSymbolicLink()) queue.push(entryPath);
        else if (stat.isFile()) {
          bytes += stat.size;
          files++;
          newestModified = Math.max(newestModified, stat.mtimeMs);
        } else if (!stat.isSymbolicLink()) throw new Error('Unsupported entry');
      }
    }
    // Refuse scans that changed while being measured, including nested writes.
    for (const [entryPath, before] of [...observed].sort(([a], [b]) => a.localeCompare(b))) {
      if (metadata(await fs.lstat(entryPath)) !== before) throw new Error('Directory changed during scan');
      digest.update(JSON.stringify([path.relative(root, entryPath), before]));
    }
    return { bytes, files, newestModified, generation: digest.digest('hex') };
  } catch (error) {
    throw new Error('The old data folder could not be fully checked. Review again.', { cause: error });
  }
}

/**
 * Move the old folder to the Bin through the supplied trash function (the
 * runtime binds Electron's `shell.trashItem`). No `rm` fallback: when the move
 * fails the folder is left in place and the error is reported.
 */
export async function trashLegacyAppData(
  target: LegacyAppDataInfo,
  trashItem: (targetPath: string) => Promise<void>,
): Promise<void> {
  if (!LEGACY_APP_DATA_NAMES.some(name => name === path.basename(target.path)) || !target.generation) {
    throw new Error('The old data folder changed. Review again.');
  }
  const current = await listLegacyAppData(path.dirname(target.path), '');
  if (!current || current.path !== target.path || current.generation !== target.generation
    || current.bytes !== target.bytes || current.files !== target.files || current.newestModified !== target.newestModified) {
    throw new Error('The old data folder changed. Review again.');
  }
  await trashItem(target.path);
  logger.info('Moved legacy app data folder to the Bin', {
    path: target.path,
    bytes: target.bytes,
    files: target.files,
  });
}
