import type { LoopState } from '../../shared/types/loop.types';
import type { ReviewDrivenTerminal } from './loop-finish-phase';

/** Uses the same run-scoped rename evidence as the gated completion detector. */
export function missingCompletedPlanRenameReason(state: LoopState): string | undefined {
  if (!state.config.completion.requireCompletedFileRename || state.completedFileRenameObserved) {
    return undefined;
  }
  return 'The plan file was not marked complete. The loop finished with checks still needing review.';
}

/** Reapply completion notes after the dispatcher includes the final audit. */
export function applyReviewDrivenCompletionNotes(state: LoopState, terminal: ReviewDrivenTerminal): ReviewDrivenTerminal {
  // A missing rename ends with a note, but cannot waive a failed check, and it
  // can never weaken a stricter `needs-sign-off` finish outcome (a strict plan
  // loop with skipped checks): that sign-off authority keeps its Accept/Resume
  // pause, and the rename is added as a note for the operator.
  const renameReason = terminal.checks?.some(check => check.result === 'failed')
    ? undefined : missingCompletedPlanRenameReason(state);
  if (terminal.status !== 'needs-sign-off') {
    if (renameReason) state.lastCompletionOutcome = 'rename-gate';
    else state.lastCompletionOutcome = 'accepted';
  }
  const notes = [renameReason, ...(state.knownFailures ?? []), ...(state.followUps ?? [])].filter((note): note is string => !!note);
  if (notes.length === 0) return terminal;
  return { ...terminal,
    status: terminal.status === 'needs-sign-off' ? 'needs-sign-off' : 'completed-needs-review',
    reason: [terminal.reason, ...notes.filter(note => !terminal.reason.includes(note))].join('\n'),
  };
}
