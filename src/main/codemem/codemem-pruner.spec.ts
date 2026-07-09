import { describe, expect, it, vi } from 'vitest';
import { pruneCodememWorkspaces, runCodememMaintenance } from './codemem-pruner';

describe('pruneCodememWorkspaces', () => {
  it('prunes least-recently-indexed workspaces until workspace count is within quota', () => {
    const deleted: string[] = [];
    const store = {
      listWorkspaceIndexStats: vi.fn(() => [
        { workspaceHash: 'old', absPath: '/old', lastIndexedAt: 1, manifestEntries: 10, workspaceChunks: 10, workspaceSymbols: 1 },
        { workspaceHash: 'new', absPath: '/new', lastIndexedAt: 2, manifestEntries: 10, workspaceChunks: 10, workspaceSymbols: 1 },
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
      pruneUnreferencedChunks: vi.fn(() => 3),
      clearLegacyMerkleNodes: vi.fn(() => 2),
      optimizeSearchIndex: vi.fn(),
      vacuumFreelistPages: vi.fn(),
    };
    const result = runCodememMaintenance(store, {
      maxWorkspaces: 10,
      maxManifestEntriesPerWorkspace: 500_000,
    });

    expect(result).toMatchObject({
      deletedWorkspaceHashes: [],
      retainedWorkspaceHashes: [],
      deletedOrphanChunks: 3,
      deletedLegacyMerkleNodes: 2,
    });
    expect(store.pruneUnreferencedChunks).toHaveBeenCalledTimes(1);
    expect(store.clearLegacyMerkleNodes).toHaveBeenCalledTimes(1);
    expect(store.optimizeSearchIndex).toHaveBeenCalledTimes(1);
    expect(store.vacuumFreelistPages).toHaveBeenCalledTimes(1);
  });
});
