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
  'triage-failed',
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

/** A recommendation records reasoning, never new permission to take an action. */
export const PlanQueueDecisionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('technical'),
    recommendedOptionId: z.string().min(1).max(50),
    reason: z.string().trim().min(1).max(4000),
    evidence: z.string().trim().min(1).max(8000),
  }).strict(),
  z.object({ kind: z.literal('human-authority'), reason: z.string().trim().min(1).max(4000) }).strict(),
  z.object({ kind: z.literal('human-input'), reason: z.string().trim().min(1).max(4000) }).strict(),
]);

export const PlanQueueQuestionSchema = z.object({
  question: z.string().min(1).max(2000),
  options: z
    .array(z.object({ id: z.string().min(1).max(50), label: z.string().min(1).max(500) }))
    .min(2)
    .max(4),
  /** Absent on legacy questions, which remain manual until investigated. */
  decision: PlanQueueDecisionSchema.optional(),
}).superRefine((question, ctx) => {
  if (new Set(question.options.map((option) => option.id)).size !== question.options.length) {
    ctx.addIssue({ code: 'custom', path: ['options'], message: 'Question option identifiers must be unique' });
  }
  const decision = question.decision;
  if (decision?.kind === 'technical'
    && (decision.recommendedOptionId === 'skip'
      || !question.options.some((option) => option.id === decision.recommendedOptionId))) {
    ctx.addIssue({
      code: 'custom', path: ['decision', 'recommendedOptionId'],
      message: 'A technical recommendation must select an existing non-skip option',
    });
  }
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

/**
 * One provider/account choice for queue sessions. `accountProfileIds` fences a
 * Claude/Codex/OpenCode session to those pool accounts (the pool still picks
 * among them and may only fail over inside them); absent = the pool's own
 * automatic choice. `copilotProfileId` pins a Copilot account; absent = the
 * Copilot routing rules decide.
 */
export const PlanQueueRouteChoiceSchema = z.object({
  provider: z.string().trim().min(1).max(50),
  model: z.string().trim().min(1).max(200).optional(),
  accountProfileIds: z.array(z.string().min(1).max(100)).max(20).optional(),
  copilotProfileId: z.string().min(1).max(100).optional(),
}).strict();

/**
 * Which providers and accounts a run's sessions may use. `workers` is ranked:
 * each new worker session starts on the first choice with usage left. An
 * empty `workers` list = the session that starts the run (its provider, model
 * and account). An empty `verifiers` list = automatic checker selection.
 */
export const PlanQueueRoutingSchema = z.object({
  workers: z.array(PlanQueueRouteChoiceSchema).max(10),
  verifiers: z.array(PlanQueueRouteChoiceSchema).max(10),
  /**
   * Set by the coordinator on a run's routing, never in the saved setting:
   * where the checker list came from. Only James's saved choice ('saved') may
   * replace the licence-pinned work Copilot seat in a protected folder; a
   * per-run list ('run') comes from an agent's tool call and may not.
   */
  checkersChosenBy: z.enum(['saved', 'run']).optional(),
}).strict();

export const DEFAULT_PLAN_QUEUE_ROUTING: PlanQueueRouting = { workers: [], verifiers: [] };

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
  /** The starting session's route, retained when its session is gone or the run changes routing. */
  startingSessionRoute: z.object({
    provider: z.string().optional(), currentModel: z.string().optional(),
    accountProfileId: z.string().optional(), copilotAccountProfileId: z.string().optional(),
  }).optional(),
  /** Effective providers and accounts for future sessions. Absent on older runs. */
  routing: PlanQueueRoutingSchema.optional(),
});

// -------------------------------------------------------------------------
// DTOs (main → renderer)
// -------------------------------------------------------------------------

export const PlanQueueSpendSchema = z.object({ tokens: z.number().int().nonnegative(), costUsd: z.number().nonnegative().finite(), exactUsd: z.number().nonnegative().finite() });

export const PlanQueueItemDtoSchema = z.object({
  spend: PlanQueueSpendSchema.nullable().optional(),
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
  heldAt: z.number().int().nullable().optional(),
  pendingInstruction: z.string().nullable().optional(),
  verdict: PlanQueueVerdictSchema.nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

export const PlanQueueRunDtoSchema = z.object({
  spend: PlanQueueSpendSchema.nullable().optional(),
  id: IdSchema,
  parentInstanceId: IdSchema,
  kind: PlanQueueKindSchema,
  workspaceCwd: PathSchema,
  status: PlanQueueRunStatusSchema,
  config: PlanQueueRunConfigSchema,
  workerProvider: z.string().max(100).nullable(),
  /** The effective worker model, including older runs without config.routing. */
  workerModel: z.string().max(200).nullable().optional(),
  /** Settings this run relaxed, while they are in force. */
  relaxedSettings: z.array(z.string().max(200)),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  items: z.array(PlanQueueItemDtoSchema),
});

export const PlanQueueAlertSchema = z.object({
  kind: z.enum(['unowned-worktree', 'missing-worktree', 'invalid-worktree', 'unowned-branch']),
  path: z.string().max(4000).optional(),
  branchName: z.string().max(500).optional(),
  itemId: z.string().max(200).optional(),
  reason: z.string().min(1).max(1000).optional(),
  /** Advice only; never grants permission to discard or recover a checkout. */
  suggestedAction: z.string().min(1).max(1000).optional(),
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
  z.object({ action: z.literal('pause-all') }),
  z.object({ action: z.literal('resume-all') }),
  z.object({ action: z.literal('set-routing'), runId: IdSchema, routing: PlanQueueRoutingSchema, moveInProgress: z.boolean().optional() }),
  z.object({ action: z.literal('pause'), runId: IdSchema }),
  z.object({ action: z.literal('resume'), runId: IdSchema }),
  z.object({ action: z.literal('cancel'), runId: IdSchema }),
  z.object({ action: z.literal('adopt'), runId: IdSchema }),
  z.object({ action: z.literal('skip-item'), itemId: IdSchema }),
  z.object({ action: z.literal('resume-item'), itemId: IdSchema }),
  z.object({ action: z.literal('land-anyway'), itemId: IdSchema }),
  z.object({ action: z.literal('retry-landing'), itemId: IdSchema }),
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

/** `RouteChoice` in the MCP tools' snake_case. */
export const PlanQueueRouteChoiceArgsSchema = z.object({
  provider: z.string().trim().min(1).max(50),
  model: z.string().trim().min(1).max(200).optional(),
  account_ids: z.array(z.string().min(1).max(100)).max(20).optional(),
  copilot_account_id: z.string().min(1).max(100).optional(),
}).strict();

/** Strict like the tool's advertised schema: a stale `worker` argument is refused, never silently dropped. */
export const PlanQueueStartArgsSchema = z.object({
  kind: PlanQueueKindSchema,
  glob: z.string().max(1000).optional(),
  worker_slots: z.number().int().min(1).max(8).optional(),
  verification_slots: z.number().int().min(1).max(4).optional(),
  max_rounds: z.number().int().min(1).max(10).optional(),
  relax_settings: z.boolean().optional(),
  verifier_gates: z.array(z.string().min(1).max(2000)).max(20).optional(),
  post_merge_gate: z.array(z.string().min(1).max(2000)).max(10).optional(),
  /** Worker choices for this run, in preference order; used only when James saved no worker list. */
  workers: z.array(PlanQueueRouteChoiceArgsSchema).max(10).optional(),
  /** Checker choices for this run, in preference order; used only when James saved no checker list. */
  verifiers: z.array(PlanQueueRouteChoiceArgsSchema).max(10).optional(),
}).strict();

export const PlanQueueStatusArgsSchema = z.object({ run_id: IdSchema.optional() });

export const PlanQueueAnswerArgsSchema = z.object({
  item_id: IdSchema,
  option_id: z.string().min(1).max(50),
});

export const PlanQueueControlArgsSchema = z.discriminatedUnion('action', [z.object({
  action: z.enum(['pause', 'resume', 'cancel', 'adopt', 'skip-item', 'resume-item', 'land-anyway', 'retry-landing', 'discard-item']),
  run_id: IdSchema.optional(),
  item_id: IdSchema.optional(),
}), z.object({
  action: z.literal('set-routing'),
  run_id: IdSchema,
  routing: z.object({ workers: z.array(PlanQueueRouteChoiceArgsSchema).max(10), verifiers: z.array(PlanQueueRouteChoiceArgsSchema).max(10) }).strict(),
  move_in_progress: z.boolean().optional(),
})]);

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
export type PlanQueueDecision = z.infer<typeof PlanQueueDecisionSchema>;
export type PlanQueueTriageRecord = z.infer<typeof PlanQueueTriageRecordSchema>;
export type PlanQueueRunConfig = z.infer<typeof PlanQueueRunConfigSchema>;
export type PlanQueueRouteChoice = z.infer<typeof PlanQueueRouteChoiceSchema>;
export type PlanQueueRouting = z.infer<typeof PlanQueueRoutingSchema>;
export type PlanQueueRouteChoiceArgs = z.infer<typeof PlanQueueRouteChoiceArgsSchema>;
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
  // The npm script (not bare `tsc --noEmit -p tsconfig.spec.json`) raises the V8
  // heap ceiling; the spec program peaks near 5 GiB and OOMs at Node's default.
  'npm run typecheck:spec',
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
    postMergeGate: ['npx tsc --noEmit', 'npm run typecheck:spec'],
    verifierGates: CANONICAL_GATES,
    relaxSettings: false,
  },
  livetests: {
    workerSlots: 1,
    verificationSlots: 1,
    maxRounds: 3,
    maxLoadAverage: 30,
    postMergeGate: ['npx tsc --noEmit', 'npm run typecheck:spec'],
    // A livetest mostly edits documents; the verifier judges evidence, and any
    // tracked code change still has to type-check and lint.
    verifierGates: ['npx tsc --noEmit', 'npm run lint'],
    relaxSettings: false,
  },
};
