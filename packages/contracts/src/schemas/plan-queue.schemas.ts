/**
 * Plan Queue Zod schemas — IPC payloads, MCP tool arguments and DTOs.
 *
 * The queue runs one worker instance per plan/livetest document and has a
 * separate verifier instance judge it. See
 * docs/plans/2026-09-18-plan-queue_spec_completed.md.
 */
import { z } from 'zod';

// -------------------------------------------------------------------------
// Enum schemas
// -------------------------------------------------------------------------

export const PlanQueueKindSchema = z.enum(['plans', 'livetests']);

export const PlanQueueRunStatusSchema = z.enum(['running', 'paused', 'completed', 'cancelled']);

export const PlanQueueItemStateSchema = z.enum([
  'discovered',
  'needs-answer',
  'queued',
  'preparing',
  'working',
  'fixing',
  'awaiting-slot',
  'verifying',
  'landing',
  'landed',
  'parked',
  'skipped',
]);

export const PlanQueueParkReasonSchema = z.enum([
  'round-limit',
  'verifier-unreliable',
  'no-diverse-verifier',
  'worker-error',
  'worktree-error',
  'merge-conflict',
  'land-blocked',
  'provider-limit',
  'cancelled',
]);

export const PlanQueueRoleSchema = z.enum(['triage', 'worker', 'verifier']);

export const PlanQueueFindingSeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);

/** Why a check a livetest worker left open is still open. */
export const PlanQueueNeedJamesClassSchema = z.enum(['real', 'policy-gated', 'stale']);

// -------------------------------------------------------------------------
// Value schemas
// -------------------------------------------------------------------------

const IdSchema = z.string().min(1).max(200);
const PathSchema = z.string().min(1).max(4000);

export const PlanQueueFindingSchema = z.object({
  severity: PlanQueueFindingSeveritySchema,
  summary: z.string().min(1).max(2000),
  /** How sure the verifier is, 0-100 (docs/prompt-engineering-house-style.md). */
  confidence: z.number().int().min(0).max(100),
  file: z.string().max(4000).optional(),
  evidence: z.string().max(8000).optional(),
});

export const PlanQueueGateRunSchema = z.object({
  command: z.string().min(1).max(2000),
  exitCode: z.number().int(),
});

export const PlanQueueNeedJamesEntrySchema = z.object({
  check: z.string().min(1).max(2000),
  classification: PlanQueueNeedJamesClassSchema,
  reason: z.string().min(1).max(4000),
});

export const PlanQueueVerdictSchema = z.object({
  verdict: z.enum(['PASS', 'FAIL']),
  findings: z.array(PlanQueueFindingSchema).max(100).default([]),
  gatesRun: z.array(PlanQueueGateRunSchema).max(50).default([]),
  /**
   * Whether the document may be renamed to its `_completed` name. Always true
   * for a passing plan. A livetest can PASS (its evidence is honest) while
   * checks remain open, in which case this is false and the name stays.
   */
  documentComplete: z.boolean().default(true),
  /** Livetest runs only: every check left as "needs James", classified. */
  needJames: z.array(PlanQueueNeedJamesEntrySchema).max(200).default([]),
});

export const PlanQueueQuestionSchema = z.object({
  question: z.string().min(1).max(2000),
  options: z
    .array(z.object({ id: z.string().min(1).max(50), label: z.string().min(1).max(500) }))
    .min(2)
    .max(4),
});

export const PlanQueueTriageRecordSchema = z.discriminatedUnion('disposition', [
  z.object({ documentPath: PathSchema, disposition: z.literal('ready') }),
  z.object({
    documentPath: PathSchema,
    disposition: z.literal('needs-answer'),
    question: PlanQueueQuestionSchema,
  }),
  z.object({
    documentPath: PathSchema,
    disposition: z.literal('skip'),
    reason: z.string().min(1).max(2000),
  }),
]);

export const PlanQueueRunConfigSchema = z.object({
  workerSlots: z.number().int().min(1).max(8),
  verificationSlots: z.number().int().min(1).max(4),
  maxRounds: z.number().int().min(1).max(10),
  maxLoadAverage: z.number().positive().max(1000),
  /** Deterministic commands the coordinator runs after merging a moved `main`. */
  postMergeGate: z.array(z.string().min(1).max(2000)).max(10),
  /** Gates the verifier must run and report (the canonical checklist by default). */
  verifierGates: z.array(z.string().min(1).max(2000)).max(20),
  relaxSettings: z.boolean(),
  /** Branch verified work lands on; fixed when the run starts. */
  baseBranch: z.string().min(1).max(500).optional(),
});

// -------------------------------------------------------------------------
// DTOs (main → renderer)
// -------------------------------------------------------------------------

export const PlanQueueItemDtoSchema = z.object({
  id: IdSchema,
  runId: IdSchema,
  documentPath: PathSchema,
  state: PlanQueueItemStateSchema,
  round: z.number().int().min(0),
  erroredRounds: z.number().int().min(0),
  branchName: z.string().max(500).nullable(),
  worktreePath: z.string().max(4000).nullable(),
  baseCommit: z.string().max(64).nullable(),
  checkpointCommit: z.string().max(64).nullable(),
  landedCommit: z.string().max(64).nullable(),
  workerInstanceId: z.string().max(200).nullable(),
  verifierInstanceId: z.string().max(200).nullable(),
  question: PlanQueueQuestionSchema.nullable(),
  answer: z.string().max(2000).nullable(),
  parkReason: PlanQueueParkReasonSchema.nullable(),
  detail: z.string().max(8000).nullable(),
  verdict: PlanQueueVerdictSchema.nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export const PlanQueueRunDtoSchema = z.object({
  id: IdSchema,
  parentInstanceId: IdSchema,
  kind: PlanQueueKindSchema,
  workspaceCwd: PathSchema,
  status: PlanQueueRunStatusSchema,
  config: PlanQueueRunConfigSchema,
  workerProvider: z.string().max(100).nullable(),
  /** Settings this run relaxed, while they are in force. */
  relaxedSettings: z.array(z.string().max(200)),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  items: z.array(PlanQueueItemDtoSchema),
});

export const PlanQueueAlertSchema = z.object({
  kind: z.enum(['unowned-worktree', 'missing-worktree', 'unowned-branch']),
  path: z.string().max(4000).optional(),
  branchName: z.string().max(500).optional(),
  itemId: z.string().max(200).optional(),
});

// -------------------------------------------------------------------------
// IPC / tool payload schemas
// -------------------------------------------------------------------------

export const PlanQueueStartPayloadSchema = z.object({
  parentInstanceId: IdSchema,
  kind: PlanQueueKindSchema,
  workspaceCwd: PathSchema,
  glob: z.string().max(1000).optional(),
  config: PlanQueueRunConfigSchema.partial().optional(),
});

export const PlanQueueGetPayloadSchema = z.object({ runId: IdSchema });

export const PlanQueueDiffstatPayloadSchema = z.object({ itemId: IdSchema });

export const PlanQueueListPayloadSchema = z.object({
  limit: z.number().int().min(1).max(200).optional(),
});

export const PlanQueueAnswerPayloadSchema = z.object({
  itemId: IdSchema,
  optionId: z.string().min(1).max(50),
});

export const PlanQueueControlPayloadSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pause'), runId: IdSchema }),
  z.object({ action: z.literal('resume'), runId: IdSchema }),
  z.object({ action: z.literal('cancel'), runId: IdSchema }),
  z.object({ action: z.literal('skip-item'), itemId: IdSchema }),
  z.object({ action: z.literal('resume-item'), itemId: IdSchema }),
  z.object({ action: z.literal('land-anyway'), itemId: IdSchema }),
  z.object({ action: z.literal('discard-item'), itemId: IdSchema }),
]);

/** `plan_queue_report_verdict` arguments (snake_case, like the other MCP tools). */
export const PlanQueueReportVerdictArgsSchema = z.object({
  item_id: IdSchema,
  verdict: z.enum(['PASS', 'FAIL']),
  findings: z.array(PlanQueueFindingSchema).max(100).default([]),
  gates_run: z.array(PlanQueueGateRunSchema).max(50).default([]),
  document_complete: z.boolean().default(true),
  need_james: z.array(PlanQueueNeedJamesEntrySchema).max(200).default([]),
});

export const PlanQueueReportTriageArgsSchema = z.object({
  run_id: IdSchema,
  records: z.array(PlanQueueTriageRecordSchema).min(1).max(500),
});

export const PlanQueueStartArgsSchema = z.object({
  kind: PlanQueueKindSchema,
  glob: z.string().max(1000).optional(),
  worker_slots: z.number().int().min(1).max(8).optional(),
  verification_slots: z.number().int().min(1).max(4).optional(),
  max_rounds: z.number().int().min(1).max(10).optional(),
  relax_settings: z.boolean().optional(),
  verifier_gates: z.array(z.string().min(1).max(2000)).max(20).optional(),
  post_merge_gate: z.array(z.string().min(1).max(2000)).max(10).optional(),
});

export const PlanQueueStatusArgsSchema = z.object({ run_id: IdSchema.optional() });

export const PlanQueueAnswerArgsSchema = z.object({
  item_id: IdSchema,
  option_id: z.string().min(1).max(50),
});

export const PlanQueueControlArgsSchema = z.object({
  action: z.enum(['pause', 'resume', 'cancel', 'skip-item', 'resume-item', 'land-anyway', 'discard-item']),
  run_id: IdSchema.optional(),
  item_id: IdSchema.optional(),
});

export const PlanQueueStateChangedEventSchema = z.object({
  runId: IdSchema,
  itemId: IdSchema.optional(),
});

// -------------------------------------------------------------------------
// Types
// -------------------------------------------------------------------------

export type PlanQueueKind = z.infer<typeof PlanQueueKindSchema>;
export type PlanQueueRunStatus = z.infer<typeof PlanQueueRunStatusSchema>;
export type PlanQueueItemState = z.infer<typeof PlanQueueItemStateSchema>;
export type PlanQueueParkReason = z.infer<typeof PlanQueueParkReasonSchema>;
export type PlanQueueRole = z.infer<typeof PlanQueueRoleSchema>;
export type PlanQueueFinding = z.infer<typeof PlanQueueFindingSchema>;
export type PlanQueueVerdict = z.infer<typeof PlanQueueVerdictSchema>;
export type PlanQueueQuestion = z.infer<typeof PlanQueueQuestionSchema>;
export type PlanQueueTriageRecord = z.infer<typeof PlanQueueTriageRecordSchema>;
export type PlanQueueRunConfig = z.infer<typeof PlanQueueRunConfigSchema>;
export type PlanQueueItemDto = z.infer<typeof PlanQueueItemDtoSchema>;
export type PlanQueueRunDto = z.infer<typeof PlanQueueRunDtoSchema>;
export type PlanQueueAlert = z.infer<typeof PlanQueueAlertSchema>;
export type PlanQueueStartPayload = z.infer<typeof PlanQueueStartPayloadSchema>;
export type PlanQueueControlPayload = z.infer<typeof PlanQueueControlPayloadSchema>;
export type PlanQueueStateChangedEvent = z.infer<typeof PlanQueueStateChangedEventSchema>;
export type PlanQueueNeedJamesEntry = z.infer<typeof PlanQueueNeedJamesEntrySchema>;
export type PlanQueueReportVerdictArgs = z.infer<typeof PlanQueueReportVerdictArgsSchema>;
export type PlanQueueReportTriageArgs = z.infer<typeof PlanQueueReportTriageArgsSchema>;
export type PlanQueueStartArgs = z.infer<typeof PlanQueueStartArgsSchema>;
export type PlanQueueControlArgs = z.infer<typeof PlanQueueControlArgsSchema>;

/** The canonical verification checklist from AGENTS.md. */
const CANONICAL_GATES = [
  'npx tsc --noEmit',
  'npx tsc --noEmit -p tsconfig.spec.json',
  'npm run lint',
  'npm run check:ts-max-loc',
  'npm run build:main',
  'npm run build:renderer',
  'npm run test:quiet',
];

export const DEFAULT_PLAN_QUEUE_CONFIG: Record<PlanQueueKind, PlanQueueRunConfig> = {
  plans: {
    workerSlots: 3,
    verificationSlots: 2,
    maxRounds: 3,
    maxLoadAverage: 30,
    postMergeGate: ['npx tsc --noEmit', 'npx tsc --noEmit -p tsconfig.spec.json'],
    verifierGates: CANONICAL_GATES,
    relaxSettings: false,
  },
  livetests: {
    workerSlots: 1,
    verificationSlots: 1,
    maxRounds: 3,
    maxLoadAverage: 30,
    postMergeGate: ['npx tsc --noEmit', 'npx tsc --noEmit -p tsconfig.spec.json'],
    // A livetest mostly edits documents; the verifier judges evidence, and any
    // tracked code change still has to type-check and lint.
    verifierGates: ['npx tsc --noEmit', 'npm run lint'],
    relaxSettings: false,
  },
};
