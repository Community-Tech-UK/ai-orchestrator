/**
 * Cross-Model Review Validation Schemas
 *
 * Zod schemas for runtime validation of cross-model review IPC payloads
 * and review result JSON parsing.
 */

import { z } from 'zod';

// ============ IPC Payload Schemas ============

export const ReviewDismissPayloadSchema = z.object({
  reviewId: z.string().min(1).max(100),
  instanceId: z.string().min(1).max(100),
});

export const ReviewActionPayloadSchema = z.object({
  reviewId: z.string().min(1).max(100),
  instanceId: z.string().min(1).max(100),
  action: z.enum(['dismiss', 'ask-primary', 'show-full', 'start-debate']),
});

// ============ Review Result JSON Schemas ============

const DimensionScoreSchema = z.object({
  reasoning: z.string(),
  score: z.number().int().min(1).max(4),
  issues: z.array(z.string()),
});

export const ReviewResultJsonSchema = z.object({
  correctness: DimensionScoreSchema,
  completeness: DimensionScoreSchema,
  security: DimensionScoreSchema,
  consistency: DimensionScoreSchema,
  overall_verdict: z.enum(['APPROVE', 'CONCERNS', 'REJECT']),
  summary: z.string(),
});

export const TieredReviewResultJsonSchema = z.object({
  traces: z.array(z.object({
    scenario: z.string(),
    result: z.enum(['pass', 'fail']),
    detail: z.string(),
  })).optional(),
  boundaries_checked: z.array(z.string()).optional(),
  assumptions: z.array(z.object({
    assumption: z.string(),
    severity: z.enum(['high', 'medium', 'low']),
  })).optional(),
  integration_risks: z.array(z.string()).optional(),
  scores: z.object({
    correctness: DimensionScoreSchema,
    completeness: DimensionScoreSchema,
    security: DimensionScoreSchema,
    consistency: DimensionScoreSchema,
    feasibility: DimensionScoreSchema.optional(),
  }),
  overall_verdict: z.enum(['APPROVE', 'CONCERNS', 'REJECT']),
  summary: z.string(),
  critical_issues: z.array(z.string()).optional(),
});

export type ReviewDismissPayload = z.infer<typeof ReviewDismissPayloadSchema>;
export type ReviewActionPayload = z.infer<typeof ReviewActionPayloadSchema>;
export type ReviewResultJson = z.infer<typeof ReviewResultJsonSchema>;
export type TieredReviewResultJson = z.infer<typeof TieredReviewResultJsonSchema>;
