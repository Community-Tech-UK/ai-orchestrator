/**
 * WS5 (loop-convergence plan) — side-effect-aware degraded-retry decisions.
 *
 * A failed/degraded iteration used to be replayed blind: the coordinator
 * retried the same seq with a fresh session whether or not the failed attempt
 * had already written into the workspace. A retry over unproven side effects
 * can double-apply work (the respawn-wedge incidents) — so an automatic replay
 * is now allowed ONLY when the orchestrator can prove the attempt made no
 * workspace writes.
 *
 * Evidence contract: the invoker captures a workspace snapshot before every
 * attempt and computes the delta in its error path too (try/finally shaped) —
 * `none-observed` means the available observers COMPLETED and found no delta;
 * an observer failure or a throw that bypassed the invoker (hung-CLI timeout in
 * loop-child-invoker) is `unknown`, never `none-observed`. Emitted bytes are
 * NOT proof of no side effects — only the workspace observation is.
 *
 * Retry matrix (plan §WS5):
 *   degraded/failed + none-observed + budget left  → bounded retry
 *                                                     (preserve the native
 *                                                     thread when reusable)
 *   degraded/failed + writes-observed              → seal evidence, pause as
 *                                                     completed-needs-review
 *   degraded/failed + unknown                      → pause for review
 *   context overflow + none-observed               → one bounded fresh-context
 *                                                     recovery (route seam)
 *   circuit breaker open (no attempt ran)          → existing backoff (handled
 *                                                     before this decision)
 *
 * Pure module — no I/O — shared by the coordinator retry loop and its tests.
 */

import type { LoopFileChange } from '../../shared/types/loop-state.types';

export type LoopWorkspaceEffect = 'none-observed' | 'writes-observed' | 'unknown';

export interface LoopInvocationAttemptEvidence {
  outcome: 'completed' | 'degraded' | 'failed';
  /** Bounded excerpt of the attempt's output or error message. */
  outputExcerpt: string;
  workspaceEffect: LoopWorkspaceEffect;
  /** Bounded observed changes (empty for none-observed/unknown). */
  filesChanged: LoopFileChange[];
  /** True when the provider-native thread survived and can be continued. */
  providerThreadReusable: boolean;
  /** Degradation reason / observer-failure note. */
  reason?: string;
}

/** Cap applied to evidence file lists and reason path lists. */
export const ATTEMPT_EVIDENCE_MAX_FILES = 50;
/** Cap applied to attempt output/error excerpts. */
export const ATTEMPT_EVIDENCE_EXCERPT_CHARS = 500;

/**
 * Build attempt evidence from a completed (successful-shape) child result that
 * predates the invoker attaching evidence explicitly. Legitimate because a
 * returned result means the invoker's workspace observation completed —
 * `filesChanged` IS the observed delta.
 */
export function deriveAttemptEvidenceFromResult(result: {
  output: string;
  filesChanged: LoopFileChange[];
  degradedReason?: string;
}): LoopInvocationAttemptEvidence {
  return {
    outcome: result.degradedReason ? 'degraded' : 'completed',
    outputExcerpt: result.output.slice(0, ATTEMPT_EVIDENCE_EXCERPT_CHARS),
    workspaceEffect: result.filesChanged.length > 0 ? 'writes-observed' : 'none-observed',
    filesChanged: result.filesChanged.slice(0, ATTEMPT_EVIDENCE_MAX_FILES),
    providerThreadReusable: false,
    ...(result.degradedReason ? { reason: result.degradedReason } : {}),
  };
}

/** Evidence for a throw that bypassed the invoker's own error path (e.g. the
 * coordinator-side iteration timeout on a hung CLI). Nothing observed the
 * workspace, so the effect is unknown — never assumed clean. */
export function unknownAttemptEvidence(reason: string): LoopInvocationAttemptEvidence {
  return {
    outcome: 'failed',
    outputExcerpt: reason.slice(0, ATTEMPT_EVIDENCE_EXCERPT_CHARS),
    workspaceEffect: 'unknown',
    filesChanged: [],
    providerThreadReusable: false,
    reason,
  };
}

/**
 * Resolve the attempt evidence at the coordinator's retry seam. A returned
 * result carries invoker-attached evidence (or derives it — a returned result
 * means the delta observation completed); a throw that bypassed the invoker
 * (hung-CLI timeout) is UNKNOWN, never assumed clean.
 */
export function resolveAttemptEvidence(
  childResult: { output: string; filesChanged: LoopFileChange[]; degradedReason?: string; attemptEvidence?: LoopInvocationAttemptEvidence } | null,
  invocationFailure: unknown,
  invocationError: string | null,
): LoopInvocationAttemptEvidence {
  if (childResult) {
    return childResult.attemptEvidence ?? deriveAttemptEvidenceFromResult(childResult);
  }
  const carried = (invocationFailure as { attemptEvidence?: LoopInvocationAttemptEvidence } | null)?.attemptEvidence;
  return carried ?? unknownAttemptEvidence(invocationError ?? 'iteration invocation failed before evidence capture');
}

/** Content persisted into `LoopState.endEvidence` when an attempt-review pause seals a run. */
export function buildAttemptReviewEndEvidence(
  evidence: LoopInvocationAttemptEvidence,
  seq: number,
): Record<string, unknown> {
  return {
    attemptOutcome: evidence.outcome,
    workspaceEffect: evidence.workspaceEffect,
    changedPaths: evidence.filesChanged.map((change) => change.path),
    ...(evidence.reason ? { attemptReason: evidence.reason } : {}),
    pausedIterationSeq: seq,
  };
}

export type DegradedRetryDecision =
  | { action: 'proceed' }
  | { action: 'retry'; preserveThread: boolean; note: string }
  | { action: 'pause-review'; reason: string };

/**
 * Decide what to do with a degraded/failed attempt. Consulted AFTER the
 * terminal-intent / parked / classified-route / circuit-breaker branches, and
 * only while degraded retries are enabled — `proceed` always means "fall
 * through to the existing error/normal-processing path".
 */
export function decideDegradedRetry(input: {
  evidence: LoopInvocationAttemptEvidence;
  /** Classifier output for this attempt (null = not degraded). */
  degradedReason: string | null;
  attemptsSoFar: number;
  maxRetries: number;
}): DegradedRetryDecision {
  if (!input.degradedReason) return { action: 'proceed' };
  const effect = input.evidence.workspaceEffect;

  if (effect === 'writes-observed') {
    const paths = input.evidence.filesChanged
      .slice(0, 8)
      .map((change) => change.path)
      .join(', ');
    return {
      action: 'pause-review',
      reason:
        `Degraded iteration (${input.degradedReason}) already wrote into the workspace — `
        + `automatic replay could double-apply work. Changed: ${paths || '(paths unavailable)'}`
        + `${input.evidence.filesChanged.length > 8 ? ` (+${input.evidence.filesChanged.length - 8} more)` : ''}. `
        + `Paused for review instead of replaying.`,
    };
  }

  if (effect === 'unknown') {
    return {
      action: 'pause-review',
      reason:
        `Degraded iteration (${input.degradedReason}) with UNPROVABLE workspace state — `
        + `${input.evidence.reason ?? 'the workspace observers did not complete'}. `
        + `Automatic replay is unsafe without proof of no side effects; paused for review.`,
    };
  }

  // none-observed: the observers completed and found no delta — replay is safe.
  if (input.attemptsSoFar >= input.maxRetries) return { action: 'proceed' };
  return {
    action: 'retry',
    preserveThread: input.evidence.providerThreadReusable,
    note: input.evidence.providerThreadReusable
      ? 'no workspace writes observed — retrying on the surviving native thread'
      : 'no workspace writes observed — retrying with a fresh session',
  };
}
