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
}

/**
 * Per-item decision state the page mirrors from the sandboxed artifact's postMessage
 * events. Keyed by item id.
 */
export interface DocReviewItemState {
  info: DocReviewItemInfo;
  decision: DocReviewItemVerdict;
  comment: string;
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
  }));
}

export const OVERALL_OPTIONS: readonly { value: DocReviewOverall; label: string }[] = [
  { value: 'approved', label: 'Approve' },
  { value: 'changes_requested', label: 'Request changes' },
  { value: 'rejected', label: 'Reject' },
];
