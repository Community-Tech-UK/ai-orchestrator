import { getLogger } from '../logging/logger';
import type { ReviewResult, ReviewVerdict } from '../../shared/types/cross-model-review.types';
import {
  ReviewResultJsonSchema,
  TieredReviewResultJsonSchema,
} from '../../shared/validation/cross-model-review-schemas';
import { extractJson } from './cross-model-review-service.helpers';

const logger = getLogger('CrossModelReviewService');

/** Observed refusal phrasing. Deliberately narrow: a false positive here would
 * discard a real (if oddly worded) review, and a false negative just falls
 * through to the normal "unparseable" path, which is already handled. */
const REFUSAL_PATTERNS: readonly RegExp[] = [
  /\bcannot fulfill\b/i,
  /\bunable to assist\b/i,
  /\bcannot assist\b/i,
];

/** Detect the reviewer plainly refusing the task rather than emitting a malformed review. */
export function isLikelyReviewRefusal(rawResponse: string): boolean {
  const trimmed = rawResponse.trim();
  if (!trimmed) return false;
  return REFUSAL_PATTERNS.some((pattern) => pattern.test(trimmed));
}

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

const ASSUMPTION_TEXT_KEYS = ['assumption', 'description', 'text', 'issue'] as const;
const RISK_TEXT_KEYS = ['risk', 'description', 'text', 'issue', 'summary'] as const;
const ASSUMPTION_SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);

/** First key in `keys` present on `obj` with a non-empty string value, trimmed. */
function resolveTextAlias(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return undefined;
}

function resolveSeverityAlias(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  return ASSUMPTION_SEVERITIES.has(normalized) ? normalized : undefined;
}

/**
 * Normalize one assumption entry to the canonical `{ assumption, severity }`
 * shape. A bare string becomes a medium-severity assumption. An object alias
 * must resolve to both a non-empty text field and a recognized severity;
 * otherwise it is returned unchanged so Zod rejects it rather than this
 * function inventing a fact or a severity the reviewer didn't state.
 */
function normalizeAssumptionEntry(item: unknown): unknown {
  if (typeof item === 'string') {
    const trimmed = item.trim();
    return trimmed.length > 0 ? { assumption: trimmed, severity: 'medium' } : item;
  }
  if (typeof item !== 'object' || item === null) return item;
  const obj = item as Record<string, unknown>;
  const assumption = resolveTextAlias(obj, ASSUMPTION_TEXT_KEYS);
  const severity = resolveSeverityAlias(obj['severity']);
  if (assumption === undefined || severity === undefined) return item;
  return { assumption, severity };
}

/**
 * Normalize one integration-risk entry to a plain string. An object alias
 * must resolve to a non-empty text field; otherwise it is returned unchanged
 * so Zod rejects it.
 */
function normalizeRiskEntry(item: unknown): unknown {
  if (typeof item === 'string' || typeof item !== 'object' || item === null) return item;
  const text = resolveTextAlias(item as Record<string, unknown>, RISK_TEXT_KEYS);
  return text ?? item;
}

/** Coerce the small set of common reviewer JSON quirks accepted historically. */
function coerceReviewJson(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['overall_verdict'] === 'string') {
    obj['overall_verdict'] = obj['overall_verdict'].toUpperCase();
  }
  if (Array.isArray(obj['assumptions'])) {
    obj['assumptions'] = obj['assumptions'].map(normalizeAssumptionEntry);
  }
  if (Array.isArray(obj['integration_risks'])) {
    obj['integration_risks'] = obj['integration_risks'].map(normalizeRiskEntry);
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
