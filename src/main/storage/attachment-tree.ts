import { promises as fs, lstatSync, realpathSync, readdirSync, rmdirSync, type Stats } from 'fs';
import * as path from 'path';
import { safeStorageDirectory, storageFileFromStat, unlinkStorageFile, type StorageFile, type StorageUnlinkState } from './storage-files';
import type { StorageRemovalReceipt } from '../../shared/types/storage.types';

/** Count directories as well as files, so wide empty trees cannot escape the cap. */
export const MAX_ATTACHMENT_TREE_ENTRIES = 50_000;
interface TreeEntry extends StorageFile {
  kind: 'file' | 'directory';
  mode: number;
}
export interface AttachmentTree {
  parent: { path: string; inode: number; device: number; mode: number };
  entries: TreeEntry[];
}

function entryFromStat(entryPath: string, stat: Stats): TreeEntry {
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Unsupported attachment entry');
  return { ...storageFileFromStat(entryPath, stat), kind: stat.isDirectory() ? 'directory' : 'file', mode: stat.mode };
}
function sameEntry(a: TreeEntry, b: TreeEntry): boolean {
  return a.path === b.path && a.kind === b.kind && a.mode === b.mode && a.bytes === b.bytes
    && a.modifiedAt === b.modifiedAt && a.changedAt === b.changedAt && a.inode === b.inode
    && a.device === b.device && a.links === b.links;
}

/** Metadata only. The second pass refuses generations that moved during discovery. */
export async function captureAttachmentTree(root: string, budget: { entries: number }): Promise<{
  bytes: number; newestModified: number; tree?: AttachmentTree;
}> {
  let bytes = 0;
  let newestModified = 0;
  const entries: TreeEntry[] = [];
  try {
    const parentPath = path.dirname(root);
    if (!await safeStorageDirectory(parentPath)) throw new Error('Unsafe attachment parent');
    const parentStat = await fs.lstat(parentPath);
    const parent = { path: parentPath, inode: parentStat.ino, device: parentStat.dev, mode: parentStat.mode };
    const queue = [root];
    while (queue.length) {
      const entryPath = queue.pop()!;
      if (--budget.entries < 0) throw new Error('Attachment scan limit reached');
      const entry = entryFromStat(entryPath, await fs.lstat(entryPath));
      entries.push(entry);
      if (entry.kind === 'directory') {
        if (!await safeStorageDirectory(entryPath)) throw new Error('Unsafe attachment directory');
        const names = await fs.readdir(entryPath);
        if (names.length > budget.entries) throw new Error('Attachment scan limit reached');
        queue.push(...names.sort().reverse().map(name => path.join(entryPath, name)));
      } else {
        bytes += entry.bytes;
        newestModified = Math.max(newestModified, entry.modifiedAt);
      }
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    for (const entry of entries) {
      if (!sameEntry(entry, entryFromStat(entry.path, await fs.lstat(entry.path)))) throw new Error('Unstable attachment generation');
    }
    const tree = { parent, entries };
    // Also recheck directory membership and ancestor identity after the async walk.
    if (!validateAttachmentTree(tree, new Map())) throw new Error('Unstable attachment generation');
    return { bytes, newestModified, tree };
  } catch {
    // An incomplete measurement is useful for usage, but never grants deletion authority.
    return { bytes, newestModified };
  }
}

function safeDirectory(directory: string): boolean {
  const stat = lstatSync(directory);
  return stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(directory) === directory;
}
function parentMatches(tree: AttachmentTree): boolean {
  const stat = lstatSync(tree.parent.path);
  return safeDirectory(tree.parent.path) && stat.ino === tree.parent.inode
    && stat.dev === tree.parent.device && stat.mode === tree.parent.mode;
}
function expectedEntry(entry: TreeEntry, state: StorageUnlinkState): TreeEntry {
  if (entry.kind !== 'file') return entry;
  const transition = state.get(`${entry.device}:${entry.inode}`);
  if (!transition) return entry;
  const reviewed = transition.reviewed;
  if (entry.bytes !== reviewed.bytes || entry.modifiedAt !== reviewed.modifiedAt
    || entry.changedAt !== reviewed.changedAt || entry.device !== reviewed.device
    || entry.links !== reviewed.links || entry.inode !== reviewed.inode) return entry;
  return { ...entry, ...storageFileFromStat(entry.path, transition.current) };
}
/** Compare only with retained authority; discovered paths never become approved. */
export function validateAttachmentTree(tree: AttachmentTree, state: StorageUnlinkState): boolean {
  try {
    if (!tree.entries.length || tree.entries.length > MAX_ATTACHMENT_TREE_ENTRIES || !parentMatches(tree)) return false;
    const root = tree.entries.find(entry => path.dirname(entry.path) === tree.parent.path);
    if (!root || path.basename(tree.parent.path) !== '.claude-attachments') return false;
    const paths = new Set<string>();
    const childNames = new Map<string, string[]>();
    for (const entry of tree.entries) {
      const relative = path.relative(root.path, entry.path);
      if (paths.has(entry.path) || path.resolve(entry.path) !== entry.path
        || relative.startsWith('..') || path.isAbsolute(relative)) return false;
      paths.add(entry.path);
      const parent = path.dirname(entry.path);
      const names = childNames.get(parent) ?? [];
      names.push(path.basename(entry.path)); childNames.set(parent, names);
    }
    for (const entry of tree.entries) {
      if (!sameEntry(expectedEntry(entry, state), entryFromStat(entry.path, lstatSync(entry.path)))) return false;
      if (entry.kind === 'directory' && (!safeDirectory(entry.path)
        || JSON.stringify(readdirSync(entry.path).sort()) !== JSON.stringify((childNames.get(entry.path) ?? []).sort()))) return false;
    }
    return true;
  } catch { return false; }
}

/** No await between the final tree check and the bounded, nonrecursive unlinks. */
export function removeAttachmentTree(
  tree: AttachmentTree, state: StorageUnlinkState, isProtected: () => boolean,
): StorageRemovalReceipt | null {
  if (isProtected() || !validateAttachmentTree(tree, state)) return null;
  const directories = new Map(tree.entries.filter(entry => entry.kind === 'directory').map(entry => [entry.path, entry]));
  const locationMatches = (entryPath: string): boolean => {
    if (isProtected() || !parentMatches(tree)) return false;
    let directory = path.dirname(entryPath);
    while (directory !== tree.parent.path) {
      const expected = directories.get(directory);
      if (!expected || !safeDirectory(directory) || !sameEntry(expected, entryFromStat(directory, lstatSync(directory)))) return false;
      directory = path.dirname(directory);
    }
    return true;
  };
  const recordRemoval = (entry: TreeEntry): void => {
    const parent = path.dirname(entry.path);
    const before = directories.get(parent);
    if (!before) return;
    const after = entryFromStat(parent, lstatSync(parent));
    // Directory nlink counts files on APFS, but only subdirectories on POSIX.
    // File-inode transitions remain exact in unlinkStorageFile.
    const linkDelta = before.links! - after.links!;
    if (after.inode !== before.inode || after.device !== before.device || after.mode !== before.mode
      || (linkDelta !== 0 && linkDelta !== 1) || !safeDirectory(parent)) {
      throw new Error('The attachment folder changed. Review again.');
    }
    directories.set(parent, after);
  };
  let bytesFreed = 0;
  for (const entry of tree.entries.filter(entry => entry.kind === 'file')) {
    if (!locationMatches(entry.path)) throw new Error('The attachment folder changed. Review again.');
    const receipt = unlinkStorageFile(entry, state);
    if (!receipt.removed) throw new Error('The attachment file changed. Review again.');
    bytesFreed += receipt.bytesFreed;
    recordRemoval(entry);
  }
  for (const entry of [...directories.values()].sort((a, b) => b.path.length - a.path.length)) {
    const expected = directories.get(entry.path)!;
    if (!locationMatches(entry.path) || !safeDirectory(entry.path)
      || !sameEntry(expected, entryFromStat(entry.path, lstatSync(entry.path)))) throw new Error('The attachment folder changed. Review again.');
    rmdirSync(entry.path);
    recordRemoval(entry);
  }
  return { removed: 1, bytesFreed };
}
