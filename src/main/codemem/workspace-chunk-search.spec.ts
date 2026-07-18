import { describe, expect, it, vi } from 'vitest';
import type { CasStore, WorkspaceChunkSearchResult } from './cas-store';
import type { Chunk } from './types';
import { searchHydratedChunks } from './workspace-chunk-search';

function chunk(contentHash: string, rawText: string): Chunk {
  return {
    contentHash,
    astNormalizedHash: contentHash,
    language: 'typescript',
    chunkType: 'function',
    name: contentHash,
    signature: null,
    docComment: null,
    symbolsJson: '[]',
    importsJson: '[]',
    exportsJson: '[]',
    rawText,
  };
}

describe('searchHydratedChunks', () => {
  it('hydrates the FTS hit batch in one store call', () => {
    const hits: WorkspaceChunkSearchResult[] = [
      {
        rowid: 1,
        workspaceHash: 'workspace',
        pathFromRoot: 'src/a.ts',
        contentHash: 'hash-a',
        startLine: 1,
        endLine: 3,
        language: 'typescript',
        chunkType: 'function',
        name: 'a',
        score: 1,
      },
    ];
    const getChunks = vi.fn(() => new Map([['hash-a', chunk('hash-a', 'const a = 1;')]]));
    const getChunk = vi.fn();
    const store = {
      getWorkspaceRootByPath: () => ({ workspaceHash: 'workspace' }),
      searchWorkspaceChunks: () => hits,
      getChunks,
      getChunk,
    } as unknown as CasStore;

    const response = searchHydratedChunks(store, '/repo', 'a', 5);

    expect(getChunks).toHaveBeenCalledWith(['hash-a']);
    expect(getChunk).not.toHaveBeenCalled();
    expect(response.results[0]?.content).toBe('const a = 1;');
  });
});
