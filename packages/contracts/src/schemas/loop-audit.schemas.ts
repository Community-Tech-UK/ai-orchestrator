import { z } from 'zod';

export const LoopFinalAuditModeSchema = z.enum(['off', 'observe', 'gate']);
export const LoopPreflightModeSchema = z.enum(['off', 'record', 'block']);
export const LoopPlanPacketModeSchema = z.enum(['off', 'prompted']);
export const LoopAuditStatusSchema = z.enum(['passed', 'failed', 'needs-review', 'skipped']);

export const LoopAuditConfigSchema = z.object({
  finalAuditMode: LoopFinalAuditModeSchema.default('observe'),
  preflightMode: LoopPreflightModeSchema.default('off'),
  planPacketMode: LoopPlanPacketModeSchema.default('off'),
  cleanlinessScan: z.boolean().default(true),
});

export const LoopAuditConfigInputSchema = z.object({
  finalAuditMode: LoopFinalAuditModeSchema.optional(),
  preflightMode: LoopPreflightModeSchema.optional(),
  planPacketMode: LoopPlanPacketModeSchema.optional(),
  cleanlinessScan: z.boolean().optional(),
});

export const LoopAuditFindingSchema = z.object({
  severity: z.enum(['blocking', 'review', 'info']),
  code: z.enum([
    'verify-failed',
    'ledger-open',
    'no-deliverable-change',
    'repo-state-unavailable',
    'plan-criteria-unproven',
    'cleanliness-blocking',
    'preflight-red-baseline',
    'audit-internal-error',
  ]),
  message: z.string(),
  file: z.string().optional(),
  detail: z.record(z.string(), z.unknown()).optional(),
});

export const LoopFinalAuditResultSchema = z.object({
  status: LoopAuditStatusSchema,
  ranAt: z.number().int(),
  coverage: z.object({
    criteriaTotal: z.number().int().nonnegative(),
    criteriaVerified: z.number().int().nonnegative(),
    criteriaUnverified: z.number().int().nonnegative(),
    verifyCommandRan: z.boolean(),
    repoComparisonRan: z.boolean(),
    cleanlinessScanRan: z.boolean(),
  }),
  findings: z.array(LoopAuditFindingSchema),
  changedFiles: z.array(z.string()),
  reportPath: z.string().optional(),
});

export const LoopPreflightResultSchema = z.object({
  status: z.enum(['passed', 'failed', 'skipped']),
  ranAt: z.number().int(),
  commands: z.array(z.object({
    label: z.enum(['quick-verify', 'verify', 'extra']),
    command: z.string(),
    status: z.enum(['passed', 'failed', 'skipped']),
    durationMs: z.number().int().nonnegative(),
    outputExcerpt: z.string(),
  })),
});

export const LoopRepoBaselineSnapshotSchema = z.object({
  source: z.enum(['git', 'none']),
  capturedAt: z.number().int(),
  workspaceCwd: z.string(),
  headRef: z.string().nullable(),
  dirtyAtStart: z.boolean(),
  trackedDirtyAtStart: z.array(z.string()),
  untrackedAtStart: z.array(z.string()),
  trackedDirtyHashes: z.record(z.string(), z.string()).optional(),
  untrackedHashes: z.record(z.string(), z.string()).optional(),
});

export const LoopPhaseSpecSchema = z.object({
  id: z.string(),
  title: z.string(),
  acceptanceCriteria: z.array(z.string()),
  requiredCommands: z.array(z.string()),
  evidence: z.array(z.string()),
});

export const LoopPlanPacketSummarySchema = z.object({
  roadmapPath: z.string(),
  phases: z.array(LoopPhaseSpecSchema),
  criteriaTotal: z.number().int().nonnegative(),
  criteriaWithEvidence: z.number().int().nonnegative(),
  malformed: z.boolean(),
});

export const LoopPhaseRecoveryStateSchema = z.object({
  phaseId: z.string(),
  consecutiveFailures: z.number().int().nonnegative(),
  lastFailureAt: z.number().int(),
  lastFindingCodes: z.array(z.string()),
});
