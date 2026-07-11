import { getLogger } from '../logging/logger';
import type { ReviewResult, ReviewVerdict } from '../../shared/types/cross-model-review.types';
import {
  ReviewResultJsonSchema,
  TieredReviewResultJsonSchema,
} from '../../shared/validation/cross-model-review-schemas';
import { extractJson } from './cross-model-review-service.helpers';

const logger = getLogger('CrossModelReviewService');

export function parseCrossModelReviewResponse(
  reviewerId: string,
  rawResponse: string,
  reviewDepth: 'structured' | 'tiered',
  durationMs: number,
): ReviewResult | null {
  const parsed = extractJson(rawResponse);
  if (!parsed) {
    logger.warn('Failed to extract JSON from review response', {
      reviewerId,
      responseLength: rawResponse.length,
      responsePreview: rawResponse.slice(0, 400),
    });
    return null;
  }

  const coerced = coerceReviewJson(parsed);
  const schema = reviewDepth === 'tiered' ? TieredReviewResultJsonSchema : ReviewResultJsonSchema;
  const validated = schema.safeParse(coerced);
  if (!validated.success) {
    logger.warn('Review response failed schema validation', {
      reviewerId,
      errors: validated.error.issues.slice(0, 3),
    });
    return null;
  }

  const data = validated.data;
  const scores = 'scores' in data ? data.scores : data;
  return {
    reviewerId,
    source: 'remote',
    reviewType: reviewDepth,
    timestamp: Date.now(),
    durationMs,
    scores: {
      correctness: scores.correctness,
      completeness: scores.completeness,
      security: scores.security,
      consistency: scores.consistency,
      feasibility: 'feasibility' in scores ? scores.feasibility : undefined,
    },
    overallVerdict: data.overall_verdict as ReviewVerdict,
    summary: data.summary,
    criticalIssues: 'critical_issues' in data ? data.critical_issues : undefined,
    traces: 'traces' in data ? data.traces : undefined,
    boundariesChecked: 'boundaries_checked' in data ? data.boundaries_checked : undefined,
    assumptions: 'assumptions' in data ? data.assumptions : undefined,
    integrationRisks: 'integration_risks' in data ? data.integration_risks : undefined,
    parseSuccess: true,
  } as ReviewResult;
}

/** Coerce the small set of common reviewer JSON quirks accepted historically. */
function coerceReviewJson(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['overall_verdict'] === 'string') {
    obj['overall_verdict'] = obj['overall_verdict'].toUpperCase();
  }

  const scoreSections = obj['scores'] ? [obj['scores'] as Record<string, unknown>] : [obj];
  if (!obj['scores']) scoreSections.push(obj);
  else scoreSections.push(obj['scores'] as Record<string, unknown>);

  for (const section of scoreSections) {
    if (typeof section !== 'object' || section === null) continue;
    for (const dimension of ['correctness', 'completeness', 'security', 'consistency', 'feasibility']) {
      const value = (section as Record<string, unknown>)[dimension];
      if (typeof value !== 'object' || value === null) continue;
      const score = value as Record<string, unknown>;
      if (typeof score['score'] === 'string') {
        const numeric = parseInt(score['score'], 10);
        if (!Number.isNaN(numeric)) score['score'] = numeric;
      }
      if (!Array.isArray(score['issues'])) {
        score['issues'] = score['issues'] ? [String(score['issues'])] : [];
      }
      if (typeof score['reasoning'] !== 'string') {
        score['reasoning'] = score['reasoning']
          ? String(score['reasoning'])
          : 'No reasoning provided';
      }
    }
  }
  return obj;
}
