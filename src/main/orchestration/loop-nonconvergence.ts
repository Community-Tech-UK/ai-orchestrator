/**
 * L6 / L14 — name why a loop is not converging, and park a leaf that cannot be.
 *
 * Today every stall collapses into one word: `no-progress`. That is true and
 * useless. "The reviewer keeps raising the same finding", "the work is done but
 * uncommitted", and "the agent has quietly widened the goal" need different
 * responses from a human, and telling them apart costs nothing — the evidence
 * is already on the state.
 *
 * The second half is L14's terminal policy. Once auto-unstick has spent its two
 * attempts on the SAME leaf with a contradiction reason, continuing is just
 * paying the scaffold again on every iteration until the cap. Park that leaf
 * with a reason and let the run continue on the rest; never drop the work
 * (storybloq parks by writing a refused artifact, it does not delete).
 */

import type { LoopNonConvergenceReason, LoopParkedLeaf, LoopState } from '../../shared/types/loop.types';
import { getLogger } from '../logging/logger';
import { recordLoopLearningForState } from './loop-learning-recorder';
import { AUTO_UNSTICK_ELIGIBLE_SIGNALS, AUTO_UNSTICK_MAX_ATTEMPTS } from './loop-auto-unstick';

const logger = getLogger('LoopNonConvergence');

export type { LoopNonConvergenceReason };

/**
 * A named non-convergence diagnosis. Ordered most-specific first: a run can
 * satisfy several, and the most actionable one is the one worth surfacing.
 */
export interface NonConvergenceInput {
  /** Distinct blocking findings that have persisted across reviewer rounds. */
  persistedReviewFindings: number;
  /** Reviewer rounds run this convergence attempt. */
  reviewRounds: number;
  /** Verify passed on the most recent attempt. */
  verifyPassed: boolean;
  /** Files changed but not committed. */
  uncommittedFileCount: number;
  /** Distinct files touched in the earliest window of this stall. */
  earlyTouchedFiles: number;
  /** Distinct files touched in the latest window of this stall. */
  lateTouchedFiles: number;
}

export interface NonConvergenceDiagnosis {
  reason: LoopNonConvergenceReason;
  /** One line for OUTSTANDING.md and the HUD. Names the next human action. */
  message: string;
}

/** Growth factor beyond which the touched-file set counts as widening. */
const SCOPE_EXPANSION_FACTOR = 2;
/** Reviewer rounds before a repeated finding counts as non-convergence. */
const REVIEW_NON_CONVERGENCE_ROUNDS = 3;

/**
 * Classify a stalled run. Pure and total — every input shape returns a reason,
 * with `no_progress` as the honest fallback rather than a guess.
 */
export function diagnoseNonConvergence(input: NonConvergenceInput): NonConvergenceDiagnosis {
  if (
    input.persistedReviewFindings > 0
    && input.reviewRounds >= REVIEW_NON_CONVERGENCE_ROUNDS
  ) {
    return {
      reason: 'code_review_non_converging',
      message:
        `The reviewer has raised the same ${input.persistedReviewFindings} unresolved `
        + `finding(s) across ${input.reviewRounds} rounds. Either the finding is wrong and `
        + 'should be dismissed, or it needs a decision the builder cannot make alone.',
    };
  }

  if (input.verifyPassed && input.uncommittedFileCount > 0) {
    return {
      reason: 'landable_uncommitted',
      message:
        `Verify passes and ${input.uncommittedFileCount} file(s) are changed but uncommitted. `
        + 'The work looks landable — review and commit it rather than asking for more iterations.',
    };
  }

  if (
    input.earlyTouchedFiles > 0
    && input.lateTouchedFiles > input.earlyTouchedFiles * SCOPE_EXPANSION_FACTOR
  ) {
    return {
      reason: 'scope_expanded',
      message:
        `The change has widened from ${input.earlyTouchedFiles} to ${input.lateTouchedFiles} `
        + 'files without converging. Re-state the goal narrowly, or split the remaining work.',
    };
  }

  return {
    reason: 'no_progress',
    message: 'No observable movement across the stall window and no more specific cause found.',
  };
}

export type ParkedLoopLeaf = LoopParkedLeaf;

export interface LeafParkInput {
  /** Ledger id of the leaf that keeps failing. */
  leafId: string | null;
  /** Consecutive CRITICAL no-progress iterations on THIS leaf. */
  criticalIterationsOnLeaf: number;
  /** Auto-unstick attempts already spent. */
  autoUnstickAttempts: number;
  /** Auto-unstick's own ceiling — parking before it is spent is premature. */
  autoUnstickMaxAttempts: number;
  diagnosis: NonConvergenceDiagnosis;
  seq: number;
}

/** Consecutive CRITICAL iterations on one leaf before it is parked. */
export const PARK_LEAF_AFTER_CRITICAL_ITERATIONS = 3;

/**
 * Should this leaf be deferred so the run can continue on the rest?
 *
 * Never parks on the generic `no_progress` reason: parking is a claim about
 * WHY the leaf cannot be finished, and "we don't know" is not a reason to
 * defer someone's work. Never parks before auto-unstick has spent its attempts
 * — the nudge is cheaper than a deferral and often works.
 */
export function shouldParkLeaf(input: LeafParkInput): ParkedLoopLeaf | null {
  if (!input.leafId) return null;
  if (input.diagnosis.reason === 'no_progress') return null;
  if (input.autoUnstickAttempts < input.autoUnstickMaxAttempts) return null;
  if (input.criticalIterationsOnLeaf < PARK_LEAF_AFTER_CRITICAL_ITERATIONS) return null;
  return {
    id: input.leafId,
    reason: input.diagnosis.reason,
    note: input.diagnosis.message,
    parkedAtSeq: input.seq,
  };
}

export interface ReviewDrivenParkInput {
  autoUnstickAttempts: number;
  autoUnstickMaxAttempts: number;
  verdict: string;
  /** The signal id auto-unstick acted on, when it acted. */
  signalId: string | null;
  /** Signal ids auto-unstick is allowed to act on. */
  eligibleSignals: ReadonlySet<string>;
}

/**
 * A progress signal as the park path needs it. `verdict` is required because
 * the renderer-boundary schema requires it; omitting it silently drops the
 * push event.
 */
export interface ParkSignal {
  id: string;
  verdict: string;
  message: string;
}

/**
 * L14 — which signal the park decision is about.
 *
 * `evaluation.primary` is the DETECTOR's most-important signal, chosen by its
 * own priority order in which A ranks first. `pickAutoUnstickSignal` uses a
 * different order and excludes A entirely. So on a run that is CRITICAL on both
 * A and (say) B, auto-unstick spends both attempts nudging B while
 * `evaluation.primary` stays A — and a park keyed on `primary` would see an
 * ineligible signal and never fire, defeating L14 exactly when it is needed.
 *
 * The signal auto-unstick recorded when it acted is therefore authoritative.
 * Only when it never acted do we fall back to the detector's view.
 */
export function resolveParkSignal(
  state: Pick<LoopState, 'autoUnstick'>,
  evaluation: {
    primary?: ParkSignal;
    signals: readonly ParkSignal[];
  },
): ParkSignal | undefined {
  const actedOn = state.autoUnstick?.signalId;
  if (actedOn) {
    const match = evaluation.signals.find((signal) => signal.id === actedOn);
    if (match) return match;
    // The signal is no longer in this iteration's evaluation but auto-unstick
    // did spend its attempts on it; keep the id so the park is still about the
    // right thing. `verdict` is mandatory: the renderer-boundary schema
    // requires the full ProgressSignalEvidence shape, and a signal without it
    // makes the whole `loop:paused-no-progress` push fail validation and get
    // dropped — the operator would never see the park.
    return {
      id: actedOn,
      verdict: 'CRITICAL',
      message: 'auto-unstick acted on this signal in an earlier iteration',
    };
  }
  return evaluation.primary ?? evaluation.signals[0];
}

/**
 * L14 — after auto-unstick's two strikes, a review-driven run must park.
 *
 * Review-driven skips the gated no-progress pause by design, so with nothing
 * else in the way the run keeps paying a full scaffold every iteration until
 * the iteration cap (then the wrap-up turn). Parking is the same stop the gated
 * path already takes; it just never reached this mode.
 *
 * Signal A stays ineligible (it is not in `eligibleSignals`), so a run stalled
 * only on A is never parked by this rule.
 */
export function shouldParkReviewDrivenRun(input: ReviewDrivenParkInput): boolean {
  if (input.verdict !== 'CRITICAL') return false;
  if (input.autoUnstickAttempts < input.autoUnstickMaxAttempts) return false;
  if (!input.signalId) return false;
  return input.eligibleSignals.has(input.signalId);
}

/** Record a parked leaf on state without dropping the work. */
export function recordParkedLeaf(state: LoopState, parked: ParkedLoopLeaf): void {
  const existing = state.parkedLeaves ?? [];
  if (existing.some((leaf) => leaf.id === parked.id)) return;
  state.parkedLeaves = [...existing, parked];
}

/**
 * L14 — park a review-driven run whose stall auto-unstick could not break.
 *
 * Pauses rather than terminates: the operator can read the named signal, hint
 * once, and resume. Terminating would throw away a run that is often one human
 * sentence away from converging.
 */
export function maybeParkReviewDrivenRun(args: {
  state: LoopState;
  seq: number;
  verdict: string;
  signal: ParkSignal | undefined;
  autoUnstickAttempts: number;
  convergenceNotes: Map<string, string>;
  memoryStore: Parameters<typeof recordLoopLearningForState>[0]['store'];
  emit: (eventName: string, payload: unknown) => void;
  cloneForBroadcast: () => unknown;
}): boolean {
  const { state, signal } = args;
  if (!shouldParkReviewDrivenRun({
    autoUnstickAttempts: args.autoUnstickAttempts,
    autoUnstickMaxAttempts: AUTO_UNSTICK_MAX_ATTEMPTS,
    verdict: args.verdict,
    signalId: signal?.id ?? null,
    eligibleSignals: AUTO_UNSTICK_ELIGIBLE_SIGNALS,
  })) {
    return false;
  }
  const note = `auto-unstick exhausted on signal ${signal?.id ?? 'unknown'}: ${signal?.message ?? 'no progress'}`;
  state.status = 'paused';
  if (!args.convergenceNotes.has(state.id)) args.convergenceNotes.set(state.id, note);
  recordLoopLearningForState({
    state,
    status: 'no-progress',
    note: args.convergenceNotes.get(state.id),
    store: args.memoryStore,
  });
  args.emit('loop:paused-no-progress', {
    loopRunId: state.id,
    seq: args.seq,
    signal,
    autoUnstickExhausted: true,
  });
  args.emit('loop:state-changed', { loopRunId: state.id, state: args.cloneForBroadcast() });
  logger.info('Loop parked — review-driven stall survived auto-unstick', {
    loopRunId: state.id,
    seq: args.seq,
    note,
  });
  return true;
}

/**
 * Build a {@link NonConvergenceInput} from the loop state the coordinator
 * already has, so the call site stays one line and the evidence-gathering is
 * testable on its own.
 *
 * Every input degrades to a value that cannot manufacture a diagnosis: an
 * absent review thread list counts as zero findings, an absent ledger as zero
 * open leaves. The classifier then falls through to `no_progress`, which is the
 * honest answer when the evidence is not there.
 */
export function diagnoseLoopNonConvergence(args: {
  state: LoopState;
  iteration: { filesChanged: readonly { path: string }[]; verifyStatus?: string };
  /** Iterations recorded this run, oldest first. */
  history: readonly { filesChanged: readonly { path: string }[] }[];
}): NonConvergenceDiagnosis {
  const { state, iteration, history } = args;
  const midpoint = Math.floor(history.length / 2);
  const distinct = (items: readonly { filesChanged: readonly { path: string }[] }[]): number =>
    new Set(items.flatMap((item) => item.filesChanged.map((file) => file.path))).size;

  return diagnoseNonConvergence({
    persistedReviewFindings: state.unresolvedReviewThreads?.length ?? 0,
    reviewRounds: state.pingPong?.roundCount ?? 0,
    verifyPassed: iteration.verifyStatus === 'passed',
    uncommittedFileCount: iteration.filesChanged.length,
    // Halves of the run so far. Too short to split ⇒ both zero, and the
    // scope-expansion rule cannot fire on no evidence.
    earlyTouchedFiles: midpoint > 0 ? distinct(history.slice(0, midpoint)) : 0,
    lateTouchedFiles: midpoint > 0 ? distinct(history.slice(midpoint)) : 0,
  });
}

/**
 * The whole L6 step for a stalled iteration: diagnose, record the reason on
 * state, and park the stuck leaf when it has outlasted every cheaper option.
 * Returns the diagnosis so the caller can reuse its wording.
 */
export function applyLoopNonConvergenceDiagnosis(args: {
  state: LoopState;
  iteration: { filesChanged: readonly { path: string }[]; verifyStatus?: string };
  history: readonly { filesChanged: readonly { path: string }[] }[];
  seq: number;
  nextTodo: string | null;
  autoUnstickAttempts: number;
  emit: (eventName: string, payload: unknown) => void;
}): NonConvergenceDiagnosis {
  const { state, seq } = args;
  const diagnosis = diagnoseLoopNonConvergence({
    state,
    iteration: args.iteration,
    history: args.history,
  });
  state.nonConvergence = { reason: diagnosis.reason, message: diagnosis.message, seq };

  const leafId = args.nextTodo ? args.nextTodo.slice(0, 120) : null;
  const parked = shouldParkLeaf({
    leafId,
    criticalIterationsOnLeaf: trackLeafStall(state, leafId),
    autoUnstickAttempts: args.autoUnstickAttempts,
    autoUnstickMaxAttempts: AUTO_UNSTICK_MAX_ATTEMPTS,
    diagnosis,
    seq,
  });
  if (parked) {
    recordParkedLeaf(state, parked);
    args.emit('loop:leaf-parked', { loopRunId: state.id, seq, parked });
  }
  return diagnosis;
}

/**
 * Count consecutive CRITICAL stalls on the SAME ledger leaf.
 *
 * This must be its own counter. The obvious-looking `state.repeatedEvidenceCount`
 * is not it: that only advances inside the completion-attempt branch, so a run
 * stuck mid-work — the ordinary no-progress case — would never reach the park
 * threshold however long it stalled, and a run that failed completion a few
 * times earlier could park a brand-new leaf on its first stall using stale,
 * unrelated evidence.
 *
 * Returns the new count. Moving to a different leaf resets it, because progress
 * onto new work is exactly what "this leaf is stuck" must not survive.
 */
export function trackLeafStall(state: LoopState, leafId: string | null): number {
  if (!leafId) {
    state.leafStall = undefined;
    return 0;
  }
  const current = state.leafStall;
  const criticalIterations = current?.leafId === leafId ? current.criticalIterations + 1 : 1;
  state.leafStall = { leafId, criticalIterations };
  return criticalIterations;
}

/**
 * The gated no-progress pause, with L6's diagnosis in front of it.
 *
 * Order matters: diagnose first so the convergence note carries the NAMED
 * reason rather than the raw signal message, then park the stuck leaf, then
 * pause. A human reading the pause banner should see "the reviewer keeps
 * raising the same finding", not "no-progress".
 */
export function pauseLoopForNoProgress(args: {
  state: LoopState;
  iteration: { filesChanged: readonly { path: string }[]; verifyStatus?: string };
  history: readonly { filesChanged: readonly { path: string }[] }[];
  seq: number;
  nextTodo: string | null;
  primary: ParkSignal | undefined;
  autoUnstickAttempts: number;
  convergenceNotes: Map<string, string>;
  memoryStore: Parameters<typeof recordLoopLearningForState>[0]['store'];
  emit: (eventName: string, payload: unknown) => void;
  cloneForBroadcast: () => unknown;
}): NonConvergenceDiagnosis {
  const { state, primary } = args;
  state.status = 'paused';
  const diagnosis = applyLoopNonConvergenceDiagnosis({
    state,
    iteration: args.iteration,
    history: args.history,
    seq: args.seq,
    nextTodo: args.nextTodo,
    autoUnstickAttempts: args.autoUnstickAttempts,
    emit: args.emit,
  });
  // LF-6: capture the dead-end as a learning before pausing.
  if (primary && !args.convergenceNotes.has(state.id)) {
    args.convergenceNotes.set(state.id, `${diagnosis.reason}: ${diagnosis.message}`);
  }
  recordLoopLearningForState({
    state,
    status: 'no-progress',
    note: args.convergenceNotes.get(state.id),
    store: args.memoryStore,
  });
  args.emit('loop:paused-no-progress', {
    loopRunId: state.id,
    signal: primary,
    nonConvergence: state.nonConvergence,
  });
  args.emit('loop:state-changed', { loopRunId: state.id, state: args.cloneForBroadcast() });
  logger.info('Loop paused — no-progress CRITICAL', {
    loopRunId: state.id,
    signal: primary?.id,
    reason: diagnosis.reason,
  });
  return diagnosis;
}
