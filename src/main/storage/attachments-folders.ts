import { promises as fs } from 'fs';
import * as path from 'path';
import { getLogger } from '../logging/logger';
import { safeStorageDirectory, type StorageUnlinkState } from './storage-files';
import { captureAttachmentTree, MAX_ATTACHMENT_TREE_ENTRIES, removeAttachmentTree, validateAttachmentTree, type AttachmentTree } from './attachment-tree';
import type { StorageRemovalReceipt } from '../../shared/types/storage.types';

const logger = getLogger('AttachmentsFolders');

/** Session copies last changed this long ago are offered for clearing. */
export const ATTACHMENT_SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface AttachmentSessionCopy {
  path: string;
  bytes: number;
  /** Newest modification time among the session folder's files. */
  createdAt: number;
  /** Identity of the top-level copy, to reject a replacement at the same path. */
  inode: number;
  changedAt: number;
  /** Exact stable metadata inventory reviewed, absent for incomplete/legacy descriptors. */
  tree?: AttachmentTree;
}

export interface AttachmentCleanupOptions {
  now?: () => number;
  getProtectedIds?: () => ReadonlySet<string>;
}

export interface AttachmentFolderUsage {
  /** `<project>/.claude-attachments`. */
  path: string;
  /** Every byte under the folder, including fresh session copies. */
  bytes: number;
  totalSessions: number;
  /** Bounded reviewed batch of copies last changed more than 30 days ago. */
  clearable: AttachmentSessionCopy[];
}

/**
 * Every `.claude-attachments` folder under the given project roots, with its
 * session-copy counts and the copies that are old enough to clear. Best effort
 * per root: a folder that cannot be read is skipped, never fatal.
 */
export async function listAttachmentFolders(
  projectRoots: readonly string[],
  now: number,
  getProtectedIds: () => ReadonlySet<string> = () => new Set(),
): Promise<AttachmentFolderUsage[]> {
  const results: AttachmentFolderUsage[] = [];
  let reviewedEntries = 0;
  for (const root of projectRoots) {
    const folder = path.join(root, '.claude-attachments');
    let stat;
    try {
      if (!await safeStorageDirectory(folder)) continue;
      stat = await fs.lstat(folder);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    let entries;
    try {
      entries = await fs.readdir(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    const budget = { entries: MAX_ATTACHMENT_TREE_ENTRIES };
    const clearable: AttachmentSessionCopy[] = [];
    let bytes = 0;
    let totalSessions = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isFile()) continue;
      const sessionPath = path.join(folder, entry.name);
      let sessionStat;
      try {
        sessionStat = await fs.lstat(sessionPath);
      } catch {
        continue;
      }
      if (sessionStat.isSymbolicLink()) continue;
      totalSessions += 1;
      const walked = await captureAttachmentTree(sessionPath, budget);
      bytes += walked.bytes;
      if (walked.tree && !getProtectedIds().has(entry.name)
        && walked.newestModified < now - ATTACHMENT_SESSION_MAX_AGE_MS
        && walked.tree.entries.length <= MAX_ATTACHMENT_TREE_ENTRIES - reviewedEntries) {
        // Keep usage scans per project, but bound retained authority across all projects.
        // After this batch is cleared, a new review can offer the remaining copies.
        reviewedEntries += walked.tree.entries.length;
        clearable.push({ path: sessionPath, bytes: walked.bytes, createdAt: walked.newestModified,
          inode: sessionStat.ino, changedAt: sessionStat.ctimeMs, tree: walked.tree });
      }
    }
    results.push({ path: folder, bytes, totalSessions, clearable });
  }
  return results;
}

/**
 * Remove the listed session copies. Each target must still be a real directory
 * or file (not a link) under its `.claude-attachments` folder when removal
 * runs; skipped copies contribute neither a removal nor freed bytes.
 */
export async function removeAttachmentSessions(
  sessions: readonly AttachmentSessionCopy[], options: AttachmentCleanupOptions = {},
): Promise<StorageRemovalReceipt> {
  const now = options.now ?? Date.now;
  const protectedIds = options.getProtectedIds ?? (() => new Set<string>());
  let removed = 0;
  let bytesFreed = 0;
  const state: StorageUnlinkState = new Map();
  const seen = new Set<string>();
  // Snapshot caller-owned authority; never replace it with a newly walked inventory.
  const reviewed = structuredClone(sessions);
  const eligible = reviewed.filter(session => {
    if (path.basename(path.dirname(session.path)) !== '.claude-attachments') {
      throw new Error('The file location changed. Review again.');
    }
    if (seen.has(session.path)) return false;
    seen.add(session.path);
    const tree = session.tree;
    const root = tree?.entries.find(entry => entry.path === session.path);
    const files = tree?.entries.filter(entry => entry.kind === 'file') ?? [];
    return !!tree && tree.parent.path === path.dirname(session.path) && !!root
      && root.inode === session.inode && root.changedAt === session.changedAt
      && files.reduce((sum, file) => sum + file.bytes, 0) === session.bytes
      && files.reduce((newest, file) => Math.max(newest, file.modifiedAt), 0) === session.createdAt
      && session.createdAt < now() - ATTACHMENT_SESSION_MAX_AGE_MS
      && !protectedIds().has(path.basename(session.path)) && validateAttachmentTree(tree, state);
  });
  // Preflight every selected folder before our own unlinks alter shared inode ctime/nlink.
  for (const session of eligible) {
    const result = removeAttachmentTree(session.tree!, state,
      () => protectedIds().has(path.basename(session.path)) || session.createdAt >= now() - ATTACHMENT_SESSION_MAX_AGE_MS);
    if (!result) continue;
    removed += result.removed;
    bytesFreed += result.bytesFreed;
    logger.info('Removed old pasted-attachment session copy', { path: session.path, bytes: result.bytesFreed });
  }
  return { removed, bytesFreed };
}
