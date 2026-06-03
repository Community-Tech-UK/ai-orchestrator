/**
 * Degraded Output Classifier
 *
 * Pure, stateless classifier that detects adapter-layer degraded output signals.
 * This is a defense-in-depth layer below the coordinator-level
 * `classifyDegradedIteration` that already exists in loop-coordinator.
 *
 * IMPORTANT: This feature ships OFF by default (`detectDegradedAdapterOutput`
 * setting defaults to `false`). Thresholds are conservative to minimize false
 * positives on healthy streams. The output of this classifier is a tag on
 * `CliResponse.degradedReason` — callers decide what to do with it.
 *
 * Validation note: thresholds here are NOT validated against a real degraded
 * harness. They are conservative estimates intended to be tuned once the feature
 * flag is enabled and real degraded streams can be observed.
 * See: docs/plans/2026-05-30-loop-adapter-degraded-output-detection.md
 */

/**
 * Classification of why a response is considered degraded.
 *
 * - `'delayed'`         — The stream took significantly longer than normal and
 *                         produced little/no content (stream-idle timeout fired
 *                         or elapsed time >> content size).
 * - `'synthetic'`       — Content matches known synthetic/replay patterns:
 *                         suspiciously round character counts, repeated
 *                         boilerplate, or zero-length output on a non-cancelled
 *                         path.
 * - `'cancelled'`       — The process was explicitly cancelled/interrupted and
 *                         the partial output is incomplete.
 * - `'duplicate-stale'` — Content appears identical to a previously-seen
 *                         response for the same prompt (duplicate-of-prior flag
 *                         set by the caller with content hash comparison).
 * - `'partial-replay'`  — Content looks like a replay of a prior assistant
 *                         message rather than a fresh response (high similarity
 *                         ratio flagged by caller).
 */
export type DegradedReason =
  | 'delayed'
  | 'synthetic'
  | 'cancelled'
  | 'duplicate-stale'
  | 'partial-replay';

/**
 * Plain-data signals passed into the classifier.
 * No live streams, no singletons — keeps the function pure and unit-testable.
 */
export interface DegradedOutputSignals {
  /**
   * Content length in characters (after any externalization). Use the raw buffer
   * length before externalization when possible; `0` is always meaningful.
   */
  contentLength: number;

  /**
   * Elapsed wall-clock milliseconds from when the process was spawned (or from
   * the first-byte timestamp) to when the response was finalized.
   */
  elapsedMs: number;

  /**
   * True if the stream idle watchdog fired during this response (no stdout for
   * `streamIdleTimeoutMs` ms). The adapter sets this flag before calling the
   * classifier.
   */
  streamIdleFired: boolean;

  /**
   * True if the process was killed / cancelled / interrupted mid-response.
   * The adapter sets this flag from its termination path.
   */
  cancelled: boolean;

  /**
   * True if the caller detected that this response's content is byte-for-byte
   * identical to a prior response for the same session (e.g. content hash match).
   */
  duplicateOfPrior: boolean;

  /**
   * 0–1 similarity ratio of this content to the most-recent prior assistant
   * message. 0 = completely different (or no prior), 1 = identical.
   * The caller is responsible for computing this (e.g. normalized edit distance).
   * Undefined means "caller did not measure".
   */
  similarityToPrior?: number;

  /**
   * Ratio of whitespace/empty characters to total content (0–1).
   * A value close to 1 indicates nearly empty output.
   * Undefined if content length is 0 (avoid division-by-zero at the caller).
   */
  emptinessRatio?: number;
}

/**
 * Result of classifying a set of output signals.
 */
export interface DegradedOutputClassification {
  /**
   * Whether the output is classified as degraded. When false, reason is absent.
   */
  degraded: boolean;
  /**
   * The specific reason, present only when `degraded` is true.
   */
  reason?: DegradedReason;
}

// ============ Thresholds ============
// These are conservative to minimize false positives on healthy streams.
// Tune these after observing real degraded-harness data.

/** Minimum elapsed ms before a zero-length response is 'delayed'. */
const DELAY_THRESHOLD_MS = 5_000;

/**
 * Elapsed ms beyond which a response that produced < MIN_MEANINGFUL_CHARS is
 * considered 'delayed' even if not strictly zero-length.
 */
const LONG_DELAY_THRESHOLD_MS = 30_000;

/** Content shorter than this combined with LONG_DELAY_THRESHOLD_MS = delayed. */
const MIN_MEANINGFUL_CHARS = 50;

/**
 * Similarity ratio (0–1) above which content is considered a partial-replay
 * of a prior message. 0.95 = 95% similar — very conservative to avoid false
 * positives on genuinely similar but valid follow-ups.
 */
const PARTIAL_REPLAY_SIMILARITY_THRESHOLD = 0.95;

/**
 * Emptiness ratio (0–1) above which non-cancelled zero-content output is
 * considered 'synthetic' (e.g. whitespace-only shell hallucination).
 */
const SYNTHETIC_EMPTINESS_THRESHOLD = 0.95;

// ============ Classifier ============

/**
 * Classify whether a set of output signals indicate a degraded response.
 *
 * This function is pure: given the same inputs it always returns the same
 * output, has no side effects, and does not import any module-level singletons.
 *
 * Priority order when multiple signals fire: cancelled > duplicate-stale >
 * partial-replay > delayed > synthetic.
 */
export function classifyDegradedOutput(
  signals: DegradedOutputSignals,
): DegradedOutputClassification {
  // 1. Explicitly cancelled/interrupted — partial output is expected to be
  //    incomplete. Flag early so downstream can decide whether to retry.
  if (signals.cancelled) {
    return { degraded: true, reason: 'cancelled' };
  }

  // 2. Byte-for-byte duplicate of a prior response — stale replay.
  if (signals.duplicateOfPrior) {
    return { degraded: true, reason: 'duplicate-stale' };
  }

  // 3. Very high similarity to prior — partial replay even if not identical.
  if (
    signals.similarityToPrior !== undefined &&
    signals.similarityToPrior >= PARTIAL_REPLAY_SIMILARITY_THRESHOLD
  ) {
    return { degraded: true, reason: 'partial-replay' };
  }

  // 4. Stream idle watchdog fired — process was alive but silent for too long.
  //    Combined with near-zero content, this indicates a frozen/stalled stream.
  if (signals.streamIdleFired && signals.contentLength < MIN_MEANINGFUL_CHARS) {
    return { degraded: true, reason: 'delayed' };
  }

  // 5. Abnormally long elapsed time with nearly no content (without idle watchdog).
  if (
    signals.elapsedMs >= LONG_DELAY_THRESHOLD_MS &&
    signals.contentLength < MIN_MEANINGFUL_CHARS
  ) {
    return { degraded: true, reason: 'delayed' };
  }

  // 6. Extremely short response with very high elapsed time even at lower threshold
  //    — covers cold-start or RPC-timeout paths that stall then return empty.
  if (
    signals.contentLength === 0 &&
    signals.elapsedMs >= DELAY_THRESHOLD_MS
  ) {
    return { degraded: true, reason: 'delayed' };
  }

  // 7. Non-cancelled near-empty output with high whitespace/emptiness ratio
  //    — synthetic / shell hallucination pattern.
  if (
    signals.contentLength > 0 &&
    signals.emptinessRatio !== undefined &&
    signals.emptinessRatio >= SYNTHETIC_EMPTINESS_THRESHOLD
  ) {
    return { degraded: true, reason: 'synthetic' };
  }

  // No degraded signal detected.
  return { degraded: false };
}
