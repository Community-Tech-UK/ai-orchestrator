import { promises as fs } from 'node:fs';
import type { Ignore } from 'ignore';
import { getLogger } from '../logging/logger';
import type { CasStore } from './cas-store';
import type { WorkspaceHash } from './types';

const logger = getLogger('CodeIndexReconciler');

export interface ReconcileResult {
  workspaceHash: WorkspaceHash;
  scannedFiles: number;
  changedFiles: number;
  removedFiles: number;
  cancelled: boolean;
}

/** Callbacks into CodeIndexManager, mirroring the CodeIndexWatcher host pattern. */
export interface ReconcileHost {
  store: Pick<CasStore, 'isCancelRequested' | 'listManifestEntries'>;
  loadIgnoreRules(workspacePath: string): Promise<Ignore>;
  walkFiles(
    rootPath: string,
    dirPath: string,
    ig: Ignore,
    shouldStop?: () => boolean,
  ): Promise<string[]>;
  toRelativePath(workspacePath: string, absolutePath: string): string;
  indexFile(
    workspacePath: string,
    workspaceHash: WorkspaceHash,
    absoluteFilePath: string,
  ): Promise<number>;
  removeFileFromIndex(workspaceHash: WorkspaceHash, pathFromRoot: string): void;
  refreshRootHashAfterIncrementalChange(workspaceHash: WorkspaceHash): void;
  emitChanged(event: { workspaceHash: WorkspaceHash; paths: string[] }): void;
}

/**
 * Diff the stored manifest against the filesystem and repair drift: re-index
 * files whose mtime changed or that are new, drop entries whose files are
 * gone. Covers changes made while no watcher was running (app closed, git
 * pull, branch switch). The Merkle root is recomputed once at the end.
 */
export async function reconcileWorkspaceIndex(
  host: ReconcileHost,
  absoluteWorkspacePath: string,
  workspaceHash: WorkspaceHash,
): Promise<ReconcileResult> {
  const isCancelled = (): boolean => host.store.isCancelRequested(workspaceHash);
  const ig = await host.loadIgnoreRules(absoluteWorkspacePath);
  const files = await host.walkFiles(absoluteWorkspacePath, absoluteWorkspacePath, ig, isCancelled);

  const result: ReconcileResult = {
    workspaceHash,
    scannedFiles: files.length,
    changedFiles: 0,
    removedFiles: 0,
    cancelled: isCancelled(),
  };
  // A cancelled walk is partial — diffing against it would misread unwalked
  // files as deletions, so abort before touching the manifest.
  if (result.cancelled) {
    return result;
  }

  const onDisk = new Map<string, string>();
  for (const absoluteFilePath of files) {
    onDisk.set(host.toRelativePath(absoluteWorkspacePath, absoluteFilePath), absoluteFilePath);
  }

  const changedPaths: string[] = [];
  for (const entry of host.store.listManifestEntries(workspaceHash)) {
    if (isCancelled()) {
      result.cancelled = true;
      break;
    }

    const absoluteFilePath = onDisk.get(entry.pathFromRoot);
    if (absoluteFilePath === undefined) {
      host.removeFileFromIndex(workspaceHash, entry.pathFromRoot);
      result.removedFiles += 1;
      changedPaths.push(entry.pathFromRoot);
      continue;
    }

    onDisk.delete(entry.pathFromRoot);
    const mtime = await fs.stat(absoluteFilePath)
      .then((stat) => Math.floor(stat.mtimeMs))
      .catch(() => null);
    if (mtime === entry.mtime) {
      continue;
    }

    await reindexDuringReconcile(host, absoluteWorkspacePath, workspaceHash, entry.pathFromRoot, absoluteFilePath);
    result.changedFiles += 1;
    changedPaths.push(entry.pathFromRoot);
  }

  if (!result.cancelled) {
    for (const [relativePath, absoluteFilePath] of onDisk) {
      if (isCancelled()) {
        result.cancelled = true;
        break;
      }

      await reindexDuringReconcile(host, absoluteWorkspacePath, workspaceHash, relativePath, absoluteFilePath);
      result.changedFiles += 1;
      changedPaths.push(relativePath);
    }
  }

  if (changedPaths.length > 0) {
    host.refreshRootHashAfterIncrementalChange(workspaceHash);
    host.emitChanged({ workspaceHash, paths: changedPaths });
    logger.info('Reconciled drifted code index entries', {
      workspaceHash,
      scannedFiles: result.scannedFiles,
      changedFiles: result.changedFiles,
      removedFiles: result.removedFiles,
      cancelled: result.cancelled,
    });
  }

  return result;
}

async function reindexDuringReconcile(
  host: ReconcileHost,
  workspacePath: string,
  workspaceHash: WorkspaceHash,
  relativePath: string,
  absoluteFilePath: string,
): Promise<void> {
  try {
    await host.indexFile(workspacePath, workspaceHash, absoluteFilePath);
  } catch (error) {
    host.removeFileFromIndex(workspaceHash, relativePath);
    logger.debug('Removed unreadable file from manifest during reconcile', {
      workspaceHash,
      relativePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
