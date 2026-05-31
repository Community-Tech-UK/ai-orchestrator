/**
 * Hybrid-recall fusion (claude2_todo #14).
 *
 * Pure re-ranking for the codemem hybrid path: over-fetch from both the vector
 * and BM25 indexes, normalize each list to a common [0,1] scale, then fuse with
 * `fused = vecWeight*vec + bm25Weight*bm25` (default 0.6 / 0.4). A **union
 * mode** additionally pulls in BM25-only candidates the vector index missed
 * (the documented +recall, zero-LLM win).
 *
 * Pure and deterministic (ties broken by id), so it is fully unit-testable
 * independently of the embedding / BM25 backends.
 */

export interface ScoredCandidate {
  id: string;
  score: number;
}

export interface FusionOptions {
  /** Weight on the (normalized) vector score. Default 0.6. */
  vecWeight?: number;
  /** Weight on the (normalized) BM25 score. Default 0.4. */
  bm25Weight?: number;
  /**
   * When true, include candidates present in only one list (notably BM25-only
   * candidates the vector index missed). When false (default), the vector list
   * drives the candidate set and BM25 only re-ranks/boosts it.
   */
  unionMode?: boolean;
  /** Optional cap on the returned list length (after fusion + sort). */
  limit?: number;
}

export interface FusedCandidate extends ScoredCandidate {
  /** Normalized vector contribution (0 when absent from the vector list). */
  vec: number;
  /** Normalized BM25 contribution (0 when absent from the BM25 list). */
  bm25: number;
}

export const DEFAULT_VEC_WEIGHT = 0.6;
export const DEFAULT_BM25_WEIGHT = 0.4;

/** Over-fetch count: pull `factor`× the desired top-k before re-ranking. */
export function overFetchCount(topK: number, factor = 3): number {
  const k = Math.max(0, Math.floor(topK));
  return k * Math.max(1, Math.floor(factor));
}

/** Min-max normalize a list's scores to [0,1]. Equal scores → all 1 (present). */
function normalize(list: ScoredCandidate[]): Map<string, number> {
  const out = new Map<string, number>();
  if (list.length === 0) return out;
  let min = Infinity;
  let max = -Infinity;
  for (const c of list) {
    if (c.score < min) min = c.score;
    if (c.score > max) max = c.score;
  }
  const span = max - min;
  for (const c of list) {
    out.set(c.id, span === 0 ? 1 : (c.score - min) / span);
  }
  return out;
}

/**
 * Fuse vector and BM25 candidate lists into a single re-ranked list.
 * Inputs may be in any order; output is sorted by fused score (desc), ties by id.
 */
export function fuseHybrid(
  vecList: ScoredCandidate[],
  bm25List: ScoredCandidate[],
  options: FusionOptions = {},
): FusedCandidate[] {
  const vecWeight = options.vecWeight ?? DEFAULT_VEC_WEIGHT;
  const bm25Weight = options.bm25Weight ?? DEFAULT_BM25_WEIGHT;
  const unionMode = options.unionMode ?? false;

  const normVec = normalize(vecList);
  const normBm25 = normalize(bm25List);

  // Candidate set: vector ids always; BM25-only ids only in union mode.
  const ids = new Set<string>(normVec.keys());
  if (unionMode) {
    for (const id of normBm25.keys()) ids.add(id);
  }

  const fused: FusedCandidate[] = [];
  for (const id of ids) {
    const vec = normVec.get(id) ?? 0;
    const bm25 = normBm25.get(id) ?? 0;
    fused.push({ id, vec, bm25, score: vecWeight * vec + bm25Weight * bm25 });
  }

  fused.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));

  return typeof options.limit === 'number' ? fused.slice(0, Math.max(0, options.limit)) : fused;
}
