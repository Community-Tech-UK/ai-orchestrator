/**
 * Shared, electron-free workspace chunk search.
 *
 * Runs the BM25 FTS query, hydrates the candidates, and reranks them. Lives in
 * its own module (importing only `path` + the CasStore type) so it can run BOTH
 * inside the codemem index worker — which solely owns codemem.sqlite — and, as a
 * degraded fallback, on the main thread when no worker is available. Keeping it
 * worker-safe is why it must not pull in anything that top-level imports
 * `electron`.
 */

import * as path from 'node:path';
import type { CasStore } from './cas-store';
import {
  canMatchStrongly,
  chunkRankingText,
  countMatchedTerms,
  extractSearchTerms,
  fileKindWeight,
  isStrongMatch,
} from './code-search-query';

/**
 * Any-word matching casts a wide net, so rank a pool much larger than the
 * result count: the best chunk for a query is often not the best by BM25 alone.
 */
const CANDIDATE_POOL_SIZE = 100;

export interface CodeRetrievalResult {
  workspacePath: string;
  relativePath: string;
  absolutePath: string;
  content: string;
  startLine: number;
  endLine: number;
  score: number;
  source: 'symbol' | 'fts' | 'grepFallback';
  language: string;
  symbolName: string | null;
  stale: boolean;
}

/** Clone-safe response for the index worker's search RPC. */
export interface WorkspaceChunkSearchResponse {
  /** False when the workspace has no index yet (caller should warm + fall back). */
  indexed: boolean;
  results: CodeRetrievalResult[];
}

export interface WorkspaceChunkSearchOptions {
  /** Keep only chunks relevant enough to add to a prompt unasked. */
  strongMatchOnly?: boolean;
}

/**
 * Resolve the workspace, run the FTS query, and hydrate and rank the hits.
 * Returns `indexed: false` (and no results) when the workspace isn't indexed yet
 * so the caller can trigger a background warm and fall back to ripgrep.
 */
export function searchHydratedChunks(
  store: CasStore,
  workspacePath: string,
  query: string,
  limit: number,
  options: WorkspaceChunkSearchOptions = {},
): WorkspaceChunkSearchResponse {
  const workspaceRoot = store.getWorkspaceRootByPath(workspacePath);
  if (!workspaceRoot) {
    return { indexed: false, results: [] };
  }

  const terms = extractSearchTerms(query);
  if (options.strongMatchOnly && !canMatchStrongly(terms)) {
    return { indexed: true, results: [] };
  }

  const hits = store.searchWorkspaceChunks(workspaceRoot.workspaceHash, query, CANDIDATE_POOL_SIZE);
  const chunksByHash = store.getChunks(hits.map((hit) => hit.contentHash));
  const ranked: { rank: number; result: CodeRetrievalResult }[] = [];
  for (const hit of hits) {
    const chunk = chunksByHash.get(hit.contentHash);
    if (!chunk) continue;

    // FTS already matched at least one word, even where stemming hides it here.
    const matchedTerms = Math.max(
      1,
      countMatchedTerms(terms, chunkRankingText(hit.pathFromRoot, hit.name, chunk.rawText)),
    );
    if (options.strongMatchOnly && !isStrongMatch(terms, matchedTerms, hit.name)) continue;

    ranked.push({
      rank: Math.abs(hit.score) * fileKindWeight(hit.pathFromRoot) * (matchedTerms / Math.max(1, terms.length)),
      result: {
        workspacePath,
        relativePath: hit.pathFromRoot,
        absolutePath: path.join(workspacePath, hit.pathFromRoot),
        content: chunk.rawText,
        startLine: hit.startLine,
        endLine: hit.endLine,
        score: hit.score,
        source: 'fts',
        language: hit.language,
        symbolName: hit.name || null,
        stale: false,
      },
    });
  }

  ranked.sort((left, right) => right.rank - left.rank);
  return { indexed: true, results: ranked.slice(0, limit).map((entry) => entry.result) };
}
