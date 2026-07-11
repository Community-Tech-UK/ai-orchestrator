import type { ReviewResult } from '../../shared/types/cross-model-review.types';
import type { HeadlessReviewFinding } from '../cli-entrypoints/review-command-output';

export function toHeadlessFindings(review: ReviewResult): HeadlessReviewFinding[] {
  const findings: HeadlessReviewFinding[] = [];
  for (const issue of review.criticalIssues ?? []) {
    findings.push({
      title: `${review.reviewerId} critical issue`,
      body: issue,
      severity: 'high',
      confidence: 0.9,
    });
  }
  for (const [dimension, score] of Object.entries(review.scores)) {
    if (!score || score.issues.length === 0) continue;
    for (const issue of score.issues) {
      findings.push({
        title: `${review.reviewerId} ${dimension} concern`,
        body: issue,
        severity: severityForScore(dimension, score.score),
        confidence: Math.max(0.1, Math.min(1, (5 - score.score) / 4)),
      });
    }
  }
  if (findings.length === 0 && review.overallVerdict !== 'APPROVE') {
    findings.push({
      title: `${review.reviewerId} ${review.overallVerdict.toLowerCase()} verdict`,
      body: review.summary,
      severity: review.overallVerdict === 'REJECT' ? 'high' : 'medium',
      confidence: 0.7,
    });
  }
  return findings;
}

export function summarizeHeadlessReview(
  successfulReviewers: number,
  findingCount: number,
  infrastructureErrorCount: number,
): string {
  if (infrastructureErrorCount > 0 && successfulReviewers === 0) {
    return 'Headless review failed before any reviewer completed.';
  }
  if (findingCount === 0) return `No findings from ${successfulReviewers} reviewer(s).`;
  return `${findingCount} finding(s) from ${successfulReviewers} reviewer(s).`;
}

function severityForScore(dimension: string, score: number): HeadlessReviewFinding['severity'] {
  if (score <= 1) return dimension === 'security' ? 'critical' : 'high';
  if (score <= 2) return dimension === 'security' ? 'high' : 'medium';
  return 'low';
}
