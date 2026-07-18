/**
 * Shared, electron-free workspace chunk search.
 *
 * Runs the BM25 FTS query plus the per-hit chunk hydration against a CasStore.
 * Lives in its own module (importing only `path` + the CasStore type) so it can
 * run BOTH inside the codemem index worker — which solely owns codemem.sqlite —
 * and, as a degraded fallback, on the main thread when no worker is available.
 * Keeping it worker-safe is why it must not pull in anything that top-level
 * imports `electron`.
 */

import * as path from 'node:path';
import type { CasStore } from './cas-store';

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

/**
 * Resolve the workspace, run the FTS query, and hydrate each hit's chunk text.
 * Returns `indexed: false` (and no results) when the workspace isn't indexed yet
 * so the caller can trigger a background warm and fall back to ripgrep.
 */
export function searchHydratedChunks(
  store: CasStore,
  workspacePath: string,
  query: string,
  limit: number,
): WorkspaceChunkSearchResponse {
  const workspaceRoot = store.getWorkspaceRootByPath(workspacePath);
  if (!workspaceRoot) {
    return { indexed: false, results: [] };
  }

  const hits = store.searchWorkspaceChunks(workspaceRoot.workspaceHash, query, limit * 2);
  const chunksByHash = store.getChunks(hits.map((hit) => hit.contentHash));
  const results: CodeRetrievalResult[] = [];
  for (const hit of hits) {
    const chunk = chunksByHash.get(hit.contentHash);
    if (!chunk) continue;
    results.push({
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
    });
    if (results.length >= limit) {
      break;
    }
  }
  return { indexed: true, results };
}
