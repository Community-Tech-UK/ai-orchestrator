import fs from 'node:fs/promises';
import path from 'node:path';
import { getLogger } from '../logging/logger';
import { SecurityFilter } from '../remote-node/security-filter';
import type { FsEntry } from '../../shared/types/remote-fs.types';

const logger = getLogger('FilesystemDirectoryReader');

export async function readFilesystemDirectoryTree(
  dirPath: string,
  depth: number,
  includeHidden: boolean,
): Promise<FsEntry[]> {
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    logger.warn('Failed to read directory', { dirPath, err: String(err) });
    return [];
  }

  const visible = includeHidden
    ? dirents
    : dirents.filter((dirent) => !dirent.name.startsWith('.'));

  const entries: FsEntry[] = [];

  for (const dirent of visible) {
    const fullPath = path.join(dirPath, dirent.name);
    const isDirectory = dirent.isDirectory();
    const ignored = isDirectory && SecurityFilter.shouldSkipDirectory(dirent.name);
    const restricted = SecurityFilter.isRestricted(dirent.name);

    let size = 0;
    let modifiedAt = 0;
    try {
      const stat = await fs.stat(fullPath);
      size = stat.size;
      modifiedAt = stat.mtimeMs;
    } catch {
      // Stat failure is non-fatal; keep default metadata.
    }

    const entry: FsEntry = {
      name: dirent.name,
      path: fullPath,
      isDirectory,
      isSymlink: dirent.isSymbolicLink(),
      size,
      modifiedAt,
      extension: isDirectory ? undefined : path.extname(dirent.name) || undefined,
      ignored,
      restricted,
    };

    if (isDirectory && !ignored && depth > 1) {
      entry.children = await readFilesystemDirectoryTree(fullPath, depth - 1, includeHidden);
    }

    entries.push(entry);
  }

  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}
