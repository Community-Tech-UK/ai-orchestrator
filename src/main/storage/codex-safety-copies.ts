import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import {
  selectOldCopiesForCard,
  selectOtherCopiesForCard,
  CODEX_RECONCILE_NAME,
} from '../cli/adapters/codex/codex-state-backup-retention';
import type { StorageCleanupItem } from '../../shared/types/storage.types';

export interface CodexSafetyCopy {
  name: string;
  bytes: number;
  createdAt: number;
  group: 'old-reconcile' | 'other';
  /** No content reads: even very large backups are bound by regular-file identity. */
  identity: { device: number; inode: number; changedAt: number; links: number };
}

export interface CodexStateOverview {
  backupBytes: number;
  backupCount: number;
  /** Card-eligible copies only: old reconcile copies beyond the newest 3, plus clean-up and archive copies. */
  copies: CodexSafetyCopy[];
  sessionsBytes: number;
}

function folderBytes(dir: string): { bytes: number; count: number } {
  let bytes = 0;
  let count = 0;
  const pending = [dir];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let names: string[];
    try { names = readdirSync(directory); } catch { continue; }
    for (const name of names) {
      const target = join(directory, name);
      try {
        const stat = lstatSync(target);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) pending.push(target);
        else if (stat.isFile()) { bytes += stat.size; count += 1; }
      } catch { /* vanished between listing and stat */ }
    }
  }
  return { bytes, count };
}

function copyInfo(dir: string, name: string, group: CodexSafetyCopy['group']): CodexSafetyCopy | null {
  try {
    const stat = lstatSync(join(dir, name));
    if (!stat.isFile()) return null;
    return { name, bytes: stat.size, createdAt: stat.mtimeMs, group,
      identity: { device: stat.dev, inode: stat.ino, changedAt: stat.ctimeMs, links: stat.nlink } };
  } catch {
    return null;
  }
}

/** Read-only overview of `<codex state dir>/backups` and `sessions` for the disk-space card. */
export function listCodexStateOverview(backupDir: string, sessionsDir: string): CodexStateOverview {
  let names: string[];
  try { names = lstatSync(backupDir).isDirectory() ? readdirSync(backupDir) : []; } catch { names = []; }
  const oldCopies = selectOldCopiesForCard(names)
    .map((name) => copyInfo(backupDir, name, 'old-reconcile'))
    .filter((copy): copy is CodexSafetyCopy => copy !== null);
  const otherCopies = selectOtherCopiesForCard(names)
    .map((name) => copyInfo(backupDir, name, 'other'))
    .filter((copy): copy is CodexSafetyCopy => copy !== null);
  const backups = folderBytes(backupDir);
  return {
    backupBytes: backups.bytes,
    backupCount: backups.count,
    copies: [...oldCopies, ...otherCopies],
    sessionsBytes: folderBytes(sessionsDir).bytes,
  };
}

export function codexCopyItems(copies: readonly CodexSafetyCopy[]): StorageCleanupItem[] {
  return copies.map((copy) => ({ name: copy.name, bytes: copy.bytes, createdAt: copy.createdAt, group: copy.group }));
}

/**
 * Remove exactly the reviewed regular files. Recheck identity immediately before
 * unlinking, without an async gap. Refuses names alone and any name the card
 * selectors would not pick (including automatic new-name copies and the newest
 * 3 old reconcile copies) and any name that would leave the backups folder.
 */
export function removeCodexSafetyCopies(backupDir: string, copies: readonly CodexSafetyCopy[]): { removed: number; bytesFreed: number; failed: number } {
  let removable: string[];
  try {
    const existing = lstatSync(backupDir).isDirectory() ? readdirSync(backupDir) : [];
    removable = [...selectOldCopiesForCard(existing), ...selectOtherCopiesForCard(existing)];
  } catch { return { removed: 0, bytesFreed: 0, failed: copies.length }; }
  const allowed = new Set(removable);
  const root = resolve(backupDir);
  let removed = 0;
  let bytesFreed = 0;
  let failed = 0;
  for (const copy of copies) {
    if (!copy || typeof copy !== 'object' || !copy.identity) { failed += 1; continue; }
    const { name } = copy;
    if (!allowed.has(name) || name.includes('/') || name.includes('\\') || name.includes(sep) || isAbsolute(name)) {
      failed += 1;
      continue;
    }
    const target = resolve(join(root, name));
    if (!target.startsWith(root + sep)) { failed += 1; continue; }
    try {
      const stat = lstatSync(target);
      if (!stat.isFile() || stat.dev !== copy.identity.device || stat.ino !== copy.identity.inode
        || stat.ctimeMs !== copy.identity.changedAt || stat.nlink !== copy.identity.links
        || stat.size !== copy.bytes || stat.mtimeMs !== copy.createdAt) { failed += 1; continue; }
      // Unlike force-rm, unlink fails if another actor already removed the file.
      unlinkSync(target);
      removed += 1;
      // Removing a hard link does not reclaim content retained through another name.
      if (stat.nlink === 1) bytesFreed += stat.size;
    } catch {
      failed += 1;
    }
  }
  return { removed, bytesFreed, failed };
}

/** Card wording helper: nothing automatic (the new-name copies) is ever offered. */
export function isManagedAutoCopy(name: string): boolean {
  return CODEX_RECONCILE_NAME.test(name);
}
