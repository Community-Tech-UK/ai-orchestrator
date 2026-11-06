import type { WorkspaceHash } from './types';
import type {
  PruneAbandonedWorkspacesResult,
  SpaceReleaseStep,
  VacuumFreelistOptions,
  VacuumFreelistResult,
  WorkspaceIndexStats,
} from './cas-workspace-index-maintenance';
import { isTemporaryWorktreePath } from './worktree-index-policy';

export interface CodememPrunerStore {
  listWorkspaceIndexStats(): WorkspaceIndexStats[];
  deleteWorkspaceIndex(workspaceHash: WorkspaceHash): void;
}

export interface CodememMaintenanceStore extends CodememPrunerStore {
  pruneAbandonedWorkspaces(): PruneAbandonedWorkspacesResult;
  releaseDeletedSpace(): SpaceReleaseStep;
  clearLegacyMerkleNodes(): number;
  vacuumFreelistPages(options?: VacuumFreelistOptions): VacuumFreelistResult;
}

export interface CodememPruneOptions {
  maxWorkspaces: number;
  maxManifestEntriesPerWorkspace: number;
  workspaceExists?: (workspacePath: string) => boolean;
}

export interface CodememMaintenanceOptions extends CodememPruneOptions {
  vacuumTimeBudgetMs?: number;
}

export interface CodememPruneResult {
  deletedWorkspaceHashes: WorkspaceHash[];
  retainedWorkspaceHashes: WorkspaceHash[];
}

export interface CodememMaintenanceResult extends CodememPruneResult {
  abandoned: PruneAbandonedWorkspacesResult;
  deletedOrphanChunks: number;
  deletedLegacyMerkleNodes: number;
  /** False when more bounded steps are needed to finish giving space back. */
  spaceReleaseFinished: boolean;
  vacuum: VacuumFreelistResult;
}

export function pruneCodememWorkspaces(
  store: CodememPrunerStore,
  options: CodememPruneOptions,
): CodememPruneResult {
  const stats = store.listWorkspaceIndexStats();
  const deleteSet = new Set<WorkspaceHash>();

  for (const row of stats) {
    if (row.manifestEntries > options.maxManifestEntriesPerWorkspace ||
      (isTemporaryWorktreePath(row.absPath) && options.workspaceExists?.(row.absPath) === false)) {
      deleteSet.add(row.workspaceHash);
    }
  }

  const remaining = stats
    // Ordinary project roots may have been opened explicitly. Conservatively
    // retain them; only disposable worktree indexes compete for the count cap.
    .filter((row) => !deleteSet.has(row.workspaceHash) && isTemporaryWorktreePath(row.absPath))
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
  options: CodememMaintenanceOptions,
): CodememMaintenanceResult {
  const pruneResult = pruneCodememWorkspaces(store, options);
  const abandoned = store.pruneAbandonedWorkspaces();
  const spaceRelease = store.releaseDeletedSpace();
  const deletedLegacyMerkleNodes = store.clearLegacyMerkleNodes();
  const vacuum = store.vacuumFreelistPages(
    options.vacuumTimeBudgetMs === undefined ? undefined : { timeBudgetMs: options.vacuumTimeBudgetMs },
  );
  return {
    ...pruneResult,
    abandoned,
    deletedOrphanChunks: spaceRelease.deletedChunks,
    deletedLegacyMerkleNodes,
    spaceReleaseFinished: spaceRelease.finished,
    vacuum,
  };
}
