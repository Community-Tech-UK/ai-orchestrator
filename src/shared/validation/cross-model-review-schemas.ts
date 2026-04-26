/**
 * Cross-Model Review Validation Schemas
 *
 * Zod schemas for runtime validation of cross-model review IPC payloads
 * and review result JSON parsing.
 */

import { z } from 'zod';

// ============ IPC Payload Schemas ============

export const ReviewDismissPayloadSchema = z.object({
  reviewId: z.string().trim().min(1).max(100),
  instanceId: z.string().trim().min(1).max(100),
});

export const ReviewActionPayloadSchema = z.object({
  reviewId: z.string().trim().min(1).max(100),
  instanceId: z.string().trim().min(1).max(100),
  action: z.enum(['dismiss', 'ask-primary', 'show-full', 'start-debate']),
});

// ============ Review Result JSON Schemas ============

const ReasoningSchema = z.string().trim().min(1).max(4000);
const SummarySchema = z.string().trim().min(1).max(1000);
const IssueSchema = z.string().trim().min(1).max(1000);

const DimensionScoreSchema = z.object({
  reasoning: ReasoningSchema,
  score: z.number().int().min(1).max(4),
  issues: z.array(IssueSchema).max(25),
});

export const ReviewResultJsonSchema = z.object({
  correctness: DimensionScoreSchema,
  completeness: DimensionScoreSchema,
  security: DimensionScoreSchema,
  consistency: DimensionScoreSchema,
  overall_verdict: z.enum(['APPROVE', 'CONCERNS', 'REJECT']),
  summary: SummarySchema,
});

export const TieredReviewResultJsonSchema = z.object({
  traces: z.array(z.object({
    scenario: z.string().trim().min(1).max(500),
    result: z.enum(['pass', 'fail']),
    detail: z.string().trim().min(1).max(1000),
  })).max(10).optional(),
  boundaries_checked: z.array(IssueSchema).max(30).optional(),
  assumptions: z.array(z.object({
    assumption: z.string().trim().min(1).max(1000),
    severity: z.enum(['high', 'medium', 'low']),
  })).max(20).optional(),
  integration_risks: z.array(IssueSchema).max(20).optional(),
  scores: z.object({
    correctness: DimensionScoreSchema,
    completeness: DimensionScoreSchema,
    security: DimensionScoreSchema,
    consistency: DimensionScoreSchema,
    feasibility: DimensionScoreSchema.optional(),
  }),
  overall_verdict: z.enum(['APPROVE', 'CONCERNS', 'REJECT']),
  summary: SummarySchema,
  critical_issues: z.array(IssueSchema).max(20).optional(),
});

export type ReviewDismissPayload = z.infer<typeof ReviewDismissPayloadSchema>;
export type ReviewActionPayload = z.infer<typeof ReviewActionPayloadSchema>;
export type ReviewResultJson = z.infer<typeof ReviewResultJsonSchema>;
export type TieredReviewResultJson = z.infer<typeof TieredReviewResultJsonSchema>;
