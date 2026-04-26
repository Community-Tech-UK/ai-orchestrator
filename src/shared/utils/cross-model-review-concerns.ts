import type { ReviewDimensionScore, ReviewResult } from '../types/cross-model-review.types';

const SCORE_LABELS: Record<string, string> = {
  correctness: 'Correctness',
  completeness: 'Completeness',
  security: 'Security',
  consistency: 'Consistency',
  feasibility: 'Feasibility',
};

const NO_CONCERN_TEXT = new Set([
  'n/a',
  'na',
  'none',
  'none identified',
  'not applicable',
  'no concerns',
  'no issues',
  'no issues found',
  'no critical issues',
  'no integration risks',
]);

function isMeaningfulConcernText(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/[.!]+$/g, '');
  return normalized.length > 0 && !NO_CONCERN_TEXT.has(normalized);
}

function meaningfulStrings(values: readonly string[] | undefined): string[] {
  return (values ?? []).map(value => value.trim()).filter(isMeaningfulConcernText);
}

function dimensionEntries(result: ReviewResult): [string, ReviewDimensionScore][] {
  return Object.entries(result.scores)
    .filter((entry): entry is [string, ReviewDimensionScore] => entry[1] != null);
}

export function getReviewResultConcernItems(result: ReviewResult): string[] {
  const items: string[] = [];

  for (const [key, score] of dimensionEntries(result)) {
    items.push(...meaningfulStrings(score.issues));
    if (score.score <= 2 && meaningfulStrings(score.issues).length === 0) {
      const label = SCORE_LABELS[key] ?? key;
      items.push(`${label} scored ${score.score}/4: ${score.reasoning}`);
    }
  }

  items.push(...meaningfulStrings(result.criticalIssues));
  items.push(...meaningfulStrings(result.integrationRisks));

  for (const trace of result.traces ?? []) {
    if (trace.result === 'fail') {
      items.push(`${trace.scenario}: ${trace.detail}`);
    }
  }

  for (const assumption of result.assumptions ?? []) {
    if (assumption.severity === 'high' && isMeaningfulConcernText(assumption.assumption)) {
      items.push(`High-severity assumption: ${assumption.assumption.trim()}`);
    }
  }

  return Array.from(new Set(items));
}

export function reviewResultHasConcerns(result: ReviewResult): boolean {
  return result.overallVerdict !== 'APPROVE' || getReviewResultConcernItems(result).length > 0;
}

export function countReviewResultsWithConcerns(results: readonly ReviewResult[]): number {
  return results.filter(reviewResultHasConcerns).length;
}
