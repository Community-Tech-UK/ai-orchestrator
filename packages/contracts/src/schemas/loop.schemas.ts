import { z } from 'zod';

// ============ Enums ============

export const LoopStageSchema = z.enum(['PLAN', 'REVIEW', 'IMPLEMENT']);
export const LoopStatusSchema = z.enum([
  'idle',
  'running',
  'paused',
  'completed',
  'cancelled',
  'error',
  'no-progress',
  'verify-failed',
  'cap-reached',
]);
export const LoopVerdictSchema = z.enum(['OK', 'WARN', 'CRITICAL']);
export const LoopProviderSchema = z.enum(['claude', 'codex']);
export const LoopReviewStyleSchema = z.enum(['single', 'debate', 'star-chamber']);
export const LoopContextStrategySchema = z.enum(['fresh-child', 'hybrid', 'same-session']);

export const ProgressSignalIdSchema = z.enum(['A', 'B', 'C', 'D', 'D-prime', 'E', 'F', 'G', 'H']);
export const CompletionSignalIdSchema = z.enum([
  'completed-rename',
  'done-promise',
  'done-sentinel',
  'all-green',
  'self-declared',
  'plan-checklist',
]);

// ============ Config ============

export const LoopHardCapsSchema = z.object({
  maxIterations: z.number().int().positive().max(1000),
  maxWallTimeMs: z.number().int().positive().max(24 * 60 * 60 * 1000),
  maxTokens: z.number().int().positive().max(100_000_000),
  maxCostCents: z.number().int().nonnegative().max(1_000_000),
  maxToolCallsPerIteration: z.number().int().positive().max(10_000),
});

export const LoopProgressThresholdsSchema = z.object({
  identicalHashWarnConsecutive: z.number().int().min(2).max(20),
  identicalHashCriticalConsecutive: z.number().int().min(2).max(20),
  identicalHashCriticalWindow: z.number().int().min(2).max(20),
  similarityWarnMean: z.number().min(0).max(1),
  similarityCriticalMean: z.number().min(0).max(1),
  stageWarnIterations: z.object({
    PLAN: z.number().int().min(1).max(50),
    REVIEW: z.number().int().min(1).max(50),
    IMPLEMENT: z.number().int().min(1).max(200),
  }),
  stageCriticalIterations: z.object({
    PLAN: z.number().int().min(1).max(50),
    REVIEW: z.number().int().min(1).max(50),
    IMPLEMENT: z.number().int().min(1).max(200),
  }),
  errorRepeatWarnInWindow: z.number().int().min(2).max(20),
  errorRepeatCriticalInWindow: z.number().int().min(2).max(20),
  tokensWithoutProgressWarn: z.number().int().min(1000),
  tokensWithoutProgressCritical: z.number().int().min(1000),
  toolRepeatWarnPerIteration: z.number().int().min(2).max(1000),
  toolRepeatCriticalPerIteration: z.number().int().min(2).max(1000),
  testStagnationWarnIterations: z.number().int().min(1).max(50),
  testStagnationCriticalIterations: z.number().int().min(1).max(50),
  churnRatioWarn: z.number().min(0).max(1),
  churnRatioCritical: z.number().min(0).max(1),
  warnEscalationWindow: z.number().int().min(2).max(50),
  warnEscalationCount: z.number().int().min(2).max(50),
});

export const LoopCompletionConfigSchema = z.object({
  completedFilenamePattern: z.string().min(1),
  donePromiseRegex: z.string().min(1),
  doneSentinelFile: z.string().min(1),
  verifyCommand: z.string(),
  verifyTimeoutMs: z.number().int().positive().max(60 * 60 * 1000),
  runVerifyTwice: z.boolean(),
  requireCompletedFileRename: z.boolean(),
});

export const LoopConfigSchema = z.object({
  initialPrompt: z.string().min(1, 'initialPrompt cannot be empty'),
  planFile: z.string().optional(),
  workspaceCwd: z.string().min(1),
  provider: LoopProviderSchema,
  reviewStyle: LoopReviewStyleSchema,
  contextStrategy: LoopContextStrategySchema,
  caps: LoopHardCapsSchema,
  progressThresholds: LoopProgressThresholdsSchema,
  completion: LoopCompletionConfigSchema,
  allowDestructiveOps: z.boolean(),
  initialStage: LoopStageSchema,
});

/** Partial config the renderer may submit; main process fills defaults. */
export const LoopConfigInputSchema = LoopConfigSchema.partial({
  caps: true,
  progressThresholds: true,
  completion: true,
  contextStrategy: true,
  reviewStyle: true,
  provider: true,
  allowDestructiveOps: true,
  initialStage: true,
  planFile: true,
});

// ============ Iteration / state ============

export const LoopFileChangeSchema = z.object({
  path: z.string(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  contentHash: z.string(),
});

export const LoopToolCallRecordSchema = z.object({
  toolName: z.string(),
  argsHash: z.string(),
  success: z.boolean(),
  durationMs: z.number().int().nonnegative(),
});

export const LoopErrorRecordSchema = z.object({
  bucket: z.string(),
  exactHash: z.string(),
  excerpt: z.string(),
});

export const ProgressSignalEvidenceSchema = z.object({
  id: ProgressSignalIdSchema,
  verdict: LoopVerdictSchema,
  message: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

export const CompletionSignalEvidenceSchema = z.object({
  id: CompletionSignalIdSchema,
  sufficient: z.boolean(),
  detail: z.string(),
});

export const LoopIterationSchema = z.object({
  id: z.string(),
  loopRunId: z.string(),
  seq: z.number().int().nonnegative(),
  stage: LoopStageSchema,
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  childInstanceId: z.string().nullable(),
  tokens: z.number().int().nonnegative(),
  costCents: z.number().int().nonnegative(),
  filesChanged: z.array(LoopFileChangeSchema),
  toolCalls: z.array(LoopToolCallRecordSchema),
  errors: z.array(LoopErrorRecordSchema),
  testPassCount: z.number().int().nullable(),
  testFailCount: z.number().int().nullable(),
  workHash: z.string(),
  outputSimilarityToPrev: z.number().min(0).max(1).nullable(),
  outputExcerpt: z.string(),
  progressVerdict: LoopVerdictSchema,
  progressSignals: z.array(ProgressSignalEvidenceSchema),
  completionSignalsFired: z.array(CompletionSignalEvidenceSchema),
  verifyStatus: z.enum(['not-run', 'passed', 'failed']),
  verifyOutputExcerpt: z.string(),
});

export const LoopStateSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  config: LoopConfigSchema,
  status: LoopStatusSchema,
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  totalIterations: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  totalCostCents: z.number().int().nonnegative(),
  currentStage: LoopStageSchema,
  lastIteration: LoopIterationSchema.optional(),
  endReason: z.string().optional(),
  endEvidence: z.record(z.string(), z.unknown()).optional(),
  pendingInterventions: z.array(z.string()),
  completedFileRenameObserved: z.boolean(),
  tokensSinceLastTestImprovement: z.number().int().nonnegative(),
  highestTestPassCount: z.number().int().nonnegative(),
  iterationsOnCurrentStage: z.number().int().nonnegative(),
  recentWarnIterationSeqs: z.array(z.number().int().nonnegative()),
});

export const LoopRunSummarySchema = z.object({
  id: z.string(),
  chatId: z.string(),
  status: LoopStatusSchema,
  totalIterations: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  totalCostCents: z.number().int().nonnegative(),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  endReason: z.string().nullable(),
});

// ============ IPC payload schemas ============

export const LoopAttachmentSchema = z.object({
  /** Original filename. Sanitized server-side before being written to disk. */
  name: z.string().min(1),
  /** Raw file bytes. Renderer reads File.arrayBuffer() and wraps in Uint8Array. */
  data: z.instanceof(Uint8Array),
});

export const LoopStartPayloadSchema = z.object({
  chatId: z.string().min(1),
  config: LoopConfigInputSchema,
  /** Optional attachments. The coordinator copies these into
   *  `<workspaceCwd>/.aio-loop-attachments/<loopRunId>/` and prepends the
   *  loop's initialPrompt with their relative paths so each iteration's
   *  CLI can read them via its workspace tools. */
  attachments: z.array(LoopAttachmentSchema).optional(),
});

export const LoopByIdPayloadSchema = z.object({
  loopRunId: z.string().min(1),
});

export const LoopInterveneePayloadSchema = z.object({
  loopRunId: z.string().min(1),
  message: z.string().min(1),
});

export const LoopListByChatPayloadSchema = z.object({
  chatId: z.string().min(1),
  limit: z.number().int().positive().max(200).optional(),
});

export const LoopGetIterationsPayloadSchema = z.object({
  loopRunId: z.string().min(1),
  fromSeq: z.number().int().nonnegative().optional(),
  toSeq: z.number().int().nonnegative().optional(),
});

// ============ Inferred types ============

export type LoopConfigPayload = z.infer<typeof LoopConfigSchema>;
export type LoopConfigInput = z.infer<typeof LoopConfigInputSchema>;
export type LoopStatePayload = z.infer<typeof LoopStateSchema>;
export type LoopIterationPayload = z.infer<typeof LoopIterationSchema>;
export type LoopRunSummaryPayload = z.infer<typeof LoopRunSummarySchema>;
export type LoopStartPayload = z.infer<typeof LoopStartPayloadSchema>;
export type LoopAttachment = z.infer<typeof LoopAttachmentSchema>;
export type LoopByIdPayload = z.infer<typeof LoopByIdPayloadSchema>;
export type LoopInterveneePayload = z.infer<typeof LoopInterveneePayloadSchema>;
export type LoopListByChatPayload = z.infer<typeof LoopListByChatPayloadSchema>;
export type LoopGetIterationsPayload = z.infer<typeof LoopGetIterationsPayloadSchema>;
