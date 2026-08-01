import { z } from 'zod';
import {
  LoopActivityKindSchema,
  LoopPendingInputKindSchema,
  LoopStageSchema,
  LoopStatusSchema,
  LoopTerminalIntentSchema,
  LoopVerdictSchema,
  ProgressSignalEvidenceSchema,
} from './loop.schemas';
// ─────────────────────────────────────────────────────────────────────────────
// Renderer event payloads (main → renderer `loop:*` pushes)
//
// Push-channel schemas pin the fields the renderer relies on. Multi-site or
// high-churn events allow extra keys so a new optional field at one emit site
// cannot silently drop live UI events; single-site scalar events are strict.
// ─────────────────────────────────────────────────────────────────────────────

/** Envelope guard for `loop:state-changed`. The full state is already
 *  strict-validated on request/response paths via `LoopStateSchema`; the push
 *  channel pins only core identity keys. */
const LoopStateBroadcastSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  status: LoopStatusSchema,
}).passthrough();

export const LoopStartedEventSchema = z.object({
  loopRunId: z.string(),
  chatId: z.string(),
}).strict();

export const LoopStateChangedEventSchema = z.object({
  loopRunId: z.string(),
  state: LoopStateBroadcastSchema,
}).strict();

export const LoopIterationStartedEventSchema = z.object({
  loopRunId: z.string(),
  seq: z.number().int().nonnegative(),
  stage: LoopStageSchema,
}).strict();

export const LoopActivityEventSchema = z.object({
  loopRunId: z.string(),
  seq: z.number().int(),
  stage: LoopStageSchema,
  timestamp: z.number(),
  // LT-021: the invoker forwards its whole activity vocabulary on this channel,
  // not just the three kinds the coordinator emits directly. Narrowing this to
  // `status | error | input_required` silently dropped every tool call and
  // result before it reached the renderer's loop activity feed.
  kind: LoopActivityKindSchema,
  message: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const LoopIterationCompleteEventSchema = z.object({
  loopRunId: z.string(),
  seq: z.number().int(),
  verdict: LoopVerdictSchema,
}).strict();

export const LoopPausedNoProgressEventSchema = z.object({
  loopRunId: z.string(),
  signal: ProgressSignalEvidenceSchema,
  reason: z.string().optional(),
  decision: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export const LoopClaimedDoneButFailedEventSchema = z.object({
  loopRunId: z.string(),
  signal: z.string(),
  failure: z.string(),
}).strict();

export const LoopTerminalIntentRecordedEventSchema = z.object({
  loopRunId: z.string(),
  intent: LoopTerminalIntentSchema,
}).strict();

export const LoopTerminalIntentRejectedEventSchema = z.object({
  loopRunId: z.string(),
  intent: LoopTerminalIntentSchema,
  reason: z.string(),
}).strict();

/** Shared core for the four fresh-eyes review events; each has ping-pong and
 *  completion-gate emit variants carrying extra advisory fields. */
const LoopFreshEyesReviewCoreSchema = z.object({
  loopRunId: z.string(),
  signal: z.string(),
});

export const LoopFreshEyesReviewStartedEventSchema = LoopFreshEyesReviewCoreSchema.passthrough();

export const LoopFreshEyesReviewPassedEventSchema = LoopFreshEyesReviewCoreSchema.extend({
  reviewersUsed: z.array(z.string()),
  summary: z.string(),
  // WS-A3: severity-blocking findings demoted to advisory because their cited
  // evidence could not be verified — kept visible rather than silently
  // dropped. Findings are `unknown`-typed here for the same reason
  // `blockingFindings` below is: the shape lives in main-process orchestration
  // types and this push-channel guard only pins core identity keys.
  demotedFindings: z.array(z.unknown()).optional(),
  // WS-B9: per-angle reviewer coverage for this attempt (used/cached/
  // skipped/failed/parse_failed) — same "unknown, main owns the shape" reason.
  coverage: z.array(z.unknown()).optional(),
}).passthrough();

export const LoopFreshEyesReviewFailedEventSchema = LoopFreshEyesReviewCoreSchema.extend({
  error: z.string(),
  coverage: z.array(z.unknown()).optional(),
}).passthrough();

export const LoopFreshEyesReviewBlockedEventSchema = LoopFreshEyesReviewCoreSchema.extend({
  reviewersUsed: z.array(z.string()),
  blockingFindings: z.array(z.unknown()),
  summary: z.string(),
  demotedFindings: z.array(z.unknown()).optional(),
  coverage: z.array(z.unknown()).optional(),
}).passthrough();

export const LoopInterventionAppliedEventSchema = z.object({
  loopRunId: z.string(),
  message: z.string(),
  kind: LoopPendingInputKindSchema,
}).strict();

export const LoopCompletedEventSchema = z.object({
  loopRunId: z.string(),
  signal: z.string(),
  verifyOutput: z.string(),
  acceptedByOperator: z.boolean().optional(),
}).strict();

export const LoopCompletedNeedsReviewEventSchema = z.object({
  loopRunId: z.string(),
  reason: z.string(),
  acceptedByOperator: z.boolean().optional(),
}).strict();

export const LoopNotesCuratedEventSchema = z.object({
  loopRunId: z.string(),
  seq: z.number().int(),
  elidedChars: z.number(),
}).strict();

export const LoopContextCompactedEventSchema = z.object({
  loopRunId: z.string(),
  seq: z.number().int(),
  previousUtilization: z.number(),
  newUtilization: z.number(),
  reason: z.string(),
}).strict();

export const LoopBranchSelectEventSchema = z.object({
  loopRunId: z.string(),
  seq: z.number().int(),
  adopted: z.boolean(),
  reason: z.string().optional(),
  candidateCount: z.number().int(),
}).passthrough();

export const LoopPlanRegeneratedEventSchema = z.object({
  loopRunId: z.string(),
  seq: z.number().int(),
  attempt: z.number().int(),
  max: z.number().int(),
}).strict();

export const LoopLedgerLintEventSchema = z.object({
  loopRunId: z.string(),
  findings: z.array(z.object({
    item: z.string(),
    category: z.string(),
    reason: z.string(),
  }).passthrough()),
}).strict();

export const LoopSteeringDowngradedEventSchema = z.object({
  loopRunId: z.string(),
  requestedKind: LoopPendingInputKindSchema,
  effectiveKind: LoopPendingInputKindSchema,
  reason: z.string(),
}).strict();

export const LoopFollowUpDrainedEventSchema = z.object({
  loopRunId: z.string(),
  seq: z.number().int(),
  count: z.number().int(),
  remaining: z.number().int(),
}).strict();

export const LoopMoreWorkDeclaredEventSchema = z.object({
  loopRunId: z.string(),
  seq: z.number().int(),
}).strict();

export const LoopFailedEventSchema = z.object({
  loopRunId: z.string(),
  reason: z.string(),
}).strict();

export const LoopCapReachedEventSchema = z.object({
  loopRunId: z.string(),
  cap: z.string(),
  reason: z.string(),
}).strict();

export const LoopProviderLimitEventSchema = z.object({
  loopRunId: z.string(),
  reason: z.string(),
  source: z.enum(['quota', 'notice']),
  action: z.string(),
  windowId: z.string().optional(),
  resumeAt: z.number().nullable(),
  willResume: z.boolean(),
}).strict();

export const LoopCancelledEventSchema = z.object({
  loopRunId: z.string(),
}).strict();

export const LoopErrorEventSchema = z.object({
  loopRunId: z.string(),
  error: z.string(),
}).strict();

export const LoopOutstandingChangedEventSchema = z.object({
  loopRunId: z.string(),
  chatId: z.string(),
  workspaceCwd: z.string(),
}).strict();
