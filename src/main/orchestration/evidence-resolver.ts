/**
 * Evidence Resolver — pure completion-decision module.
 *
 * Implements the evidence-precedence ladder described in
 * docs/plans/2026-05-28-first-class-remote-orchestration-plan.md (Piece B).
 *
 * This is a PURE module: no I/O, no side effects, no spawning. It consumes
 * evidence already gathered by the coordinator at the verify-before-stop seam
 * and returns a discriminated decision that the coordinator maps onto its
 * existing actions (state mutations, event emissions, terminal transitions).
 *
 * Authority tiers (ladder):
 *   1 — runtime truth (process death): handled elsewhere in the coordinator.
 *   2 — external ground-truth: verify passed + belt-and-braces + fresh-eyes clean.
 *       The ONLY tier that may auto-terminate the loop.
 *   3 — structured in-band intent: declared-complete (loop-control CLI).
 *       Tier-2 authority still required to stop; tier-3 elevates precedence.
 *   4 — forensic markers: rename / sentinel / checklist / done-promise / self-declared.
 *       Corroboration only; NEVER sufficient alone.
 *
 * The agent may NEVER self-declare terminal state without tier-2 authority.
 * When verify is unavailable (skipped), the correct terminal is
 * `stop-needs-review` (a SUCCESS state requesting a human), not silent stop.
 */

import type {
  CompletionSignalEvidence,
  CompletionSignalId,
  LoopCompletionOutcome,
} from '../../shared/types/loop.types';

// ============ Input / Output types ============

/**
 * Verify status — matches `VerifyOutcome['status']` from
 * `loop-completion-detector.ts` without importing that file (keeps this
 * module pure / dependency-free).
 */
export type VerifyStatus = 'passed' | 'failed' | 'skipped';

/** The result of the quick-verify pre-flight (FU-6). */
export type QuickVerifyStatus = 'passed' | 'failed' | 'skipped';

/**
 * All evidence the coordinator has gathered by the time it reaches
 * the completion-decision seam. The resolver does NOT run any I/O;
 * every field is already computed by the caller.
 */
export interface EvidenceInput {
  /** All signals observed by `LoopCompletionDetector.observe()` this iteration. */
  signals: CompletionSignalEvidence[];
  /**
   * The highest-priority sufficient signal (declared-complete preferred over
   * forensic signals). Present when `hasSufficientSignal()` returned true.
   * Undefined when there are no sufficient signals — in that case the
   * resolver returns `{ decision: 'continue', authorityTier: null }`.
   */
  candidate: CompletionSignalEvidence | undefined;
  /** Status of the optional quick-verify pre-flight (FU-6). */
  quickVerifyStatus: QuickVerifyStatus;
  /**
   * Status of the full verify run.
   * - 'passed'  — verify command exited 0 (both v1 and v2 when runVerifyTwice).
   * - 'failed'  — verify command exited non-zero or timed out.
   * - 'skipped' — no verifyCommand configured.
   */
  verifyStatus: VerifyStatus;
  /**
   * Which verify run produced the outcome (for logging / intervention text).
   * 'quick-verify' when the quick pre-flight failed; 'verify' otherwise.
   * Unused when verifyStatus is 'skipped'.
   */
  verifyLabel: 'verify' | 'quick-verify' | 'second-verify';
  /** Whether the belt-and-braces (*_Completed.md rename) gate passed. */
  beltAndBracesPassed: boolean;
  /** Whether the fresh-eyes cross-model review gate was run this attempt. */
  freshEyesRan: boolean;
  /** Count of blocking findings from the fresh-eyes review (0 if not ran). */
  freshEyesBlockingCount: number;
  /**
   * Whether the fresh-eyes reviewer threw an error (infra unavailable).
   * When true AND freshEyesBlockingCount is 0, the gate is treated as
   * non-blocking (per coordinator: "don't pin loop open on reviewer errors").
   */
  freshEyesErrored: boolean;
  /**
   * True when no verifyCommand is configured (loop is manual-review-only).
   * Used to select the correct terminal for the unverifiable case.
   */
  manualReviewOnly: boolean;
  /**
   * True when `allowOperatorReviewedCompletion` is set. Currently informational
   * (the coordinator treats both manualReviewOnly states the same at this seam),
   * but included for completeness / future differentiation.
   */
  allowOperatorReviewedCompletion: boolean;
  /**
   * Number of completion attempts where verify PASSED but the belt-and-braces
   * rename gate blocked. Incremented by the coordinator BEFORE calling the
   * resolver for the rename-gate case — so when the resolver sees this value,
   * it already includes the current attempt.
   */
  completionAttempts: number;
  /** Budget: max attempts before the loop accepts as completed-needs-review. */
  maxCompletionAttempts: number;
}

/** Possible decisions the resolver can return. */
export type EvidenceDecision =
  /** Keep iterating — the current attempt was rejected. */
  | 'continue'
  /**
   * Stop with status=completed. Requires tier-2 authority (verify passed +
   * belt-and-braces + fresh-eyes clean).
   */
  | 'stop'
  /**
   * Stop with status=completed-needs-review. A SUCCESS state: either the
   * loop has no verify command (unverifiable, needs operator sign-off), or
   * verify kept passing but the rename gate was exhausted.
   */
  | 'stop-needs-review'
  /**
   * Pause for operator review (status=paused). Used when verify is skipped
   * (unverifiable) — the operator must manually accept or inspect the work.
   */
  | 'pause-operator-review';

/**
 * Discriminated resolution returned by `resolveCompletion`.
 */
export interface EvidenceResolution {
  decision: EvidenceDecision;
  /**
   * The authority tier that drove the decision. Null when there was no
   * sufficient signal (no-op path).
   */
  authorityTier: 1 | 2 | 3 | 4 | null;
  /** The LoopCompletionOutcome to record on state.lastCompletionOutcome. */
  outcome: LoopCompletionOutcome | null;
  /**
   * The signal id of the candidate that was evaluated. Null when no sufficient
   * signal was present.
   */
  signalId: CompletionSignalId | null;
  /**
   * Human-readable reason for the decision, suitable for use in log messages,
   * intervention text, or convergenceNotes. Empty string for the no-op path.
   */
  reason: string;
  /**
   * When decision === 'stop-needs-review', the full human-readable reason
   * suitable for the `loop:completed-needs-review` event and terminal state.
   * Null for all other decisions.
   */
  needsReviewReason: string | null;
  /**
   * Short obstacle note for convergenceNotes (used by describeCapReason).
   * Null when no obstacle note is appropriate (accepted completion, no signal).
   */
  convergenceNote: string | null;
}

/**
 * Determine the authority tier of a signal id. Declared-complete is tier 3
 * (structured in-band intent); all others are tier 4 (forensic markers).
 */
function signalTier(id: CompletionSignalId): 3 | 4 {
  return id === 'declared-complete' ? 3 : 4;
}

/**
 * Resolve the completion decision from fully-gathered evidence.
 *
 * This is a pure function — call it with all evidence already in hand and
 * map the returned decision onto coordinator actions (state mutations, event
 * emissions) without running any I/O inside this function.
 *
 * The decision follows the evidence-precedence ladder:
 *   1. No sufficient signal → continue (no-op).
 *   2. quick-verify failed → continue (verify-failed).
 *   3. full verify failed → continue (verify-failed).
 *   4. verify skipped → pause-operator-review (unverifiable).
 *   5. verify passed + belt-and-braces failed:
 *        budget remaining → continue (rename-gate).
 *        budget exhausted → stop-needs-review (rename-gate).
 *   6. verify passed + belt-and-braces passed + fresh-eyes blocking → continue (review-blocked).
 *   7. verify passed + belt-and-braces passed + fresh-eyes clean → stop (accepted).
 */
export function resolveCompletion(input: EvidenceInput): EvidenceResolution {
  // --- No sufficient signal: nothing to decide ---
  if (!input.candidate) {
    return {
      decision: 'continue',
      authorityTier: null,
      outcome: null,
      signalId: null,
      reason: '',
      needsReviewReason: null,
      convergenceNote: null,
    };
  }

  const { candidate } = input;
  const tier = signalTier(candidate.id);

  // --- Quick-verify failed (FU-6 pre-flight) ---
  if (input.quickVerifyStatus === 'failed') {
    return {
      decision: 'continue',
      authorityTier: tier,
      outcome: 'verify-failed',
      signalId: candidate.id,
      reason: 'quick verify failed — skipping full verify',
      needsReviewReason: null,
      convergenceNote: 'quick verify failed',
    };
  }

  // --- Full verify failed ---
  if (input.verifyStatus === 'failed') {
    const label = input.verifyLabel === 'second-verify' ? 'second verify' : input.verifyLabel;
    return {
      decision: 'continue',
      authorityTier: tier,
      outcome: 'verify-failed',
      signalId: candidate.id,
      reason: `${label} failed`,
      needsReviewReason: null,
      convergenceNote: `${label} failed`,
    };
  }

  // --- Verify skipped (no verifyCommand) ---
  if (input.verifyStatus === 'skipped') {
    // No tier-2 authority available — cannot auto-complete. Pause for operator.
    return {
      decision: 'pause-operator-review',
      authorityTier: tier,
      outcome: 'unverifiable',
      signalId: candidate.id,
      reason: 'completion not verified — no verify command configured',
      needsReviewReason: null,
      convergenceNote: 'completion was unverifiable (no verify command configured)',
    };
  }

  // --- Verify passed ---
  // Now check the secondary gates (belt-and-braces, then fresh-eyes).

  // Belt-and-braces gate (rename gate)
  if (!input.beltAndBracesPassed) {
    // The coordinator already incremented completionAttempts before calling us.
    if (input.completionAttempts >= input.maxCompletionAttempts) {
      const needsReviewReason =
        `Verify passed but the required *_Completed.md rename never happened across ` +
        `${input.completionAttempts} completion attempt(s). The work verifies clean — ` +
        'accepting as completed-needs-review for a human glance. Rename the plan file(s) ' +
        'to *_Completed.md to auto-complete next time.';
      return {
        decision: 'stop-needs-review',
        authorityTier: tier,
        outcome: 'rename-gate',
        signalId: candidate.id,
        reason: needsReviewReason,
        needsReviewReason,
        convergenceNote: null,
      };
    }
    return {
      decision: 'continue',
      authorityTier: tier,
      outcome: 'rename-gate',
      signalId: candidate.id,
      reason: `completed-file rename gate did not pass (attempt ${input.completionAttempts}/${input.maxCompletionAttempts})`,
      needsReviewReason: null,
      convergenceNote: 'completed-file rename gate did not pass',
    };
  }

  // Fresh-eyes review gate
  if (input.freshEyesRan && input.freshEyesBlockingCount > 0 && !input.freshEyesErrored) {
    return {
      decision: 'continue',
      authorityTier: tier,
      outcome: 'review-blocked',
      signalId: candidate.id,
      reason: `fresh-eyes review blocked completion (${input.freshEyesBlockingCount} blocking finding(s))`,
      needsReviewReason: null,
      convergenceNote: null, // coordinator sets this itself with reviewer details
    };
  }

  // All gates passed — tier-2 authority confirmed.
  return {
    decision: 'stop',
    authorityTier: 2,
    outcome: 'accepted',
    signalId: candidate.id,
    reason: `completion accepted via ${candidate.id}`,
    needsReviewReason: null,
    convergenceNote: null,
  };
}
