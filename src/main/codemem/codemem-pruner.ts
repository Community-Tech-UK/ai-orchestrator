import type { WorkspaceHash } from './types';
import type { WorkspaceIndexStats } from './cas-workspace-index-maintenance';

export interface CodememPrunerStore {
  listWorkspaceIndexStats(): WorkspaceIndexStats[];
  deleteWorkspaceIndex(workspaceHash: WorkspaceHash): void;
}

export interface CodememMaintenanceStore extends CodememPrunerStore {
  pruneUnreferencedChunks(): number;
  clearLegacyMerkleNodes(): number;
  optimizeSearchIndex(): void;
  vacuumFreelistPages(): void;
}

export interface CodememPruneOptions {
  maxWorkspaces: number;
  maxManifestEntriesPerWorkspace: number;
}

export interface CodememPruneResult {
  deletedWorkspaceHashes: WorkspaceHash[];
  retainedWorkspaceHashes: WorkspaceHash[];
}

export interface CodememMaintenanceResult extends CodememPruneResult {
  deletedOrphanChunks: number;
  deletedLegacyMerkleNodes: number;
}

export function pruneCodememWorkspaces(
  store: CodememPrunerStore,
  options: CodememPruneOptions,
): CodememPruneResult {
  const stats = store.listWorkspaceIndexStats();
  const deleteSet = new Set<WorkspaceHash>();

  for (const row of stats) {
    if (row.manifestEntries > options.maxManifestEntriesPerWorkspace) {
      deleteSet.add(row.workspaceHash);
    }
  }

  const remaining = stats
    .filter((row) => !deleteSet.has(row.workspaceHash))
    .sort((left, right) => left.lastIndexedAt - right.lastIndexedAt);
  while (remaining.length > options.maxWorkspaces) {
    const row = remaining.shift();
    if (row) deleteSet.add(row.workspaceHash);
  }

  for (const workspaceHash of deleteSet) {
    store.deleteWorkspaceIndex(workspaceHash);
  }

  return {
    deletedWorkspaceHashes: [...deleteSet],
    retainedWorkspaceHashes: stats
      .map((row) => row.workspaceHash)
      .filter((workspaceHash) => !deleteSet.has(workspaceHash)),
  };
}

export function runCodememMaintenance(
  store: CodememMaintenanceStore,
  options: CodememPruneOptions,
): CodememMaintenanceResult {
  const pruneResult = pruneCodememWorkspaces(store, options);
  const deletedOrphanChunks = store.pruneUnreferencedChunks();
  const deletedLegacyMerkleNodes = store.clearLegacyMerkleNodes();
  store.optimizeSearchIndex();
  store.vacuumFreelistPages();
  return {
    ...pruneResult,
    deletedOrphanChunks,
    deletedLegacyMerkleNodes,
  };
}
