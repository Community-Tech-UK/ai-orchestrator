import type {
  DocReviewItemDecision,
  DocReviewItemVerdict,
  DocReviewOverall,
} from '@contracts/schemas/doc-review';

export type {
  DocReviewChangedEvent,
  DocReviewItemDecision,
  DocReviewItemVerdict,
  DocReviewOverall,
  DocReviewSession,
  DocReviewStatus,
} from '@contracts/schemas/doc-review';

/** A reviewable item as reported by the artifact's `aio-review/ready` message. */
export interface DocReviewItemInfo {
  id: string;
  title: string;
  decisionId: string | null;
  options: readonly DocReviewOptionInfo[];
}

export interface DocReviewOptionInfo {
  id: string;
  label: string;
  multi: boolean;
  isDefault: boolean;
}

/**
 * Per-item decision state the page mirrors from the sandboxed artifact's postMessage
 * events. Keyed by item id.
 */
export interface DocReviewItemState {
  info: DocReviewItemInfo;
  decision: DocReviewItemVerdict;
  comment: string;
  choice: string | null;
  choices: string[];
}

export function toItemDecisions(
  states: readonly DocReviewItemState[],
): DocReviewItemDecision[] {
  return states.map((s) => ({
    itemId: s.info.id,
    title: s.info.title,
    decisionId: s.info.decisionId,
    decision: s.decision,
    comment: s.comment.trim() || undefined,
    choice: s.choice,
    choices: s.choices,
  }));
}

/**
 * Answer every item the reviewer has not answered with the author's recommendation: Approve,
 * plus the recommended option(s) when the item offers options and none is picked yet.
 * Items the reviewer rejected, and options or comments they already gave, are kept.
 */
export function applyRecommendations(
  states: readonly DocReviewItemState[],
): DocReviewItemState[] {
  return states.map((state) => {
    if (state.decision === 'reject') return state;
    const recommended = state.info.options.filter((option) => option.isDefault).map((option) => option.id);
    const hasSelection = state.choice !== null || state.choices.length > 0;
    if (hasSelection || recommended.length === 0) return { ...state, decision: 'approve' };
    const multi = state.info.options.some((option) => option.multi);
    return multi
      ? { ...state, decision: 'approve', choice: null, choices: recommended }
      : { ...state, decision: 'approve', choice: recommended[0], choices: [] };
  });
}

export const OVERALL_OPTIONS: readonly { value: DocReviewOverall; label: string }[] = [
  { value: 'approved', label: 'Approve' },
  { value: 'changes_requested', label: 'Request changes' },
  { value: 'rejected', label: 'Reject' },
];
