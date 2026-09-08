/**
 * Fresh-eyes review bookkeeping carried on `LoopState`.
 *
 * Split out of `loop-state.types.ts` to keep that file under the LOC ratchet;
 * these five declarations are one coherent cluster (what a review attempt was
 * shown, which angles it covered, and what may be reused from cache) and have
 * no dependency on the rest of the loop state. `loop-state.types.ts` re-exports
 * them, so existing import sites are unchanged.
 */
import type { ReviewResult } from './cross-model-review.types';

/**
 * WS-A3: a durably persisted copy of material a fresh-eyes review attempt
 * actually saw (the diff, or the verify-output excerpt). Findings raised
 * against that attempt cite quotes that `review-artifact-anchor.ts` checks
 * against this record — the completion gate only trusts a severity-blocking
 * finding when its quote is verifiable here.
 *
 * Persisted as part of `LoopState.reviewArtifacts` (JSON-serialized wholesale
 * with the rest of the checkpoint — see `loop-checkpoint.ts` / `loop-store-
 * checkpoints.ts`), so no dedicated DB migration is needed. Bounded by
 * `MAX_TRACKED_REVIEW_ARTIFACTS` in `review-artifact-anchor.ts` and never
 * broadcast to the renderer (stripped in `cloneLoopStateForBroadcast`).
 */
export interface LoopReviewArtifactEntry {
  reviewAttemptId: string;
  iterationSeq: number;
  artifactType: 'diff' | 'output';
  /** sha256 of the FULL content, computed before any storage bound is applied. */
  artifactHash: string;
  /** Bounded to `MAX_REVIEW_PAYLOAD_CHARS`-order size; may be a prefix of what was hashed. */
  content: string;
  createdAt: number;
}

/**
 * WS-B9: outcome of one intended reviewer/angle within a single fresh-eyes
 * review attempt. `cached` and `parse_failed` are split out from the older
 * generic `used`/`skipped`/`failed` trio so a reused-from-cache angle and a
 * reviewer whose output couldn't be parsed are each independently visible —
 * see `review-coverage.ts`.
 */
export type LoopReviewCoverageStatus = 'used' | 'cached' | 'skipped' | 'failed' | 'parse_failed';

/**
 * WS-B9: coverage record for a single intended reviewer/angle within one
 * fresh-eyes review attempt. `required` angles that end up anything other
 * than `used`/`cached` force the gate's verdict to not-clean via the same
 * `errored` fail-closed path an unavailable reviewer already took (see
 * `runFreshEyesReviewGate` in `loop-coordinator-completion-gates.ts`). Today
 * every remote structured/tiered reviewer angle dispatched this attempt is
 * `required`; the single advisory local-model pass is not (mirrors
 * `FreshEyesFinding.advisory` — a local-only finding already cannot block
 * completion). See `review-coverage.ts` for the honest documentation of why
 * this is the de-facto default rather than a richer required/advisory config.
 */
export interface LoopReviewAngleCoverageEntry {
  /** `ReviewAngle.id` (`correctness`/`security`/`completeness`/`regressions`), or
   *  `'local-advisory'` for the single local-model pass, which has no angle. */
  angle: string;
  reviewerProvider?: string;
  model?: string;
  status: LoopReviewCoverageStatus;
  /** Why this status happened — cache hit reason, failure/parse-failure reason, skip reason. */
  activationReason?: string;
  /** Raw (pre-aggregation, pre-anchor) finding count this reviewer/angle produced. 0 when not `used`/`cached`. */
  findingCount: number;
  required: boolean;
}

/**
 * WS-B9: full coverage record for one fresh-eyes review attempt, persisted
 * alongside `LoopReviewArtifactEntry` on the same `reviewAttemptId` key and
 * the same eviction discipline (bounded, insertion-order trimmed — see
 * `review-coverage.ts` / `MAX_TRACKED_REVIEW_COVERAGE_REPORTS`). Never
 * broadcast to the renderer directly; a lightweight `coverage` array rides
 * the `loop:fresh-eyes-review-*` IPC events instead (mirrors how
 * `reviewArtifacts` itself is stripped but individual findings still carry
 * their evidence fields on those same events).
 */
export interface LoopReviewCoverageReport {
  reviewAttemptId: string;
  createdAt: number;
  angles: LoopReviewAngleCoverageEntry[];
  /** Every `required` angle ended `used` or `cached`. See `computeRequiredCoverageMet`. */
  requiredCoverageMet: boolean;
}

/**
 * WS-B9: a successful angle's cached reviewer verdict, keyed on
 * {schema version, prompt version, reviewer+model, angle, rules hash,
 * redacted artifact work hash} — see `buildAngleCacheKey` in
 * `review-coverage.ts`. Never stored for a failed/parse_failed angle.
 * `review` omits `rawResponse` (large, cache-irrelevant — the parsed
 * structured verdict is all a later attempt needs to reconstruct findings).
 * A cache HIT reuses `review` verbatim, but the consuming pipeline always
 * re-derives `anchorStatus` for each of its findings against the CURRENT
 * attempt's persisted diff artifact (see `review-artifact-anchor.ts`) — a
 * cache hit can never skip evidence re-verification, so a cached blocking
 * finding whose citation no longer anchors still demotes per WS-A3 semantics.
 */
export interface LoopReviewAngleCacheEntry {
  cacheKey: string;
  angle: string;
  reviewerProvider: string;
  model?: string;
  review: Omit<ReviewResult, 'rawResponse'>;
  cachedAt: number;
}
