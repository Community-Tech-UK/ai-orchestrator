/**
 * Compare two SyncManifests and produce a DirectoryDiff describing which
 * files were added, removed, modified, or are identical.
 */

import type {
  SyncManifest,
  SyncFileEntry,
  DirectoryDiff,
  ModifiedEntry,
} from '../../../shared/types/sync.types';

/**
 * Diff two manifests.
 *
 * @param source  The "new" / desired state manifest.
 * @param target  The "old" / current state manifest.
 * @returns A DirectoryDiff describing the changes needed to bring target in sync with source.
 */
export function diffManifests(source: SyncManifest, target: SyncManifest): DirectoryDiff {
  const sourceMap = new Map<string, SyncFileEntry>();
  for (const entry of source.entries) {
    sourceMap.set(entry.relativePath, entry);
  }

  const targetMap = new Map<string, SyncFileEntry>();
  for (const entry of target.entries) {
    targetMap.set(entry.relativePath, entry);
  }

  const added: SyncFileEntry[] = [];
  const removed: SyncFileEntry[] = [];
  const modified: ModifiedEntry[] = [];
  const identical: string[] = [];

  // Files in source but not in target → added
  // Files in both → check hash → identical or modified
  for (const [relPath, sourceEntry] of sourceMap) {
    const targetEntry = targetMap.get(relPath);
    if (!targetEntry) {
      added.push(sourceEntry);
    } else if (sourceEntry.hash === targetEntry.hash) {
      identical.push(relPath);
    } else {
      modified.push({ relativePath: relPath, sourceEntry, targetEntry });
    }
  }

  // Files in target but not in source → removed
  for (const [relPath, targetEntry] of targetMap) {
    if (!sourceMap.has(relPath)) {
      removed.push(targetEntry);
    }
  }

  // Sort each category for deterministic output
  added.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  removed.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  modified.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  identical.sort();

  return { added, removed, modified, identical };
}
