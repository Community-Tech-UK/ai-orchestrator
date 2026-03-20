/**
 * Cross-Model Review Types
 * Shared between main process and renderer
 */

/** Output types that can trigger a review */
export type ReviewOutputType = 'code' | 'plan' | 'architecture';

/** Review verdict from a single reviewer */
export type ReviewVerdict = 'APPROVE' | 'CONCERNS' | 'REJECT';

/** Dimension score from a reviewer */
export interface ReviewDimensionScore {
  reasoning: string;
  score: number; // 1-4
  issues: string[];
}

/** Structured review result from a single reviewer */
export interface ReviewResult {
  reviewerId: string;
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
  assumptions?: { assumption: string; severity: 'high' | 'medium' | 'low' }[];
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
  hasDisagreement: boolean;
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
