import { z } from 'zod';

/**
 * Renderer event payloads for the cross-model review, the doom-loop detector and
 * the input-required requests. Split out of `instance.schemas.ts` to keep that
 * file under its size ceiling; it re-exports this module, so the subpath
 * `@contracts/schemas/instance` still carries every name.
 */

// ============ Cross-model review + doom-loop + input-required renderer events ============

export const CrossModelReviewSkippedEventSchema = z.object({
  instanceId: z.string(),
  reason: z.literal('daily-limit'),
  dailyUsage: z.object({
    used: z.number().int().nonnegative(),
    limit: z.number().int().nonnegative(),
    resetsAt: z.number().finite(),
    limitReached: z.boolean(),
  }).strict(),
}).strict();

export const CrossModelReviewStartedEventSchema = z.object({
  instanceId: z.string(),
  reviewId: z.string(),
  reviewStartedAt: z.number(),
}).strict();

/** `cross-model-review:result` — AggregatedReview. The envelope is pinned;
 *  individual reviewer results are deep, versioned structures validated at
 *  parse time in the service, so they pass through loosely here. */
export const CrossModelReviewResultEventSchema = z.object({
  id: z.string(),
  instanceId: z.string(),
  outputType: z.enum(['code', 'plan', 'architecture']),
  reviewDepth: z.enum(['structured', 'tiered']),
  reviews: z.array(z.object({ reviewerId: z.string() }).passthrough()),
  localReviewer: z.unknown().optional(),
  turnSeq: z.number().int().nonnegative().optional(),
  hasDisagreement: z.boolean(),
  reviewStartedAt: z.number().optional(),
  timestamp: z.number(),
}).strict();

export const CrossModelReviewDiscardedEventSchema = z.object({
  instanceId: z.string(),
  reviewId: z.string(),
  reviewStartedAt: z.number(),
  reason: z.string(),
}).strict();

export const CrossModelReviewAllUnavailableEventSchema = z.object({
  instanceId: z.string(),
  reviewId: z.string(),
  reviewStartedAt: z.number(),
}).strict();

export const CrossModelReviewReviewerUnavailableEventSchema = z.object({
  dropped: z.array(z.object({
    cli: z.string(),
    error: z.string().optional(),
  })),
}).strict();

export const CrossModelReviewReviewerRateLimitedEventSchema = z.object({
  instanceId: z.string(),
  reviewId: z.string(),
  cliType: z.string(),
}).strict();

export const CrossModelReviewReviewerRateLimitClearedEventSchema = z.object({
  cliType: z.string(),
}).strict();

/**
 * WS-A2 — `instance:doom-loop`: a result-aware tool-loop detection
 * (`ToolLoopDetectionEvent` in `src/main/orchestration/doom-loop-detector.ts`)
 * as sent by `setupInstanceEventForwarding()`, plus `harnessStopping`: Harness
 * is stopping the turn itself, so the renderer offers no decision.
 * `.strict()` rejects unknown keys, so this must track that payload exactly.
 */
export const InstanceDoomLoopEventSchema = z.object({
  instanceId: z.string(),
  detector: z.enum(['repeat-no-progress', 'ping-pong', 'runaway']),
  severity: z.enum(['warn', 'critical']),
  toolName: z.string(),
  count: z.number().int(),
  windowDescription: z.string(),
  harnessStopping: z.boolean(),
}).strict();

export const InstanceInputRequiredEventSchema = z.object({
  instanceId: z.string(),
  requestId: z.string(),
  prompt: z.string(),
  timestamp: z.number(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

/** A pending input request that no longer needs an answer, and why. */
export const InstanceInputRequiredResolvedEventSchema = z.object({
  instanceId: z.string(),
  requestId: z.string(),
  reason: z.enum(['timeout', 'auto_approved', 'decided', 'cancelled', 'exited']),
  /**
   * `user-action` for a card the model raised itself; absent for a CLI's request.
   * Only a CLI's request counts toward the pending-approval badge.
   */
  kind: z.literal('user-action').optional(),
}).strict();
