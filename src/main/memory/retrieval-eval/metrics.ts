/**
 * WS16 — retrieval quality metrics (pure math, spec'd against hand-computed
 * cases). Binary relevance: a returned id is a hit iff it appears in the
 * query's labeled relevant set.
 *
 * - Recall@k  = |top-k ∩ relevant| / |relevant|
 * - NDCG@k    = DCG@k / IDCG@k with binary gains: DCG = Σ 1/log2(rank+1)
 *               over hit ranks (1-based); IDCG assumes all relevant items
 *               occupy the top ranks (bounded by k).
 *
 * Queries with an empty relevant set are invalid input (rejected upstream by
 * the dataset loader) — metrics here may assume |relevant| ≥ 1.
 */

export interface QueryEvaluation {
  queryId: string;
  type: string;
  returned: readonly string[];
  relevant: ReadonlySet<string>;
}

export interface MetricSummary {
  queries: number;
  r1: number;
  r5: number;
  r10: number;
  ndcg10: number;
}

export interface RetrievalReport extends MetricSummary {
  perType: Record<string, MetricSummary>;
}

export function recallAtK(
  returned: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (relevant.size === 0) return 0;
  let hits = 0;
  for (const id of returned.slice(0, k)) {
    if (relevant.has(id)) hits++;
  }
  return hits / relevant.size;
}

export function ndcgAtK(
  returned: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (relevant.size === 0) return 0;
  let dcg = 0;
  returned.slice(0, k).forEach((id, index) => {
    if (relevant.has(id)) {
      dcg += 1 / Math.log2(index + 2); // rank = index + 1 → log2(rank + 1)
    }
  });
  let idcg = 0;
  const idealHits = Math.min(relevant.size, k);
  for (let i = 0; i < idealHits; i++) {
    idcg += 1 / Math.log2(i + 2);
  }
  return idcg === 0 ? 0 : dcg / idcg;
}

function summarize(evaluations: readonly QueryEvaluation[]): MetricSummary {
  const n = evaluations.length;
  if (n === 0) return { queries: 0, r1: 0, r5: 0, r10: 0, ndcg10: 0 };
  const mean = (fn: (e: QueryEvaluation) => number): number =>
    evaluations.reduce((sum, e) => sum + fn(e), 0) / n;
  return {
    queries: n,
    r1: mean((e) => recallAtK(e.returned, e.relevant, 1)),
    r5: mean((e) => recallAtK(e.returned, e.relevant, 5)),
    r10: mean((e) => recallAtK(e.returned, e.relevant, 10)),
    ndcg10: mean((e) => ndcgAtK(e.returned, e.relevant, 10)),
  };
}

/** Aggregate per-query evaluations into an overall + per-type report. */
export function buildRetrievalReport(evaluations: readonly QueryEvaluation[]): RetrievalReport {
  const byType = new Map<string, QueryEvaluation[]>();
  for (const evaluation of evaluations) {
    const bucket = byType.get(evaluation.type) ?? [];
    bucket.push(evaluation);
    byType.set(evaluation.type, bucket);
  }
  const perType: Record<string, MetricSummary> = {};
  for (const [type, bucket] of byType) {
    perType[type] = summarize(bucket);
  }
  return { ...summarize(evaluations), perType };
}

/**
 * Compare a report against a committed baseline. A metric REGRESSES when it
 * drops more than `tolerance` below baseline (improvements always pass —
 * update the baseline deliberately to lock them in).
 */
export function compareToBaseline(
  report: RetrievalReport,
  baseline: RetrievalReport,
  tolerance = 0.02,
): { ok: boolean; regressions: string[] } {
  const regressions: string[] = [];
  const check = (label: string, actual: number, expected: number): void => {
    if (actual < expected - tolerance) {
      regressions.push(`${label}: ${actual.toFixed(3)} < baseline ${expected.toFixed(3)} - ${tolerance}`);
    }
  };
  check('r1', report.r1, baseline.r1);
  check('r5', report.r5, baseline.r5);
  check('r10', report.r10, baseline.r10);
  check('ndcg10', report.ndcg10, baseline.ndcg10);
  return { ok: regressions.length === 0, regressions };
}
