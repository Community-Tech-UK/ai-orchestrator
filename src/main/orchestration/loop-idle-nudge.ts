/**
 * L1 — idle is not complete: nudge the same session instead of buying a turn.
 *
 * When a child goes quiet without declaring done, AIO's only recovery is to
 * start another iteration: a new prompt, a new context tax, a fresh scaffold.
 * Copilot's SDK draws the distinction we were missing — `session.idle` is
 * mechanical ("the stream stopped"), `task_complete` is semantic ("the work is
 * finished") — and nudges once on idle-without-complete rather than paying for
 * a whole new turn.
 *
 * `loop-announce-then-halt.ts` already does the narrow version of this: the
 * child said "next I'll run the tests" and then stopped. This is the general
 * case: a quiet turn with an open ledger and no sufficient signal.
 *
 * Three guards keep it from becoming noise:
 *
 *  - **A short turn is not idle.** A turn that ended in under
 *    {@link IDLE_TURN_GRACE_MS} is a transport failure, a refusal, or a crash —
 *    all of which have their own handling. Nudging there would paper over a
 *    real fault. (oh-my-opencode-slim's 5s stop-confirmation grace.)
 *  - **One nudge per iteration, bounded per run.** Repeating "you are not done"
 *    at a child that genuinely cannot proceed is how a loop burns its cap.
 *  - **Never on an operator-reviewed loop.** Those pause for a human by design;
 *    telling the child to keep going contradicts the mode.
 */

import {
  createLoopPendingInput,
  type LoopIteration,
  type LoopState,
} from '../../shared/types/loop.types';
import { maybeQueueAnnounceThenHaltContinuation } from './loop-announce-then-halt';

/** A turn shorter than this is a fault, not an idle. */
export const IDLE_TURN_GRACE_MS = 5_000;
/** Bound per run, matching the announce-then-halt budget. */
export const MAX_IDLE_NUDGES = 2;

export interface IdleNudgeLedgerView {
  /** Open (todo/doing) leaf count in LOOP_TASKS.md. */
  openLeaves: number;
}

/**
 * Queue one "you are not done" nudge for the next turn of the SAME session.
 * Returns true when a nudge was queued.
 *
 * Pure apart from mutating `state`; the ledger view is supplied by the caller
 * so this module never touches disk.
 */
export function maybeQueueIdleNotDoneNudge(
  state: LoopState,
  iteration: LoopIteration,
  ledger: IdleNudgeLedgerView,
): boolean {
  // Only a persistent session can be nudged — an exec-per-message provider has
  // no live turn to nudge into, and the "nudge" would just be next iteration's
  // prompt with extra words.
  if (state.config.contextStrategy !== 'same-session') return false;
  // Operator-reviewed loops pause for a human on purpose.
  if (state.manualReviewOnly) return false;
  if (state.config.completion.allowOperatorReviewedCompletion === true) return false;

  // A quiet turn: no tools, no files, nothing to show for it.
  if (iteration.toolCalls.length > 0 || iteration.filesChanged.length > 0) return false;
  // It said it was done — that is the completion path's business, not ours.
  if (iteration.completionSignalsFired.some((signal) => signal.sufficient)) return false;
  // Nothing left to do; a nudge would be telling it to invent work.
  if (ledger.openLeaves <= 0) return false;
  // Someone is already steering; do not pile an automated hint on top.
  if (state.pendingInterventions.length > 0) return false;

  // An unsealed iteration has no duration yet — treat that as "not proven idle"
  // rather than assuming the turn was long enough.
  if (iteration.endedAt === null) return false;
  const durationMs = iteration.endedAt - iteration.startedAt;
  if (!Number.isFinite(durationMs) || durationMs < IDLE_TURN_GRACE_MS) return false;

  const count = state.idleNudgeCount ?? 0;
  if (count >= MAX_IDLE_NUDGES) return false;
  if (state.idleNudgeSeq === iteration.seq) return false;

  state.idleNudgeCount = count + 1;
  state.idleNudgeSeq = iteration.seq;
  state.pendingInterventions.push(createLoopPendingInput(
    [
      'You are not done. The last turn produced no tool calls and no file changes, and',
      `${ledger.openLeaves} ledger item${ledger.openLeaves === 1 ? ' is' : 's are'} still open.`,
      'Do not declare complete while ledger items are open: pick the next open item, do the work,',
      'and update the ledger. If an item genuinely cannot be done, mark it deferred with a reason',
      'rather than leaving it open.',
    ].join(' '),
    { kind: 'queue', source: 'idle-nudge' },
  ));
  return true;
}

/**
 * The single entry point for "the turn went quiet — nudge instead of buying
 * another iteration". Announce-then-halt is the more specific diagnosis (the
 * child named the action it then failed to take), so it wins when both apply
 * and its wording is the more actionable of the two.
 */
export function queueQuietTurnNudge(
  state: LoopState,
  iteration: LoopIteration,
  ledger: IdleNudgeLedgerView,
): boolean {
  if (maybeQueueAnnounceThenHaltContinuation(state, iteration)) return true;
  return maybeQueueIdleNotDoneNudge(state, iteration, ledger);
}
