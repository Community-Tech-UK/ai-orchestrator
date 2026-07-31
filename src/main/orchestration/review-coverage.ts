/**
 * WS-B9: exact reviewer/angle coverage tracking + a per-angle reviewer-verdict
 * cache for the fresh-eyes review gate.
 *
 * ## What an "angle" is in this codebase
 * `review-prompts.ts` defines a fixed set of {@link ReviewAngle}s
 * (`correctness`/`security`/`completeness`/`regressions`). `angleForReviewer`
 * deterministically assigns one to each dispatched reviewer BY INDEX (wraps
 * if there are more reviewers than angles). The reviewer LIST itself is
 * resolved dynamically per attempt (explicit `crossModelReview.reviewers`
 * config, or `CrossModelReviewService`'s CLI-availability pool) — there is no
 * fixed, config-declared "required reviewer set" anywhere in this codebase.
 *
 * The honest coverage model this module implements: every remote
 * structured/tiered reviewer dispatched THIS attempt is `required` (its angle
 * must end `used` or `cached`, or the attempt cannot be a clean pass); the
 * single advisory local-model pass (no angle assignment, findings always
 * `advisory: true` — see `loop-fresh-eyes-reviewer.ts`) is never required.
 * This mirrors the pre-existing "zero reviewers used → not a clean pass"
 * fail-closed rule in `runFreshEyesReviewGate`
 * (`loop-coordinator-completion-gates.ts`) — WS-B9 generalizes it from
 * "all reviewers absent" to "any REQUIRED reviewer/angle absent".
 *
 * ## Cache key composition
 * {@link buildAngleCacheKey} hashes: `REVIEW_SCHEMA_VERSION`, the angle's
 * prompt-template version (`promptVersionForAngle` in `review-prompts.ts` —
 * changes whenever the angle's wording or the shared prompt shape changes),
 * the reviewer provider + model, the angle id, a rules hash, and the redacted
 * artifact work hash (sha256 of the exact egress-redacted, truncated review
 * payload this attempt's reviewers are shown). Survey note: no task/project
 * "rules" doc feeds review prompts anywhere in this codebase today (only
 * `taskDescription` + the reviewed content) — `rulesHash` is a fixed
 * placeholder so the key composition is future-proof without fabricating a
 * feature; introducing real rules-in-prompt content would need only a real
 * hash to slot into the existing key shape.
 *
 * Any component changing invalidates the key — a fresh workHash after an
 * edit is the common case, but a prompt-template edit or a reviewer-model
 * override change invalidate it too.
 */

import { createHash } from 'node:crypto';
import type {
  LoopReviewAngleCacheEntry,
  LoopReviewAngleCoverageEntry,
  LoopReviewCoverageReport,
  LoopState,
} from '../../shared/types/loop.types';
import type { ReviewResult } from '../../shared/types/cross-model-review.types';
import type { HeadlessReviewAngleCacheHook } from '../review/review-execution-host';

/** Bumped whenever the coverage/cache record shape changes incompatibly. */
export const REVIEW_SCHEMA_VERSION = 1;

/** No task/project "rules" doc feeds review prompts today — see module doc. */
export const NO_RULES_HASH = 'none';

/** Angle id used for the single advisory local-model pass, which has no `ReviewAngle`. */
export const LOCAL_ADVISORY_ANGLE = 'local-advisory';

/** Mirrors `MAX_TRACKED_REVIEW_ARTIFACTS` in `review-artifact-anchor.ts`. */
export const MAX_TRACKED_REVIEW_COVERAGE_REPORTS = 6;

/** Angles are far smaller than diff/output artifacts; allow more entries across a run's attempts. */
export const MAX_TRACKED_REVIEW_ANGLE_CACHE_ENTRIES = 32;

/**
 * Evict the oldest entries beyond `max`, keyed on insertion order (see
 * `trimReviewArtifacts` in `review-artifact-anchor.ts` for why insertion
 * order, not `createdAt`/`cachedAt`, is the stable eviction key).
 */
function trimBoundedRecord<T>(entries: Record<string, T>, max: number): Record<string, T> {
  const keys = Object.keys(entries);
  if (keys.length <= max) return entries;
  const kept = keys.slice(keys.length - max);
  const result: Record<string, T> = {};
  for (const key of kept) result[key] = entries[key];
  return result;
}

export function persistReviewCoverageReport(state: LoopState, report: LoopReviewCoverageReport): void {
  const entries = { ...state.reviewCoverageReports, [report.reviewAttemptId]: report };
  state.reviewCoverageReports = trimBoundedRecord(entries, MAX_TRACKED_REVIEW_COVERAGE_REPORTS);
}

export function getReviewCoverageReport(
  state: LoopState,
  reviewAttemptId: string,
): LoopReviewCoverageReport | undefined {
  return state.reviewCoverageReports?.[reviewAttemptId];
}

/**
 * Every `required` angle ended `used` or `cached`. Vacuously `true` when
 * there are no required angles at all (nothing to fall short of) — the
 * caller's pre-existing "zero reviewers used" check already fail-closes that
 * case independently; this function only judges the angles it is given.
 */
export function computeRequiredCoverageMet(angles: readonly LoopReviewAngleCoverageEntry[]): boolean {
  const required = angles.filter((a) => a.required);
  if (required.length === 0) return true;
  return required.every((a) => a.status === 'used' || a.status === 'cached');
}

export interface AngleCacheKeyInput {
  promptVersion: string;
  reviewerProvider: string;
  model: string;
  angleId: string;
  rulesHash: string;
  workHash: string;
}

export function buildAngleCacheKey(input: AngleCacheKeyInput): string {
  const material = [
    REVIEW_SCHEMA_VERSION,
    input.promptVersion,
    input.reviewerProvider,
    input.model,
    input.angleId,
    input.rulesHash,
    input.workHash,
  ].join(':');
  return createHash('sha256').update(material).digest('hex');
}

export function getCachedAngle(state: LoopState, cacheKey: string): LoopReviewAngleCacheEntry | undefined {
  return state.reviewAngleCache?.[cacheKey];
}

export function storeCachedAngle(state: LoopState, input: {
  cacheKey: string;
  angle: string;
  reviewerProvider: string;
  model?: string;
  review: ReviewResult;
}): void {
  // Defensively strip `rawResponse` even though the caller may pass a full
  // `ReviewResult` — see `LoopReviewAngleCacheEntry` doc: it is large and
  // cache-irrelevant, so it must never actually reach persisted state.
  const { rawResponse: _rawResponse, ...review } = input.review;
  const entry: LoopReviewAngleCacheEntry = {
    cacheKey: input.cacheKey,
    angle: input.angle,
    reviewerProvider: input.reviewerProvider,
    ...(input.model ? { model: input.model } : {}),
    review,
    cachedAt: Date.now(),
  };
  const entries = { ...state.reviewAngleCache, [input.cacheKey]: entry };
  state.reviewAngleCache = trimBoundedRecord(entries, MAX_TRACKED_REVIEW_ANGLE_CACHE_ENTRIES);
}

/**
 * Build the per-angle cache hook bound to one loop's `LoopState`, for a
 * single `runFreshEyesReviewGate` call (`loop-coordinator-completion-
 * gates.ts`). `lookup`/`store` receive raw key components — the hook itself
 * computes the composite key via `buildAngleCacheKey` so callers never
 * duplicate that logic.
 */
export function buildReviewAngleCacheHook(state: LoopState): HeadlessReviewAngleCacheHook {
  return {
    lookup: (input) => {
      const entry = getCachedAngle(state, buildAngleCacheKey(input));
      if (!entry) return undefined;
      return {
        review: entry.review,
        activationReason:
          'reused a cached clean angle — schema, prompt, reviewer/model, angle, and reviewed content are unchanged since the last review attempt',
      };
    },
    store: (input) => {
      storeCachedAngle(state, {
        cacheKey: buildAngleCacheKey(input),
        angle: input.angleId,
        reviewerProvider: input.reviewerProvider,
        model: input.model,
        review: input.review,
      });
    },
  };
}
