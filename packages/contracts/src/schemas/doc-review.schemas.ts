import { z } from 'zod';

/**
 * Schemas for the doc-review flow: an agent requests a human review of a plan/spec/report
 * (an HTML artifact under a workspace's `.aio-review/` dir), James decides in-app, and the
 * canonical feedback block is pushed back into the requesting instance.
 *
 * The renderer IPC surfaces (list/get/read-artifact/submit/dismiss/open-external) and the
 * MCP tool surfaces (request/get-result) both live here. No schema carries artifact HTML
 * inbound — artifact bytes only ever flow main → renderer over READ_ARTIFACT after the
 * stored path is re-validated inside `.aio-review/`.
 */

const idSchema = z.string().min(1).max(200);

/** Session lifecycle status. 'pending' until James decides. */
export const DocReviewStatusSchema = z.enum([
  'pending',
  'approved',
  'changes_requested',
  'rejected',
]);
export type DocReviewStatus = z.infer<typeof DocReviewStatusSchema>;

/** Overall verdict James can set (a decided status — never 'pending'). */
export const DocReviewOverallSchema = z.enum(['approved', 'changes_requested', 'rejected']);
export type DocReviewOverall = z.infer<typeof DocReviewOverallSchema>;

/** Durable owner identity. An instance id is a delivery hint, never the sole identity. */
export const DocReviewOriginSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('instance'),
    requestedInstanceId: idSchema,
    historyThreadId: idSchema,
    sessionId: idSchema.optional(),
  }).strict(),
  z.object({
    kind: z.literal('loop'),
    loopRunId: idSchema,
    chatId: idSchema,
  }).strict(),
]);
export type DocReviewOrigin = z.infer<typeof DocReviewOriginSchema>;

export const DocReviewDeliveryStateSchema = z.enum([
  'not-attempted',
  'dispatching',
  'queued',
  'delivered',
  'failed',
]);
export type DocReviewDeliveryState = z.infer<typeof DocReviewDeliveryStateSchema>;

export const DocReviewDeliveryAttemptSchema = z.object({
  id: idSchema,
  state: DocReviewDeliveryStateSchema,
  mechanism: z.enum([
    'direct-send', 'deferred-idle', 'await-idle', 'wake', 'continuity-revive',
    'loop-accept', 'loop-intervene', 'none',
  ]),
  targetInstanceId: idSchema.optional(),
  error: z.string().max(10_000).optional(),
  at: z.number().int().nonnegative(),
}).strict();
export type DocReviewDeliveryAttempt = z.infer<typeof DocReviewDeliveryAttemptSchema>;

/** Current delivery view for the UI. Attempts remain the immutable audit trail. */
export const DocReviewDeliverySchema = z.object({
  status: DocReviewDeliveryStateSchema,
  mechanism: z.string().min(1).max(100),
  attempts: z.number().int().nonnegative(),
  targetInstanceId: idSchema.optional(),
  lastError: z.string().max(10_000).optional(),
}).strict();
export type DocReviewDelivery = z.infer<typeof DocReviewDeliverySchema>;

/** Per-item decision. `null` = seen but no verdict set. */
export const DocReviewItemVerdictSchema = z.enum(['approve', 'reject']).nullable();
export type DocReviewItemVerdict = z.infer<typeof DocReviewItemVerdictSchema>;

export const DocReviewItemDecisionSchema = z
  .object({
    itemId: z.string().min(1).max(200),
    title: z.string().max(500).optional(),
    decisionId: z.string().max(50).nullable().optional(),
    decision: DocReviewItemVerdictSchema,
    comment: z.string().max(10_000).optional(),
    /** One selected authored option for a single-choice decision. */
    choice: z.string().min(1).max(200).nullable().optional(),
    /** Selected authored options for a multi-choice decision, in document order. */
    choices: z.array(z.string().min(1).max(200)).max(100).optional(),
  })
  .strict();
export type DocReviewItemDecision = z.infer<typeof DocReviewItemDecisionSchema>;

/** A stored review session, as surfaced to the renderer. */
export const DocReviewSessionSchema = z
  .object({
    id: idSchema,
    instanceId: idSchema,
    /** Optional only to read pre-delivery-v2 persisted sessions. */
    origin: DocReviewOriginSchema.optional(),
    workspacePath: z.string().min(1).max(4000),
    title: z.string().min(1).max(500),
    artifactPath: z.string().min(1).max(4000),
    sourcePath: z.string().max(4000).optional(),
    status: DocReviewStatusSchema,
    decisions: z.array(DocReviewItemDecisionSchema).max(1000),
    generalComment: z.string().max(10_000).optional(),
    createdAt: z.number().int().nonnegative(),
    decidedAt: z.number().int().nonnegative().optional(),
    deliveryAttempts: z.array(DocReviewDeliveryAttemptSchema).max(1000).default([]),
    delivery: DocReviewDeliverySchema.optional(),
  })
  .strict();
export type DocReviewSession = z.infer<typeof DocReviewSessionSchema>;

// ── Renderer IPC payloads ────────────────────────────────────────────────────

export const DocReviewListPayloadSchema = z
  .object({
    status: DocReviewStatusSchema.optional(),
  })
  .strict();
export type DocReviewListPayload = z.infer<typeof DocReviewListPayloadSchema>;

export const DocReviewGetPayloadSchema = z.object({ reviewId: idSchema }).strict();
export type DocReviewGetPayload = z.infer<typeof DocReviewGetPayloadSchema>;

export const DocReviewReadArtifactPayloadSchema = z.object({ reviewId: idSchema }).strict();
export type DocReviewReadArtifactPayload = z.infer<typeof DocReviewReadArtifactPayloadSchema>;

export const DocReviewSubmitDecisionPayloadSchema = z
  .object({
    reviewId: idSchema,
    overall: DocReviewOverallSchema,
    decisions: z.array(DocReviewItemDecisionSchema).max(1000),
    generalComment: z.string().max(10_000).optional(),
  })
  .strict();
export type DocReviewSubmitDecisionPayload = z.infer<typeof DocReviewSubmitDecisionPayloadSchema>;

export const DocReviewDismissPayloadSchema = z.object({ reviewId: idSchema }).strict();
export type DocReviewDismissPayload = z.infer<typeof DocReviewDismissPayloadSchema>;

export const DocReviewRetryDeliveryPayloadSchema = z.object({ reviewId: idSchema }).strict();
export type DocReviewRetryDeliveryPayload = z.infer<typeof DocReviewRetryDeliveryPayloadSchema>;

export const DocReviewOpenExternalPayloadSchema = z.object({ reviewId: idSchema }).strict();
export type DocReviewOpenExternalPayload = z.infer<typeof DocReviewOpenExternalPayloadSchema>;

// ── Change event (main → renderer) ───────────────────────────────────────────

export const DocReviewChangeKindSchema = z.enum(['created', 'decided', 'delivery-updated', 'dismissed']);
export type DocReviewChangeKind = z.infer<typeof DocReviewChangeKindSchema>;

export const DocReviewChangedEventSchema = z
  .object({
    kind: DocReviewChangeKindSchema,
    reviewId: idSchema,
    session: DocReviewSessionSchema.optional(),
  })
  .strict();
export type DocReviewChangedEvent = z.infer<typeof DocReviewChangedEventSchema>;

// ── MCP tool payloads (validated in the RPC server) ──────────────────────────

export const RequestDocReviewToolPayloadSchema = z
  .object({
    artifact_path: z.string().min(1).max(4000),
    title: z.string().min(1).max(500),
    source_path: z.string().max(4000).optional(),
  })
  .strict();
export type RequestDocReviewToolPayload = z.infer<typeof RequestDocReviewToolPayloadSchema>;

export const GetDocReviewResultToolPayloadSchema = z
  .object({
    review_id: idSchema,
  })
  .strict();
export type GetDocReviewResultToolPayload = z.infer<typeof GetDocReviewResultToolPayloadSchema>;
