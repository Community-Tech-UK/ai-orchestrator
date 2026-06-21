// ============ Conversational ping-pong review mode ============
//
// Types for the "ping-pong till done" loop mode (bigchange_pingpong_review):
// a builder model and a *different* full-agentic reviewer model push each other
// each round until mutual convergence (reviewer APPROVED + builder declares
// done) or a backstop fires. Kept in a dedicated file so `loop.types.ts` stays
// under its size ratchet; re-exported from `loop.types.ts`.

import type { LoopProvider } from './loop.types';

/** Severity rubric shared with the fresh-eyes reviewer findings. */
export type PingPongSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * What the reviewer is deep-diving this round. Inferred from the kickoff prompt
 * (intent classifier) and re-evaluated per round, with a manual override.
 */
export type PingPongSubject = 'plan' | 'impl';

/**
 * Authoritative reviewer verdict for a single ping-pong round. Convergence is
 * fail-closed: ONLY `APPROVED` can converge. `UNRELIABLE` (timeout, infra fail,
 * empty/unparseable output, or failed validity gate) never counts as a pass.
 */
export type PingPongReviewerVerdict =
  | 'APPROVED'
  | 'CHANGES_REQUESTED'
  | 'UNRELIABLE';

/**
 * When a round is `UNRELIABLE`, *why* — the crucial distinction between "the
 * reviewer tool couldn't deliver a verdict" and "the reviewer ran but its
 * output was unusable". The two must never be conflated: a throttled/unreachable
 * reviewer says NOTHING about the code's quality and must not masquerade as a
 * verdict, whereas a reviewer that runs and emits garbage is genuinely being an
 * unreliable *reviewer*.
 *
 * Availability faults (the first four) are transient/infrastructural — handled
 * by provider rotation + back-off + a lenient `reviewer-unavailable` terminal.
 * `malformed_output` is a reviewer-quality fault — handled by the stricter
 * `reviewer-unreliable` terminal.
 */
export type PingPongReviewerFault =
  /** No eligible reviewer provider could be resolved (pair exhausted / none installed). */
  | 'unavailable'
  /** Provider returned a usage/quota/rate-limit notice instead of a review (transient). */
  | 'rate_limited'
  /** Reviewer session exceeded its wall-clock budget. */
  | 'timeout'
  /** Spawn failed, the reviewer instance errored/crashed, or the manager was missing. */
  | 'infra_error'
  /** Reviewer ran but produced empty / unparseable / low-effort output. */
  | 'malformed_output';

/**
 * True for faults that mean "the reviewer was unavailable / transiently failing"
 * (an availability problem with the reviewer provider) rather than "the reviewer
 * produced bad output" (a reviewer-quality problem). Drives which terminal
 * status an exhausted run reaches.
 */
export function isReviewerAvailabilityFault(
  fault: PingPongReviewerFault | undefined,
): boolean {
  return (
    fault === 'unavailable' ||
    fault === 'rate_limited' ||
    fault === 'timeout' ||
    fault === 'infra_error'
  );
}

/**
 * Lifecycle of a single issue in the durable ledger. A fresh reviewer reads the
 * code cold each round but is handed the ledger and must classify each prior
 * issue, so settled points aren't blindly re-litigated and regressions are
 * caught.
 */
export type PingPongIssueStatus =
  | 'open'
  | 'resolved'
  | 'rebutted'
  | 'regression';

/** One durable issue tracked across rounds, OUTSIDE model context. */
export interface PingPongIssue {
  id: string;
  title: string;
  severity: PingPongSeverity;
  status: PingPongIssueStatus;
  /** Evidence citation (file:line + what was inspected). */
  evidence: string;
  file?: string;
  raisedRound: number;
  lastSeenRound: number;
  /** The builder's most recent response (fix summary or rebuttal). */
  builderResponse?: string;
}

/**
 * Per-loop ping-pong configuration. Lives under
 * `completion.crossModelReview.pingPong`. The behavioural switch is `enabled`
 * (NOT `reviewStyle`). Severity thresholds reuse the parent
 * `LoopCrossModelReviewConfig.blockingSeverities`.
 */
export interface LoopPingPongConfig {
  enabled: boolean;
  /**
   * Reviewer provider. `'auto'` resolves to any installed provider that is NOT
   * the builder's provider. A concrete value is hard-guarded against equalling
   * the builder provider.
   */
  reviewerProvider?: 'auto' | LoopProvider;
  /** Plan vs impl deep-dive. `'auto'` runs the intent classifier. */
  subject?: 'auto' | PingPongSubject;
  /** Hard cap on rounds. Default 15, clamped to 1..20. */
  maxRounds?: number;
  /** Spawn a brand-new reviewer instance each round (fresh eyes). Default true. */
  freshReviewerEachRound?: boolean;
}

export const PINGPONG_DEFAULT_MAX_ROUNDS = 15;
export const PINGPONG_MIN_MAX_ROUNDS = 1;
export const PINGPONG_MAX_MAX_ROUNDS = 20;

/** Clamp a requested ping-pong round cap into the supported range. */
export function clampPingPongMaxRounds(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return PINGPONG_DEFAULT_MAX_ROUNDS;
  }
  return Math.min(
    PINGPONG_MAX_MAX_ROUNDS,
    Math.max(PINGPONG_MIN_MAX_ROUNDS, Math.round(value)),
  );
}

export function defaultPingPongConfig(): LoopPingPongConfig {
  return {
    enabled: true,
    reviewerProvider: 'auto',
    subject: 'auto',
    maxRounds: PINGPONG_DEFAULT_MAX_ROUNDS,
    freshReviewerEachRound: true,
  };
}

/**
 * Mutable ping-pong runtime state, persisted alongside `LoopState` so a
 * mid-ping-pong restart resumes rather than loses the thread. On crash-restore,
 * `inFlightReviewerInstanceId`/`inFlightRound` must be reconciled (the round is
 * marked UNRELIABLE and re-run; never resumed pointing at a dead instance id).
 */
export interface LoopPingPongState {
  /** Completed rounds so far (each agentic review = one round). */
  roundCount: number;
  /** Resolved subject for the current round. */
  subject?: PingPongSubject;
  /** Durable issue ledger (see {@link PingPongIssue}). */
  ledger: PingPongIssue[];
  /** Reviewer instance currently mid-review (for crash reconciliation). */
  inFlightReviewerInstanceId?: string;
  /** Round number the in-flight reviewer belongs to. */
  inFlightRound?: number;
  /** Consecutive rounds whose reviewer verdict was UNRELIABLE. */
  consecutiveUnreliableRounds: number;
  /**
   * Consecutive rounds where the reviewer keeps blocking the SAME points and
   * the builder keeps rebutting them — deadlock heading to arbitration.
   */
  consecutiveContradictoryRounds: number;
  /**
   * Consecutive rounds where the builder declared done but did not address /
   * rebut any open finding.
   */
  builderUnaddressedRounds: number;
  /**
   * Consecutive rounds that produced only low-severity churn (no blocking
   * findings) — used by the anti-nitpick backstop to converge-or-arbitrate
   * instead of bickering forever over nits.
   */
  lowOnlyChurnRounds: number;
  /** Last reviewer provider actually used (for UI + fallback rotation). */
  lastReviewerProvider?: string;
  /** Providers already tried + failed this run (outage fallback rotation). */
  triedReviewerProviders?: string[];
  /** User asked to skip the next reviewer round. */
  skipNextRound?: boolean;
  /** User forced a jump to human arbitration. */
  forceArbitration?: boolean;
  /** Cumulative reviewer-side spend (folded into the loop budget). */
  reviewerTokensUsed: number;
  reviewerCostCents: number;
}

export function defaultPingPongState(): LoopPingPongState {
  return {
    roundCount: 0,
    ledger: [],
    consecutiveUnreliableRounds: 0,
    consecutiveContradictoryRounds: 0,
    builderUnaddressedRounds: 0,
    lowOnlyChurnRounds: 0,
    reviewerTokensUsed: 0,
    reviewerCostCents: 0,
  };
}
