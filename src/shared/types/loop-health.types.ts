/**
 * Loop health and non-convergence vocabulary.
 *
 * Split out of `loop-state.types.ts` to keep that file inside its size ceiling.
 * These are renderer-safe types: the HUD needs them, so they must not live
 * beside main-process code.
 */

/**
 * L4: advisory intra-iteration phase inferred from the child's command stream.
 * Defined here (not in the main-process classifier) so the renderer can type
 * the HUD chip without importing main-process code.
 */
export type LoopInferredPhase = 'investigating' | 'editing' | 'verifying' | 'reviewing';

/** L6: a named reason a loop is not converging. See `loop-nonconvergence.ts`. */
export type LoopNonConvergenceReason =
  | 'code_review_non_converging'
  | 'landable_uncommitted'
  | 'scope_expanded'
  | 'no_progress';

/** L6: a ledger leaf deferred with a reason so the run can continue. */
export interface LoopParkedLeaf {
  id: string;
  reason: LoopNonConvergenceReason;
  note: string;
  parkedAtSeq: number;
}
