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

  function hit(pathFromRoot: string, contentHash: string, score: number): WorkspaceChunkSearchResult {
    return {
      rowid: 1,
      workspaceHash: 'workspace',
      pathFromRoot,
      contentHash,
      startLine: 1,
      endLine: 3,
      language: 'typescript',
      chunkType: 'function',
      name: contentHash,
      score,
    };
  }

  function searchOver(
    hits: WorkspaceChunkSearchResult[],
    texts: Record<string, string>,
    query: string,
    options?: { strongMatchOnly?: boolean },
  ) {
    const store = {
      getWorkspaceRootByPath: () => ({ workspaceHash: 'workspace' }),
      searchWorkspaceChunks: vi.fn(() => hits),
      getChunks: () => new Map(Object.entries(texts).map(([hash, text]) => [hash, chunk(hash, text)])),
    } as unknown as CasStore;
    return {
      store,
      paths: searchHydratedChunks(store, '/repo', query, 5, options).results.map((result) => result.relativePath),
    };
  }

  it('ranks source code above a plan document that repeats its wording', () => {
    const { paths } = searchOver(
      [hit('docs/plans/retry_plan.md', 'doc', -40), hit('src/retry.ts', 'code', -20)],
      { doc: 'retry backoff delay', code: 'retry backoff delay' },
      'retry backoff delay',
    );

    expect(paths).toEqual(['src/retry.ts', 'docs/plans/retry_plan.md']);
  });

  it('ranks a chunk with more of the query above one with a single strong word', () => {
    const { paths } = searchOver(
      [hit('src/one-word.ts', 'one', -30), hit('src/all-words.ts', 'all', -18)],
      { one: 'worker', all: 'worker exits while waiting' },
      'worker exits waiting',
    );

    expect(paths).toEqual(['src/all-words.ts', 'src/one-word.ts']);
  });

  it('asks the index for a wide pool, then returns only the requested number', () => {
    const hits = Array.from({ length: 30 }, (_, index) => hit(`src/${index}.ts`, `h${index}`, -index - 1));
    const texts = Object.fromEntries(hits.map((entry) => [entry.contentHash, 'worker queue']));
    const { store, paths } = searchOver(hits, texts, 'worker queue');

    expect(store.searchWorkspaceChunks).toHaveBeenCalledWith('workspace', 'worker queue', 100);
    expect(paths).toHaveLength(5);
  });

  it('keeps the original search score on results for display', () => {
    const store = {
      getWorkspaceRootByPath: () => ({ workspaceHash: 'workspace' }),
      searchWorkspaceChunks: () => [hit('docs/a.md', 'a', -12.5)],
      getChunks: () => new Map([['a', chunk('a', 'worker queue')]]),
    } as unknown as CasStore;

    expect(searchHydratedChunks(store, '/repo', 'worker queue', 5).results[0]?.score).toBe(-12.5);
  });

  describe('automatic context', () => {
    it('does not touch the index for a chatty message', () => {
      const { store, paths } = searchOver(
        [hit('src/a.ts', 'a', -50)],
        { a: 'yeah fix all those issues please' },
        'yeah fix all those issues please!!!',
        { strongMatchOnly: true },
      );

      expect(store.searchWorkspaceChunks).not.toHaveBeenCalled();
      expect(paths).toEqual([]);
    });

    it('drops chunks sharing only one word with the message', () => {
      const { paths } = searchOver(
        [hit('src/weak.ts', 'weak', -50), hit('src/strong.ts', 'strong', -10)],
        { weak: 'provider', strong: 'provider limit retry' },
        'provider limit retry',
        { strongMatchOnly: true },
      );

      expect(paths).toEqual(['src/strong.ts']);
    });

    it('still finds the chunk defining an identifier named on its own', () => {
      const { paths } = searchOver(
        [hit('src/uses-store.ts', 'caller', -50), hit('src/vector-store.ts', 'VectorStore', -10)],
        { caller: 'new VectorStore()', VectorStore: 'export class VectorStore {}' },
        'what does VectorStore do',
        { strongMatchOnly: true },
      );

      expect(paths).toEqual(['src/vector-store.ts']);
    });

    it('leaves out code that only mentions a brand name shaped like an identifier', () => {
      const { paths } = searchOver(
        [hit('src/links.ts', 'links', -50)],
        { links: "const help = 'see GitHub for details';" },
        'GitHub?',
        { strongMatchOnly: true },
      );

      expect(paths).toEqual([]);
    });

    it('reports an indexed workspace even when nothing qualifies, so no fallback is tried', () => {
      const store = {
        getWorkspaceRootByPath: () => ({ workspaceHash: 'workspace' }),
        searchWorkspaceChunks: () => [],
        getChunks: () => new Map(),
      } as unknown as CasStore;

      expect(searchHydratedChunks(store, '/repo', 'ok', 5, { strongMatchOnly: true }))
        .toEqual({ indexed: true, results: [] });
    });
  });
});
