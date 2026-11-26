import type { LoopState } from '../../shared/types/loop.types';

/** Why a run's work stayed on its session branch instead of merging. */
export type MergeHoldKind = 'stalled' | 'final-audit-blocked' | 'verified-no-change';

/**
 * Flag a `completed-needs-review` ending as a review hold before `terminate`
 * runs, so `holdsMergeForReview` keeps the work on its branch (October
 * follow-ups part 3g: loops that stall, or whose final check needs a person,
 * stop merging their work). An operator Accept never stages this flag, so an
 * accepted run still merges.
 */
export function stageMergeHold(state: LoopState, kind: MergeHoldKind): void {
  state.endEvidence = { ...state.endEvidence, mergeHold: true, mergeHoldKind: kind };
}
