import { describe, expect, it, vi } from 'vitest';
import { pruneCodememWorkspaces, runCodememMaintenance } from './codemem-pruner';

describe('pruneCodememWorkspaces', () => {
  it('retries retired-worktree cleanup on worker maintenance after an unavailable worker', () => {
    const store = { listWorkspaceIndexStats: () => [{ workspaceHash: 'retired', absPath: '/repo/.worktrees/queue/retired', lastIndexedAt: 0, manifestEntries: 1, workspaceChunks: 1, workspaceSymbols: 1 }], deleteWorkspaceIndex: vi.fn() };
    expect(pruneCodememWorkspaces(store, { maxWorkspaces: 10, maxManifestEntriesPerWorkspace: 100, workspaceExists: () => false }).deletedWorkspaceHashes).toEqual(['retired']);
  });
  it('keeps ordinary project roots outside the temporary workspace count', () => {
    const store = {
      listWorkspaceIndexStats: () => ['project', 'old', 'new'].map((id, i) => ({ workspaceHash: id, absPath: i === 0 ? '/project' : `/repo/.worktrees/${id}`, lastIndexedAt: i, manifestEntries: 1, workspaceChunks: 1, workspaceSymbols: 1 })),
      deleteWorkspaceIndex: vi.fn(),
    };
    expect(pruneCodememWorkspaces(store, { maxWorkspaces: 1, maxManifestEntriesPerWorkspace: 100 }).deletedWorkspaceHashes).toEqual(['old']);
  });
  it('prunes least-recently-indexed workspaces until workspace count is within quota', () => {
    const deleted: string[] = [];
    const store = {
      listWorkspaceIndexStats: vi.fn(() => [
        { workspaceHash: 'old', absPath: '/repo/.worktrees/old', lastIndexedAt: 1, manifestEntries: 10, workspaceChunks: 10, workspaceSymbols: 1 },
        { workspaceHash: 'new', absPath: '/repo/.worktrees/new', lastIndexedAt: 2, manifestEntries: 10, workspaceChunks: 10, workspaceSymbols: 1 },
      ]),
      deleteWorkspaceIndex: vi.fn((workspaceHash: string) => deleted.push(workspaceHash)),
    };

    const result = pruneCodememWorkspaces(store, { maxWorkspaces: 1, maxManifestEntriesPerWorkspace: 100 });

    expect(result.deletedWorkspaceHashes).toEqual(['old']);
    expect(deleted).toEqual(['old']);
  });

  it('prunes a workspace that exceeds the manifest-entry quota', () => {
    const store = {
      listWorkspaceIndexStats: vi.fn(() => [
        { workspaceHash: 'huge', absPath: '/huge', lastIndexedAt: 2, manifestEntries: 500_001, workspaceChunks: 1, workspaceSymbols: 1 },
      ]),
      deleteWorkspaceIndex: vi.fn(),
    };

    const result = pruneCodememWorkspaces(store, { maxWorkspaces: 10, maxManifestEntriesPerWorkspace: 500_000 });

    expect(result.deletedWorkspaceHashes).toEqual(['huge']);
    expect(store.deleteWorkspaceIndex).toHaveBeenCalledWith('huge');
  });

  it('runs content maintenance after workspace pruning', () => {
    const store = {
      listWorkspaceIndexStats: vi.fn(() => []),
      deleteWorkspaceIndex: vi.fn(),
      pruneAbandonedWorkspaces: vi.fn(() => ({ deletedWorkspaces: 1, deletedChunks: 9, remainingWorkspaces: 0 })),
      releaseDeletedSpace: vi.fn(() => ({ deletedChunks: 3, finished: false })),
      clearLegacyMerkleNodes: vi.fn(() => 2),
      vacuumFreelistPages: vi.fn(() => ({ freedPages: 4, remainingFreePages: 0, stoppedReason: 'done' as const })),
    };
    const result = runCodememMaintenance(store, {
      maxWorkspaces: 10,
      maxManifestEntriesPerWorkspace: 500_000,
      vacuumTimeBudgetMs: 1_000,
    });

    expect(result).toMatchObject({
      deletedWorkspaceHashes: [],
      retainedWorkspaceHashes: [],
      deletedOrphanChunks: 3,
      deletedLegacyMerkleNodes: 2,
      spaceReleaseFinished: false,
      vacuum: { freedPages: 4, remainingFreePages: 0, stoppedReason: 'done' },
    });
    expect(store.vacuumFreelistPages).toHaveBeenCalledWith({ timeBudgetMs: 1_000 });
    expect(store.releaseDeletedSpace).toHaveBeenCalledTimes(1);
    expect(store.clearLegacyMerkleNodes).toHaveBeenCalledTimes(1);
    expect(store.vacuumFreelistPages).toHaveBeenCalledTimes(1);
  });
});
