import { z } from 'zod';
import {
  LoopAuditConfigSchema,
  LoopAuditConfigInputSchema,
  LoopFinalAuditResultSchema,
  LoopPhaseRecoveryStateSchema,
  LoopPreflightResultSchema,
  LoopRepoBaselineSnapshotSchema,
} from './loop-audit.schemas';
import { LoopPhase4ConfigSchema } from './loop-phase4.schemas';
import { RequiredModelIdSchema } from './common.schemas';
export * from './loop-audit.schemas';
export * from './loop-phase4.schemas';

const LOOP_MAX_WALL_TIME_MS_SCHEMA_CAP = 7 * 24 * 60 * 60 * 1000;
export const LoopStageSchema = z.enum(['PLAN', 'REVIEW', 'IMPLEMENT']);
export const LoopGoalIntentSchema = z.enum(['implementation', 'investigation']);
export const LoopStatusSchema = z.enum([
  'running',
  'paused',
  'completed',
  // LF-7: successful "done but needs a human glance" terminal state.
  'completed-needs-review',
  'cancelled',
  'failed',
  'error',
  'no-progress',
  'cap-reached',
  // Usage-aware throttling; endedAt=null is resumable, endedAt set is terminal.
  'provider-limit',
  // Ping-pong terminals surface deadlock/unreliability instead of spinning.
  'cost-exceeded',
  'needs-human-arbitration',
  'reviewer-unreliable',
  // Reviewer provider unavailable (rate-limited / unreachable / no eligible
  // provider after fallback) — an availability fault, distinct from the reviewer
  // emitting unusable output (`reviewer-unreliable`).
  'reviewer-unavailable',
  'builder-unreliable',
  // LF-8: `idle` / `verify-failed` removed — dead states the coordinator never emitted.
]);

/** LF-7: outcome of the most recent completion attempt. Mirrors
 *  `LoopCompletionOutcome` in `src/shared/types/loop.types.ts`. */
export const LoopCompletionOutcomeSchema = z.enum([
  'accepted',
  'verify-failed',
  'unverifiable',
  'rename-gate',
  'review-blocked',
]);
export const LoopVerdictSchema = z.enum(['OK', 'WARN', 'CRITICAL']);
export const LoopVerifyFailureKindSchema = z.enum(['command', 'timeout', 'infra']);
export const LoopProviderSchema = z.enum(['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok']);
export const LoopReviewStyleSchema = z.enum(['single', 'debate', 'star-chamber']);
export const LoopContextStrategySchema = z.enum(['fresh-child', 'hybrid', 'same-session']);
export const ProgressSignalIdSchema = z.enum(['A', 'B', 'C', 'D', 'D-prime', 'E', 'F', 'G', 'H', 'I', 'BLOCKED']);
export const CompletionSignalIdSchema = z.enum([
  'completed-rename',
  'done-promise',
  'done-sentinel',
  'all-green',
  'self-declared',
  'plan-checklist',
  'declared-complete',
  // LF-4: every LOOP_TASKS.md item resolved (done/deferred).
  'ledger-complete',
]);

export const LoopHardCapsSchema = z.object({
  maxIterations: z.number().int().positive().max(1000).nullable(),
  maxWallTimeMs: z.number().int().positive().max(LOOP_MAX_WALL_TIME_MS_SCHEMA_CAP),
  maxTokens: z.number().int().positive().max(100_000_000).nullable(),
  maxCostCents: z.number().int().nonnegative().max(1_000_000).nullable(),
  maxToolCallsPerIteration: z.number().int().positive().max(10_000),
  /** LF-7: bound on verified-but-ungated completion attempts before the loop
   *  stops as `cap-reached`. Optional; defaults to 3 via `defaultLoopConfig`. */
  maxCompletionAttempts: z.number().int().positive().max(100).optional(),
  /** D2 (#6 interim): one final prompt-only wrap-up iteration on cap-out.
   *  Mirrors `LoopHardCaps.capWrapUpIteration`. Optional; defaults true. */
  capWrapUpIteration: z.boolean().optional(),
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
  /**
   * Opt-in to signal F (token-burn-without-test-progress). Defaults to
   * false so existing persisted configs (which never had this field) and
   * new programmatic callers that omit it both behave the same way: no
   * automatic pause on token spend alone.
   */
  pauseOnTokenBurn: z.boolean().default(false),
  toolRepeatWarnPerIteration: z.number().int().min(2).max(1000),
  toolRepeatCriticalPerIteration: z.number().int().min(2).max(1000),
  identicalToolCallConsecutiveCritical: z.number().int().min(2).max(100).default(3),
  idempotentReadRepeatWarn: z.number().int().min(2).max(100).default(3),
  testStagnationWarnIterations: z.number().int().min(1).max(50),
  testStagnationCriticalIterations: z.number().int().min(1).max(50),
  churnRatioWarn: z.number().min(0).max(1),
  churnRatioCritical: z.number().min(0).max(1),
  warnEscalationWindow: z.number().int().min(2).max(50),
  warnEscalationCount: z.number().int().min(2).max(50),
});

/**
 * Severity levels used by the fresh-eyes cross-model review gate to decide
 * whether a finding blocks completion. Mirrors `HeadlessReviewSeverity`
 * from `src/main/cli-entrypoints/review-command-output.ts`.
 */
export const LoopReviewSeveritySchema = z.enum(['critical', 'high', 'medium', 'low']);

/**
 * Optional configuration block on `LoopCompletionConfig.crossModelReview`.
 * Mirrors `LoopCrossModelReviewConfig` in `src/shared/types/loop.types.ts`.
 * Both surfaces must stay in lockstep — see AGENTS.md "Type vs schema drift".
 */
/**
 * Conversational ping-pong review config. Mirrors `LoopPingPongConfig` in
 * `src/shared/types/loop-pingpong.types.ts` — keep both in lockstep.
 */
export const LoopPingPongConfigSchema = z.object({
  enabled: z.boolean(),
  reviewerProvider: z
    .enum(['auto', 'claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok'])
    .optional(),
  subject: z.enum(['auto', 'plan', 'impl']).optional(),
  maxRounds: z.number().int().min(1).max(20).optional(),
  freshReviewerEachRound: z.boolean().optional(),
});

/** One durable ping-pong ledger issue. Mirrors `PingPongIssue`. */
export const PingPongIssueSchema = z.object({
  id: z.string(),
  title: z.string(),
  severity: LoopReviewSeveritySchema,
  status: z.enum(['open', 'resolved', 'rebutted', 'regression']),
  evidence: z.string(),
  file: z.string().optional(),
  raisedRound: z.number().int().nonnegative(),
  lastSeenRound: z.number().int().nonnegative(),
  builderResponse: z.string().optional(),
});

/** Mutable ping-pong runtime state. Mirrors `LoopPingPongState`. */
export const LoopPingPongStateSchema = z.object({
  roundCount: z.number().int().nonnegative(),
  subject: z.enum(['plan', 'impl']).optional(),
  ledger: z.array(PingPongIssueSchema),
  inFlightReviewerInstanceId: z.string().optional(),
  inFlightRound: z.number().int().nonnegative().optional(),
  consecutiveUnreliableRounds: z.number().int().nonnegative(),
  consecutiveContradictoryRounds: z.number().int().nonnegative(),
  builderUnaddressedRounds: z.number().int().nonnegative(),
  lowOnlyChurnRounds: z.number().int().nonnegative(),
  lastReviewerProvider: z.string().optional(),
  triedReviewerProviders: z.array(z.string()).optional(),
  skipNextRound: z.boolean().optional(),
  forceArbitration: z.boolean().optional(),
  reviewerTokensUsed: z.number().int().nonnegative(),
  reviewerCostCents: z.number().int().nonnegative(),
});

export const LoopCrossModelReviewConfigSchema = z.object({
  enabled: z.boolean(),
  reviewers: z.array(z.string().min(1)).optional(),
  blockingSeverities: z.array(LoopReviewSeveritySchema).min(1),
  timeoutSeconds: z.number().int().positive().max(60 * 60),
  reviewDepth: z.enum(['structured', 'tiered']),
  /** Ping-pong mode (bigchange_pingpong_review). Drives a dedicated branch. */
  pingPong: LoopPingPongConfigSchema.optional(),
});

export const LoopCompletionModeSchema = z.enum(['review-driven', 'gated']);

export const LoopCompletionConfigSchema = z.object({
  /** Completion strategy. Undefined is treated as 'gated' by the engine;
   *  user-started loops are defaulted to 'review-driven' at start-config. */
  mode: LoopCompletionModeSchema.optional(),
  /** review-driven: consecutive clean fresh-eyes passes required to stop. */
  requiredCleanReviewPasses: z.number().int().positive().max(20).optional(),
  /** review-driven: preferred no-actionable-issues wording / high-confidence shortcut. */
  noOutstandingPhrase: z.string().min(1).optional(),
  /** review-driven: max consecutive CRITICAL no-progress iterations (no prod
   *  change, no clean-streak advance) before stopping as completed-needs-review.
   *  Mirrors `LoopCompletionConfig.maxStalledReviewIterations`. Default 3. */
  maxStalledReviewIterations: z.number().int().positive().max(1000).optional(),
  /** review-driven: max consecutive iterations the LOOP_TASKS.md open-item count
   *  may fail to reach a new low before stopping as completed-needs-review.
   *  Mirrors `LoopCompletionConfig.maxLedgerStallIterations`. Default 8. */
  maxLedgerStallIterations: z.number().int().positive().max(1000).optional(),
  completedFilenamePattern: z.string().min(1),
  donePromiseRegex: z.string().min(1),
  doneSentinelFile: z.string().min(1),
  verifyCommand: z.string(),
  allowOperatorReviewedCompletion: z.boolean().default(false),
  verifyTimeoutMs: z.number().int().positive().max(60 * 60 * 1000),
  /** FU-6: optional cheap verify run BEFORE the heavyweight verifyCommand.
   *  When configured and the cheap run fails, the loop rejects completion
   *  without spending the full verify. When the cheap run passes (or no
   *  command is set), the full verify runs unchanged. */
  quickVerifyCommand: z.string().optional(),
  quickVerifyTimeoutMs: z.number().int().positive().max(60 * 60 * 1000).optional(),
  runVerifyTwice: z.boolean(),
  requireCompletedFileRename: z.boolean(),
  /** F2 (#22): cap on coordinator-enforced REVIEW→PLAN back-edges per run.
   *  0 disables the enforced back-edge. Mirrors
   *  `LoopCompletionConfig.maxReviewCycles`. Default 10. */
  maxReviewCycles: z.number().int().min(0).max(1000).optional(),
  /** D6 (#7): anti-self-grading verification hardening (caveated
   *  declared-complete demotion + stale-verify gate + prompt discipline).
   *  Mirrors `LoopCompletionConfig.antiSelfGrading`. Default false. */
  antiSelfGrading: z.boolean().optional(),
  /** WS4 durable verification execution-ledger enforcement. */
  evidenceLedger: z.boolean().optional(),
  /** Optional. When set, the loop coordinator runs a different CLI provider
   *  as a fresh-eyes reviewer before accepting completion. Blocking findings
   *  re-open the loop with the findings injected as user interventions. */
  crossModelReview: LoopCrossModelReviewConfigSchema.optional(),
});

/**
 * LF-2 — semantic-progress signal config. Mirrors `LoopSemanticProgressConfig`
 * in `src/shared/types/loop.types.ts` (AGENTS.md "type vs schema drift").
 * Optional on LoopConfig; default off.
 */
export const LoopSemanticProgressConfigSchema = z.object({
  enabled: z.boolean(),
  cadence: z.number().int().min(1).max(100),
  confidenceFloor: z.number().min(0).max(1),
});

/** LF-2 — per-iteration semantic-progress verdict. Mirrors `LoopSemanticProgressResult`. */
export const LoopSemanticProgressResultSchema = z.object({
  advanced: z.boolean(),
  whatChanged: z.string(),
  confidence: z.number().min(0).max(1),
});

/**
 * LF-1 — context discipline config. Mirrors `LoopContextConfig` /
 * `LoopContextCompactionConfig` in `src/shared/types/loop.types.ts`. Optional on
 * LoopConfig; defaults to on via `defaultLoopContextConfig()`.
 */
export const LoopContextCompactionConfigSchema = z.object({
  enabled: z.boolean(),
  resetAtUtilization: z.number().min(0.1).max(0.95),
  clearToolResults: z.boolean(),
});

export const LoopContextConfigSchema = z.object({
  compaction: LoopContextCompactionConfigSchema,
});

/**
 * LF-5 — branch-and-select (best-of-N) config. Mirrors `LoopExplorationConfig`
 * in `src/shared/types/loop.types.ts`. Optional on LoopConfig; default off.
 */
export const LoopExplorationConfigSchema = z.object({
  enabled: z.boolean(),
  fanout: z.number().int().min(2).max(8),
  crossModel: z.boolean(),
  selector: z.enum(['verify', 'verify+listwise']),
});

/** LF-4 — disposable-plan config. Mirrors `LoopPlanConfig`. Optional; default off. */
export const LoopPlanConfigSchema = z.object({
  regenerateOnStall: z.boolean(),
});

/** G3 — serializable next-objective planner config. Optional; default off. */
export const LoopNextObjectivePlanningConfigSchema = z.object({
  enabled: z.boolean(),
  cadence: z.number().int().min(1).max(50).default(1),
});

export const LoopConfigSchema = z.object({
  /** The goal/ask. Sent on iteration 0 and is what the loop drives toward. */
  initialPrompt: z.string().min(1, 'initialPrompt cannot be empty'),
  /** The continuation directive used on iterations 1+. If omitted, the loop
   *  re-uses `initialPrompt` for every iteration (legacy behaviour). When
   *  set, iter 0 = goal, iter 1+ = this directive (e.g. "please continue,
   *  re-review with fresh eyes"). State on disk + the stage machine carry
   *  context forward between iterations. */
  iterationPrompt: z.string().optional(),
  planFile: z.string().optional(),
  workspaceCwd: z.string().min(1),
  provider: LoopProviderSchema,
  reviewStyle: LoopReviewStyleSchema,
  contextStrategy: LoopContextStrategySchema,
  caps: LoopHardCapsSchema,
  progressThresholds: LoopProgressThresholdsSchema,
  semanticProgress: LoopSemanticProgressConfigSchema.optional(),
  context: LoopContextConfigSchema.optional(),
  exploration: LoopExplorationConfigSchema.optional(),
  plan: LoopPlanConfigSchema.optional(),
  phase4: LoopPhase4ConfigSchema.optional(),
  audit: LoopAuditConfigSchema.default({
    finalAuditMode: 'observe',
    preflightMode: 'off',
    planPacketMode: 'off',
    cleanlinessScan: true,
  }),
  nextObjectivePlanning: LoopNextObjectivePlanningConfigSchema.optional(),
  completion: LoopCompletionConfigSchema,
  allowDestructiveOps: z.boolean(),
  initialStage: LoopStageSchema,
  /** Implementation task vs investigation/audit goal. Optional; main process
   *  derives it from the prompt when omitted (an explicit value wins). */
  goalIntent: LoopGoalIntentSchema.optional(),
  /** Wall-clock cap for a single iteration's CLI invocation, ms. The
   *  outer caps.maxWallTimeMs covers the whole loop run. */
  iterationTimeoutMs: z.number().int().positive().max(2 * 60 * 60 * 1000).optional(),
  /** Stream-idle advisory threshold for a single iteration's CLI invocation,
   *  ms. The adapter may log/report silence, but the iteration's wall-clock
   *  timeout remains the hard abort path. */
  streamIdleTimeoutMs: z.number().int().positive().max(15 * 60 * 1000).optional(),
  /** When true, each loop session runs in its own isolated git worktree.
   *  The coordinator acquires a fresh branch off the repo root on start and
   *  harvests any uncommitted agent work to that branch on termination.
   *  Default: false (backward-compatible). */
  isolateLoopWorkspaces: z.boolean().optional(),
  /** Absolute path to the per-session worktree. Set automatically by the
   *  coordinator when isolateLoopWorkspaces is true; may also be set by
   *  callers directly. Omit to default to workspaceCwd. */
  executionCwd: z.string().optional(),
  /** Branch name of the per-session worktree. Set automatically alongside
   *  executionCwd when isolateLoopWorkspaces is true. Read-only after start. */
  worktreeBranch: z.string().optional(),
  /** Auto-integrate the session branch into a shared `integration/<base>` branch
   *  on terminal-success (via a dedicated integration worktree, never the root
   *  checkout). Default: true when isolateLoopWorkspaces is true. */
  autoIntegrateWorktree: z.boolean().optional(),
});

/** Partial config the renderer may submit; main process fills defaults. */
export const LoopConfigInputSchema = LoopConfigSchema.omit({ audit: true }).partial({
  caps: true,
  progressThresholds: true,
  completion: true,
  contextStrategy: true,
  reviewStyle: true,
  provider: true,
  allowDestructiveOps: true,
  initialStage: true,
  planFile: true,
  phase4: true,
}).extend({
  audit: LoopAuditConfigInputSchema.optional(),
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
  resultHash: z.string().optional(),
  success: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  /** E2 (#12): agent-declared tool timeout (ms), when present in the raw input. */
  declaredTimeoutMs: z.number().positive().optional(),
});

export const LoopPendingInputKindSchema = z.enum(['steer', 'queue', 'follow-up']);
/** Task 18 drain policy. Mirrors `LoopQueueDrainMode`. */
export const LoopQueueDrainModeSchema = z.enum(['all', 'one-at-a-time']);
export const LoopPendingInputSourceSchema = z.enum([
  'human', 'block-override', 'plan-regen', 'phase-recovery',
  'context-survival', 'announce-then-halt', 'subagent-result', 'wakeup',
  'cap-wrap-up',
]);

export const LoopPendingInputSchema = z.object({
  id: z.string().min(1),
  kind: LoopPendingInputKindSchema,
  message: z.string().min(1),
  enqueuedAt: z.number().int().nonnegative(),
  source: LoopPendingInputSourceSchema,
  /** Task 18 drain policy; absent is treated as `all`. */
  drainMode: LoopQueueDrainModeSchema.optional(),
});

const LegacyLoopPendingInputSchema = z.string().min(1).transform((message) => ({
  id: `legacy-${Math.abs(hashPendingMessage(message))}`,
  kind: 'queue' as const,
  message,
  enqueuedAt: 0,
  source: 'human' as const,
}));

function hashPendingMessage(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = Math.imul(31, hash) + input.charCodeAt(i);
  }
  return hash;
}

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
  /** Structured open-item count for the `ledger-complete` signal (0 when the
   *  ledger is fully resolved). Undefined for every other signal id. Mirrors
   *  `CompletionSignalEvidence.openCount`. WS2: counts open LEAF items only. */
  openCount: z.number().int().nonnegative().optional(),
  /** WS2: stable ids of the unresolved leaf tasks behind `openCount` (capped).
   *  Present only on the `ledger-complete` signal. Mirrors
   *  `CompletionSignalEvidence.openLeafIds`. */
  openLeafIds: z.array(z.string()).optional(),
});

/** WS2/WS3: ledger task state persisted in the convergence tracker. Mirrors
 *  `LoopLedgerTaskState`. */
export const LoopLedgerTaskStateSchema = z.enum(['todo', 'doing', 'done', 'deferred']);

/** WS2/WS3: persisted known-leaf-task inventory for transition-based
 *  convergence. Mirrors `LedgerConvergenceState`. Optional on LoopState so
 *  old checkpoints (legacy count fields only) remain readable. */
export const LedgerConvergenceStateSchema = z.object({
  version: z.literal(1),
  knownTaskStates: z.record(z.string(), LoopLedgerTaskStateSchema),
  plannedLeafIds: z.array(z.string()),
  discoveredLeafIds: z.array(z.string()),
  noMeaningfulTransitionIterations: z.number().int().nonnegative(),
  lastObjectiveEvidenceKey: z.string().optional(),
  /** True while the last snapshot had duplicate/malformed ids (repair = progress). */
  inventoryInvalid: z.boolean().optional(),
});

export const LoopTerminalIntentKindSchema = z.enum(['complete', 'block', 'fail', 'wakeup']);
export const LoopTerminalIntentStatusSchema = z.enum(['pending', 'accepted', 'deferred', 'rejected', 'superseded']);
export const LoopTerminalIntentSourceSchema = z.enum(['loop-control-cli', 'imported-file']);
export const LoopTerminalIntentEvidenceKindSchema = z.enum(['summary', 'command', 'file', 'test', 'note']);

export const LoopTerminalIntentEvidenceSchema = z.object({
  kind: LoopTerminalIntentEvidenceKindSchema,
  label: z.string(),
  value: z.string(),
});

export const LoopTerminalIntentSchema = z.object({
  id: z.string(),
  loopRunId: z.string(),
  iterationSeq: z.number().int().nonnegative(),
  kind: LoopTerminalIntentKindSchema,
  summary: z.string(),
  evidence: z.array(LoopTerminalIntentEvidenceSchema),
  source: LoopTerminalIntentSourceSchema,
  createdAt: z.number().int(),
  receivedAt: z.number().int(),
  status: LoopTerminalIntentStatusSchema,
  statusReason: z.string().optional(),
  filePath: z.string().optional(),
  resumeAt: z.number().int().positive().optional(),
}).superRefine((intent, ctx) => {
  if (intent.kind === 'wakeup' && intent.resumeAt === undefined) {
    ctx.addIssue({ code: 'custom', path: ['resumeAt'], message: 'wakeup intents require resumeAt' });
  }
});

export const LoopControlMetadataSchema = z.object({
  version: z.literal(1),
  loopRunId: z.string(),
  workspaceCwd: z.string(),
  controlDir: z.string(),
  controlFile: z.string(),
  intentsDir: z.string(),
  currentIterationSeq: z.number().int().nonnegative(),
  cliPath: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export const LoopInFlightIterationSchema = z.object({
  seq: z.number().int().nonnegative(),
  stage: LoopStageSchema,
  startedAt: z.number().int(),
  idempotencyKey: z.string().min(1),
});

export const LoopContextWindowCalibrationSchema = z.object({
  provider: LoopProviderSchema,
  model: RequiredModelIdSchema.optional(),
  windowTokens: z.number().int().positive(),
  calibratedAt: z.number().int().nonnegative(),
  source: z.literal('provider-error'),
  reason: z.string().min(1),
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
  filesRead: z.array(z.string()).default([]),
  toolCalls: z.array(LoopToolCallRecordSchema),
  errors: z.array(LoopErrorRecordSchema),
  testPassCount: z.number().int().nullable(),
  testFailCount: z.number().int().nullable(),
  finishReason: z.string().optional(),
  unresolvedToolCalls: z.boolean().default(false),
  workHash: z.string(),
  outputSimilarityToPrev: z.number().min(0).max(1).nullable(),
  outputExcerpt: z.string(),
  // Verbatim agent closing message (bounded by boundFullOutput). `.default('')`
  // keeps pre-migration persisted iterations and older live payloads valid.
  outputFull: z.string().default(''),
  progressVerdict: LoopVerdictSchema,
  progressSignals: z.array(ProgressSignalEvidenceSchema),
  completionSignalsFired: z.array(CompletionSignalEvidenceSchema),
  verifyStatus: z.enum(['not-run', 'passed', 'failed']),
  verifyOutputExcerpt: z.string(),
  verifyFailureKind: LoopVerifyFailureKindSchema.optional(),
  /** Optional local-model TL;DR of a failed verify command (operator UX). */
  verifySummary: z.string().optional(),
  finalAudit: LoopFinalAuditResultSchema.optional(),
  semanticProgress: LoopSemanticProgressResultSchema.optional(),
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
  repoBaseline: LoopRepoBaselineSnapshotSchema.optional(),
  preflight: LoopPreflightResultSchema.optional(),
  latestFinalAudit: LoopFinalAuditResultSchema.optional(),
  phaseRecovery: z.record(z.string(), LoopPhaseRecoveryStateSchema).optional(),
  pendingInterventions: z.array(z.union([LoopPendingInputSchema, LegacyLoopPendingInputSchema])),
  loopControl: LoopControlMetadataSchema.optional(),
  inFlightIteration: LoopInFlightIterationSchema.optional(),
  terminalIntentPending: LoopTerminalIntentSchema.optional(),
  terminalIntentHistory: z.array(LoopTerminalIntentSchema).default([]),
  completedFileRenameObserved: z.boolean(),
  /** True iff DONE.txt existed at startLoop. Defends against stale sentinels
   *  from a prior run by ensuring done-sentinel only fires on a transition. */
  doneSentinelPresentAtStart: z.boolean(),
  /** True iff configured planFile was already fully checked at startLoop. */
  planChecklistFullyCheckedAtStart: z.boolean(),
  /** Root-level uncompleted plan-like *.md filenames present at startLoop.
   *  Used to auto-enable requireCompletedFileRename when uncompleted plans
   *  exist and the caller didn't explicitly configure the rename gate. */
  uncompletedPlanFilesAtStart: z.array(z.string()).default([]),
  /** FU-2: true when no `verifyCommand` is configured. The loop can still
   *  run but cannot auto-complete — every completion attempt will pause
   *  the run for operator review. Surfaced to the renderer so the UI can
   *  label these runs and to the iteration prompt so the agent learns the
   *  constraint upfront. Defaults to false for back-compat with paused
   *  rows persisted before the field existed. */
  manualReviewOnly: z.boolean().default(false),
  tokensSinceLastTestImprovement: z.number().int().nonnegative(),
  highestTestPassCount: z.number().int().nonnegative(),
  iterationsOnCurrentStage: z.number().int().nonnegative(),
  recentWarnIterationSeqs: z.array(z.number().int().nonnegative()),
  /** LF-7: verified-but-ungated completion-attempt counter. Defaults to 0 for
   *  back-compat with loop-state rows persisted before the field existed. */
  completionAttempts: z.number().int().nonnegative().default(0),
  announceThenHaltNudgeCount: z.number().int().nonnegative().default(0),
  /** LF-7: outcome of the most recent completion attempt. Optional for
   *  back-compat with rows persisted before the field existed. */
  lastCompletionOutcome: LoopCompletionOutcomeSchema.optional(),
  /** D6 (#7): work-hash recorded at the last PASSING verify (edit-invalidates-
   *  proof staleness anchor). Mirrors `LoopState.lastVerifiedWorkHash`. */
  lastVerifiedWorkHash: z.string().optional(),
  /** D6 (#7): cached clean fresh-eyes verdict, valid while no production file
   *  changed since. Mirrors `LoopState.freshEyesCleanForWorkState`. */
  freshEyesCleanForWorkState: z.boolean().optional(),
  /** B6: runtime context-window calibration learned from a provider overflow. */
  contextWindowCalibration: LoopContextWindowCalibrationSchema.optional(),
  /** LF-4: LOOP_TASKS.md fully resolved at startLoop (staleness guard).
   *  Defaults false for back-compat with rows written before the field. */
  loopTasksLedgerResolvedAtStart: z.boolean().default(false),
  /** Lowest LOOP_TASKS.md open-item count observed so far this run (undefined
   *  until the first ledger reading). Mirrors `LoopState.ledgerOpenCountBest`. */
  ledgerOpenCountBest: z.number().int().nonnegative().optional(),
  /** Consecutive iterations since the ledger open-count last reached a new low.
   *  Mirrors `LoopState.ledgerNoImprovementIterations`. */
  ledgerNoImprovementIterations: z.number().int().nonnegative().optional(),
  /** WS2/WS3: transition-based convergence tracker (known leaf-task inventory).
   *  Optional for back-compat with checkpoints that carry only the two legacy
   *  count fields above. Mirrors `LoopState.ledgerConvergence`. */
  ledgerConvergence: LedgerConvergenceStateSchema.optional(),
  /** F2 (#22): coordinator-enforced REVIEW→PLAN back-edge count this run.
   *  Mirrors `LoopState.reviewCycles`. Optional for back-compat with rows
   *  persisted before the field existed. */
  reviewCycles: z.number().int().nonnegative().optional(),
  /** A3 (#29): paused because blocked on operator input (sticky waiting state
   *  exempt from stall kills). Mirrors `LoopState.pausedForInput`. */
  pausedForInput: z.boolean().optional(),
  /** B5: marks that the prior iteration reset/compacted the context; consumed by
   *  the next iteration's post-compaction health canary. Mirrors
   *  `LoopState.justCompacted`. */
  justCompacted: z.object({
    seq: z.number().int().nonnegative(),
    reason: z.string(),
  }).optional(),
  /** Ping-pong runtime state (round count, issue ledger, reviewer spend).
   *  Optional — only present on loops running in ping-pong mode. */
  pingPong: LoopPingPongStateSchema.optional(),
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
  /** The goal/ask the loop was started with (iteration 0 prompt). Surfaced
   *  so the renderer can let users copy/inspect/reattempt past prompts even
   *  after an app reload, without needing to re-open the original config. */
  initialPrompt: z.string(),
  /** Optional continuation directive used on iterations 1+. Null when the
   *  loop re-used `initialPrompt` for every iteration. */
  iterationPrompt: z.string().nullable(),
  /** Count of still-open outstanding items captured from this run. Optional —
   *  only populated by callers that join the outstanding table. */
  openOutstandingCount: z.number().int().nonnegative().optional(),
});

/** Read-only projection of a coordinator-observed verification execution.
 * Deliberately excludes cwd, canonical command, and output references: the
 * loop detail panel needs the command, result, timing, and work-state anchor,
 * not internal filesystem paths or raw verifier output. */
export const VerificationRunPayloadSchema = z.object({
  id: z.string(),
  scope: z.enum(['loop', 'instance']),
  loopRunId: z.string().nullable(),
  instanceId: z.string().nullable(),
  command: z.string(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative(),
  workHash: z.string().nullable(),
  startedAt: z.number().int(),
});

// ============ Outstanding items ============

export const LoopOutstandingItemKindSchema = z.enum(['needs-human', 'open-question']);
export const LoopOutstandingItemStatusSchema = z.enum(['open', 'resolved', 'dismissed']);

export const LoopOutstandingItemSchema = z.object({
  id: z.string(),
  loopRunId: z.string(),
  chatId: z.string(),
  workspaceCwd: z.string(),
  kind: LoopOutstandingItemKindSchema,
  text: z.string(),
  /** The human's recorded decision/answer, or null when none entered yet.
   *  `.nullish()` for back-compat with rows persisted before the column existed. */
  userResponse: z.string().nullish(),
  /** The agent's recommended decision/answer for this item, or null when none.
   *  Pre-fills the answer box as an editable suggestion (never auto-accepted).
   *  `.nullish()` for back-compat with rows persisted before the column existed. */
  recommendedAnswer: z.string().nullish(),
  status: LoopOutstandingItemStatusSchema,
  loopStatus: LoopStatusSchema,
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  resolvedAt: z.number().int().nullable(),
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
  kind: LoopPendingInputKindSchema.optional(),
  /** Task 18: drain policy for a `follow-up` message (absent = `all`). */
  drainMode: LoopQueueDrainModeSchema.optional(),
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

/** Query exactly one verification-run owner. A union would produce less useful
 * errors for an accidental empty or double-scoped renderer request. */
export const VerificationRunsListPayloadSchema = z.object({
  loopRunId: z.string().min(1).optional(),
  instanceId: z.string().min(1).optional(),
}).superRefine((payload, ctx) => {
  if ((payload.loopRunId ? 1 : 0) + (payload.instanceId ? 1 : 0) !== 1) {
    ctx.addIssue({
      code: 'custom',
      message: 'Exactly one of loopRunId or instanceId is required',
    });
  }
});

/** LF-3a: preview the auto-inferred verify command for a workspace. */
export const LoopInferVerifyPayloadSchema = z.object({
  workspaceCwd: z.string().min(1),
});

export const LoopListOutstandingPayloadSchema = z.object({
  /** Scope to one chat/session. Omit only for cross-session administrative views. */
  chatId: z.string().min(1).optional(),
  /** Scope to one workspace. Omit to list across all workspaces. */
  workspaceCwd: z.string().min(1).optional(),
  /** Resolution filter. Defaults server-side to `'open'`. */
  status: z.enum(['open', 'resolved', 'dismissed', 'all']).optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

export const LoopSetOutstandingStatusPayloadSchema = z.object({
  id: z.string().min(1),
  status: LoopOutstandingItemStatusSchema,
  /** Optional human answer/decision to persist alongside the status change.
   *  Omit to leave any existing answer untouched; pass '' to clear it. */
  response: z.string().optional(),
});

export const LoopExportOutstandingPayloadSchema = z.object({
  /** Optional session scope for the exported backlog. */
  chatId: z.string().min(1).optional(),
  workspaceCwd: z.string().min(1),
  /** Optional absolute destination path. Defaults to `<workspaceCwd>/OUTSTANDING.md`. */
  destPath: z.string().min(1).optional(),
});

export const LoopResumeWithAnswersPayloadSchema = z.object({
  /** Session/instance the outstanding items belong to (also the new run's chatId). */
  chatId: z.string().min(1),
  /** Workspace the resumed run executes in. */
  workspaceCwd: z.string().min(1),
  /** Optional explicit source run to reuse config from. Defaults to the run that
   *  produced the most-recent answered item in scope. */
  loopRunId: z.string().min(1).optional(),
});

// ============ Inferred types ============

export type LoopConfigPayload = z.infer<typeof LoopConfigSchema>;
export type LoopConfigInput = z.infer<typeof LoopConfigInputSchema>;
export type LoopStatePayload = z.infer<typeof LoopStateSchema>;
export type LoopIterationPayload = z.infer<typeof LoopIterationSchema>;
export type LoopRunSummaryPayload = z.infer<typeof LoopRunSummarySchema>;
export type VerificationRunPayload = z.infer<typeof VerificationRunPayloadSchema>;
export type LoopTerminalIntentPayload = z.infer<typeof LoopTerminalIntentSchema>;
export type LoopStartPayload = z.infer<typeof LoopStartPayloadSchema>;
export type LoopAttachment = z.infer<typeof LoopAttachmentSchema>;
export type LoopByIdPayload = z.infer<typeof LoopByIdPayloadSchema>;
export type LoopInterveneePayload = z.infer<typeof LoopInterveneePayloadSchema>;
export type LoopListByChatPayload = z.infer<typeof LoopListByChatPayloadSchema>;
export type LoopGetIterationsPayload = z.infer<typeof LoopGetIterationsPayloadSchema>;
export type VerificationRunsListPayload = z.infer<typeof VerificationRunsListPayloadSchema>;
export type LoopInferVerifyPayload = z.infer<typeof LoopInferVerifyPayloadSchema>;
export type LoopOutstandingItemPayload = z.infer<typeof LoopOutstandingItemSchema>;
export type LoopListOutstandingPayload = z.infer<typeof LoopListOutstandingPayloadSchema>;
export type LoopSetOutstandingStatusPayload = z.infer<typeof LoopSetOutstandingStatusPayloadSchema>;
export type LoopExportOutstandingPayload = z.infer<typeof LoopExportOutstandingPayloadSchema>;
