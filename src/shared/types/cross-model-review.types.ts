/**
 * Cross-Model Review Types
 * Shared between main process and renderer
 */

/** Output types that can trigger a review */
export type ReviewOutputType = 'code' | 'plan' | 'architecture';

/** Review verdict from a single reviewer */
export type ReviewVerdict = 'APPROVE' | 'CONCERNS' | 'REJECT';

export type ReviewProvenanceSource = 'remote' | 'local';

export interface ReviewParticipantStatus {
  reviewerId: string;
  source: ReviewProvenanceSource;
  status: 'used' | 'skipped' | 'failed';
  selectorId?: string;
  model?: string;
  reason?: string;
}

/** Dimension score from a reviewer */
export interface ReviewDimensionScore {
  reasoning: string;
  score: number; // 1-4
  issues: string[];
}

/** Structured review result from a single reviewer */
export interface ReviewResult {
  reviewerId: string;
  /** Optional for backwards-compatible persisted history. */
  source?: ReviewProvenanceSource;
  reviewType: 'structured' | 'tiered';
  scores: {
    correctness: ReviewDimensionScore;
    completeness: ReviewDimensionScore;
    security: ReviewDimensionScore;
    consistency: ReviewDimensionScore;
    feasibility?: ReviewDimensionScore;
  };
  overallVerdict: ReviewVerdict;
  summary: string;
  criticalIssues?: string[];
  traces?: { scenario: string; result: 'pass' | 'fail'; detail: string }[];
  boundariesChecked?: string[];
  assumptions?: { assumption: string; severity: 'critical' | 'high' | 'medium' | 'low' }[];
  integrationRisks?: string[];
  timestamp: number;
  durationMs: number;
  parseSuccess: boolean;
  rawResponse?: string;
}

/** Aggregated review for a single output */
export interface AggregatedReview {
  id: string;
  instanceId: string;
  outputType: ReviewOutputType;
  reviewDepth: 'structured' | 'tiered';
  reviews: ReviewResult[];
  /** Status of the additional local pass, including skips and failures. */
  localReviewer?: ReviewParticipantStatus;
  hasDisagreement: boolean;
  /** Dispatch time used to order overlapping reviews across renderer reloads. */
  reviewStartedAt?: number;
  timestamp: number;
}

/** Status of the cross-model review system */
export interface CrossModelReviewStatus {
  enabled: boolean;
  reviewers: {
    cliType: string;
    available: boolean;
    rateLimited: boolean;
    totalReviews: number;
  }[];
  pendingReviews: number;
  /**
   * Configured reviewers currently excluded because detection can't find them.
   * Included in the status snapshot so a freshly-loaded renderer can rehydrate
   * its reviewer-health badges without waiting for the next change event.
   */
  unavailableReviewers?: { cli: string; error?: string }[];
}

/** Actions the user can take on a review */
export type ReviewActionType = 'dismiss' | 'ask-primary' | 'show-full' | 'start-debate';

export interface ReviewActionPayload {
  reviewId: string;
  instanceId: string;
  action: ReviewActionType;
}

export interface ReviewDismissPayload {
  reviewId: string;
  instanceId: string;
}
