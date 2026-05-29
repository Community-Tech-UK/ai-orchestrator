/**
 * Cross-reviewer finding aggregation.
 *
 * Multiple reviewers looking at the same change frequently raise the *same*
 * issue in different words. Presenting those as separate findings (a) buries
 * the signal and (b) hides agreement — "3/3 reviewers flagged this" is a far
 * stronger stop signal than three unlinked bullets. This module clusters
 * near-duplicate findings, records which reviewers agreed, keeps the strongest
 * articulation as the representative, and annotates the body with the
 * agreement ratio.
 *
 * Severity is the MAX across cluster members — never escalated purely from
 * agreement count (three reviewers each saying "low" must not become "high").
 */

import type { HeadlessReviewFinding, HeadlessReviewSeverity } from '../cli-entrypoints/review-command-output';

export interface AggregatableFinding extends HeadlessReviewFinding {
  /** The reviewer (provider) that produced this finding. */
  reviewer: string;
}

export interface AggregatedFinding extends HeadlessReviewFinding {
  /** Distinct reviewers that raised this (clustered) finding, sorted. */
  reviewers: string[];
  /** Number of distinct reviewers that agreed — i.e. `reviewers.length`. */
  agreementCount: number;
}

export interface AggregateOptions {
  /** Total reviewers that ran, for the "N/M" agreement annotation. */
  totalReviewers: number;
  /** Jaccard token-overlap threshold to treat two findings as the same. */
  similarityThreshold?: number;
}

const SEVERITY_RANK: Record<HeadlessReviewSeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be', 'been',
  'to', 'of', 'in', 'on', 'at', 'for', 'with', 'this', 'that', 'these', 'those',
  'it', 'its', 'as', 'by', 'from', 'into', 'not', 'no', 'should', 'could', 'would',
  'will', 'may', 'might', 'can', 'has', 'have', 'had', 'does', 'do', 'did', 'if',
  'when', 'then', 'than', 'there', 'here', 'which', 'what', 'who', 'whom',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9_\s]+/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2 && !STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

/** Two findings can only be "the same" if their files don't actively conflict. */
function filesCompatible(a?: string, b?: string): boolean {
  if (a && b) return a === b;
  return true;
}

function maxSeverity(a: HeadlessReviewSeverity, b: HeadlessReviewSeverity): HeadlessReviewSeverity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

interface Cluster {
  tokens: Set<string>;
  members: AggregatableFinding[];
  reviewers: Set<string>;
}

/**
 * Cluster near-duplicate findings across reviewers, annotate agreement, and
 * sort by severity then agreement. Pure — safe to unit test directly.
 */
export function aggregateReviewFindings(
  findings: AggregatableFinding[],
  options: AggregateOptions,
): AggregatedFinding[] {
  const threshold = options.similarityThreshold ?? 0.5;
  const totalReviewers = Math.max(1, options.totalReviewers);
  const clusters: Cluster[] = [];

  for (const finding of findings) {
    const tokens = tokenize(`${finding.title} ${finding.body}`);
    let target: Cluster | undefined;
    for (const cluster of clusters) {
      const rep = cluster.members[0];
      if (!filesCompatible(finding.file, rep.file)) continue;
      if (jaccard(tokens, cluster.tokens) >= threshold) {
        target = cluster;
        break;
      }
    }
    if (target) {
      target.members.push(finding);
      target.reviewers.add(finding.reviewer);
      // Grow the cluster vocabulary so subsequent matches see all phrasings.
      for (const t of tokens) target.tokens.add(t);
    } else {
      clusters.push({ tokens, members: [finding], reviewers: new Set([finding.reviewer]) });
    }
  }

  const aggregated: AggregatedFinding[] = clusters.map((cluster) => {
    // Representative = the strongest articulation (highest severity, then
    // highest confidence) so the surfaced title/body/file are the best ones.
    const rep = [...cluster.members].sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        (b.confidence ?? 0) - (a.confidence ?? 0),
    )[0];

    const severity = cluster.members.reduce<HeadlessReviewSeverity>(
      (acc, m) => maxSeverity(acc, m.severity),
      'low',
    );
    const reviewers = [...cluster.reviewers].sort();
    const agreementCount = reviewers.length;
    const maxConfidence = cluster.members.reduce((acc, m) => Math.max(acc, m.confidence ?? 0), 0);
    const confidence = Math.min(1, maxConfidence + 0.05 * (agreementCount - 1));

    const agreementPrefix = agreementCount > 1
      ? `${agreementCount}/${totalReviewers} reviewers independently flagged this. `
      : '';

    return {
      title: rep.title,
      body: `${agreementPrefix}${rep.body}`,
      ...(rep.file ? { file: rep.file } : {}),
      ...(typeof rep.line === 'number' ? { line: rep.line } : {}),
      severity,
      confidence,
      reviewers,
      agreementCount,
    };
  });

  aggregated.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      b.agreementCount - a.agreementCount ||
      (b.confidence ?? 0) - (a.confidence ?? 0),
  );

  return aggregated;
}
