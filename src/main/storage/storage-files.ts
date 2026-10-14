import { promises as fs } from 'fs';
import * as path from 'path';

export interface StorageFile {
  path: string;
  bytes: number;
  modifiedAt: number;
  changedAt: number;
  inode: number;
  instanceId?: string;
}

export async function mapStorageFiles<T, R>(items: readonly T[], fn: (item: T) => Promise<R>, concurrency = 8): Promise<R[]> {
  const results = new Array<R>(items.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) { const current = index++; results[current] = await fn(items[current]); }
  }));
  return results;
}

/** No links are followed, including links in any root ancestor. Missing stores are empty. */
export async function safeStorageDirectory(directory: string): Promise<boolean> {
  try {
    const resolved = path.resolve(directory);
    const stat = await fs.lstat(resolved);
    return stat.isDirectory() && !stat.isSymbolicLink() && await fs.realpath(resolved) === resolved;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export async function listStorageFiles(directory: string, recursive = true): Promise<StorageFile[]> {
  if (!await safeStorageDirectory(directory)) return [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const batches = await mapStorageFiles(entries, async (entry): Promise<StorageFile[]> => {
    const filePath = path.join(directory, entry.name);
    const stat = await fs.lstat(filePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat || stat.isSymbolicLink()) return [];
    if (stat.isDirectory()) return recursive ? listStorageFiles(filePath) : [];
    if (!stat.isFile()) return [];
    return [{ path: filePath, bytes: stat.size, modifiedAt: stat.mtimeMs, changedAt: stat.ctimeMs, inode: stat.ino }];
  }, 1); // One directory at a time; stat concurrency is globally bounded below.
  return batches.flat().sort((a, b) => a.path.localeCompare(b.path));
}

export async function removeStorageFiles(files: readonly StorageFile[], allowedRoots: readonly string[], getLiveIds: () => ReadonlySet<string>): Promise<number> {
  let removed = 0;
  for (const file of files) {
    if (file.instanceId && getLiveIds().has(file.instanceId)) throw new Error('A session is now in use. Review again.');
    const root = allowedRoots.find(candidate => {
      const relative = path.relative(candidate, file.path);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
    if (!root || !await safeStorageDirectory(root) || !await safeStorageDirectory(path.dirname(file.path))) throw new Error('The file location changed. Review again.');
    const stat = await fs.lstat(file.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== file.bytes || stat.mtimeMs !== file.modifiedAt || stat.ctimeMs !== file.changedAt || stat.ino !== file.inode) throw new Error('The list changed since you looked. Review again.');
    await fs.unlink(file.path);
    removed++;
  }
  return removed;
}
