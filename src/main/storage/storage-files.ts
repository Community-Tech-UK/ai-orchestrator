import { promises as fs, constants, openSync, closeSync, fstatSync, lstatSync, unlinkSync, type Stats } from 'fs';
import * as path from 'path';
import type { StorageRemovalReceipt } from '../../shared/types/storage.types';

export interface StorageFile {
  path: string;
  bytes: number;
  modifiedAt: number;
  changedAt: number;
  inode: number;
  device?: number;
  links?: number;
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
    return [{ path: filePath, bytes: stat.size, modifiedAt: stat.mtimeMs, changedAt: stat.ctimeMs, inode: stat.ino, device: stat.dev, links: stat.nlink }];
  }, 1); // One directory at a time; stat concurrency is globally bounded below.
  return batches.flat().sort((a, b) => a.path.localeCompare(b.path));
}

/** Per-run transitions caused by our own unlink, never a waiver for external writes. */
export type StorageUnlinkState = Map<string, { reviewed: StorageFile; current: Stats }>;

function matchesFile(stat: Stats, file: StorageFile): boolean {
  return stat.isFile() && stat.ino === file.inode && stat.size === file.bytes
    && stat.mtimeMs === file.modifiedAt && stat.ctimeMs === file.changedAt
    && (file.device === undefined || stat.dev === file.device)
    && (file.links === undefined || stat.nlink === file.links);
}

export function storageFileFromStat(filePath: string, stat: Stats): StorageFile {
  return { path: filePath, bytes: stat.size, modifiedAt: stat.mtimeMs,
    changedAt: stat.ctimeMs, inode: stat.ino, device: stat.dev, links: stat.nlink };
}

/**
 * Pin the reviewed inode while unlinking. fstat after unlink tells whether any
 * names still retain its content. No content is read; the handle is always closed.
 * The identity check and unlink share a synchronous turn, like Codex cleanup.
 */
export function unlinkStorageFile(file: StorageFile, state: StorageUnlinkState = new Map()): StorageRemovalReceipt {
  let descriptor: number | undefined;
  try {
    const stat = lstatSync(file.path);
    const key = `${stat.dev}:${stat.ino}`;
    const previous = state.get(key);
    const reviewed = previous?.reviewed;
    if (reviewed && (file.inode !== reviewed.inode || file.bytes !== reviewed.bytes
      || file.modifiedAt !== reviewed.modifiedAt || file.changedAt !== reviewed.changedAt
      || file.device !== reviewed.device || file.links !== reviewed.links)) return { removed: 0, bytesFreed: 0 };
    const expected = previous ? storageFileFromStat(file.path, previous.current) : file;
    if (!matchesFile(stat, expected)) return { removed: 0, bytesFreed: 0 };
    descriptor = openSync(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    if (!matchesFile(fstatSync(descriptor), storageFileFromStat(file.path, stat))) return { removed: 0, bytesFreed: 0 };
    unlinkSync(file.path);
    const after = fstatSync(descriptor);
    // Continue across selected hard links only after the precise expected transition.
    if (after.size === stat.size && after.mtimeMs === stat.mtimeMs && after.nlink === stat.nlink - 1) {
      state.set(key, { reviewed: reviewed ?? file, current: after });
    } else state.delete(key);
    return { removed: 1, bytesFreed: after.nlink === 0 ? after.size : 0 };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { removed: 0, bytesFreed: 0 };
    throw error;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

export async function removeStorageFilesWithReceipt(files: readonly StorageFile[], allowedRoots: readonly string[], getLiveIds: () => ReadonlySet<string>, state: StorageUnlinkState = new Map()): Promise<StorageRemovalReceipt> {
  let removed = 0;
  let bytesFreed = 0;
  for (const file of files) {
    if (file.instanceId && getLiveIds().has(file.instanceId)) throw new Error('A session is now in use. Review again.');
    const root = allowedRoots.find(candidate => {
      const relative = path.relative(candidate, file.path);
      return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
    });
    if (!root || !await safeStorageDirectory(root) || !await safeStorageDirectory(path.dirname(file.path))) throw new Error('The file location changed. Review again.');
    const receipt = unlinkStorageFile(file, state);
    if (!receipt.removed) throw new Error('The list changed since you looked. Review again.');
    removed += receipt.removed;
    bytesFreed += receipt.bytesFreed;
  }
  return { removed, bytesFreed };
}

/** Count-only API retained for the session retention callers. */
export async function removeStorageFiles(files: readonly StorageFile[], allowedRoots: readonly string[], getLiveIds: () => ReadonlySet<string>): Promise<number> {
  return (await removeStorageFilesWithReceipt(files, allowedRoots, getLiveIds)).removed;
}
