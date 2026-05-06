import { z } from 'zod';

export const OperatorJsonObjectSchema = z.record(z.string(), z.unknown());

export const OperatorGetThreadPayloadSchema = z.object({}).optional();

export const OperatorSendMessagePayloadSchema = z.object({
  text: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const OperatorListProjectsPayloadSchema = z.object({
  query: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).optional();

export const OperatorRescanProjectsPayloadSchema = z.object({
  roots: z.array(z.string().min(1)).optional(),
  includeRecent: z.boolean().optional(),
  includeActiveInstances: z.boolean().optional(),
  includeConversationLedger: z.boolean().optional(),
}).optional();

export const OperatorRunStatusSchema = z.enum([
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'blocked',
]);

export const OperatorNodeTypeSchema = z.enum([
  'plan',
  'discover-projects',
  'project-agent',
  'repo-job',
  'workflow',
  'git-batch',
  'shell',
  'verification',
  'synthesis',
]);

export const OperatorRunEventKindSchema = z.enum([
  'state-change',
  'progress',
  'shell-command',
  'fs-write',
  'instance-spawn',
  'verification-result',
  'recovery',
  'budget',
]);

export const OperatorRunBudgetSchema = z.object({
  maxNodes: z.number().int().min(0),
  maxRetries: z.number().int().min(0),
  maxWallClockMs: z.number().int().min(1),
  maxTokens: z.number().int().min(0).optional(),
  maxConcurrentNodes: z.number().int().min(1),
});

export const OperatorRunUsageSchema = z.object({
  nodesStarted: z.number().int().min(0),
  nodesCompleted: z.number().int().min(0),
  retriesUsed: z.number().int().min(0),
  tokensUsed: z.number().int().min(0).optional(),
  wallClockMs: z.number().int().min(0),
});

export const OperatorPlanJsonSchema = OperatorJsonObjectSchema;
export const OperatorResultJsonSchema = OperatorJsonObjectSchema;
export const OperatorNodeInputJsonSchema = OperatorJsonObjectSchema;
export const OperatorNodeOutputJsonSchema = OperatorJsonObjectSchema;

const OperatorShellCommandPayloadSchema = z.object({
  cmd: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().min(0),
  stdoutBytes: z.number().int().min(0),
  stderrBytes: z.number().int().min(0),
  timedOut: z.boolean().optional(),
  error: z.string().optional(),
}).passthrough();

const OperatorFsWritePayloadSchema = z.object({
  path: z.string().min(1),
  bytesWritten: z.number().int().min(0),
  sha256: z.string().min(1),
  kind: z.enum(['create', 'modify', 'delete']),
}).passthrough();

const OperatorVerificationResultPayloadSchema = OperatorJsonObjectSchema.and(z.object({
  status: z.enum(['passed', 'failed', 'skipped']).optional(),
  checks: z.array(OperatorJsonObjectSchema).optional(),
}));

const OperatorInstanceSpawnPayloadSchema = z.object({
  instanceId: z.string().min(1),
  provider: z.string().min(1).optional(),
  workingDirectory: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  projectPath: z.string().min(1).optional(),
}).passthrough();

export const OperatorRunEventPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('state-change'), payload: OperatorJsonObjectSchema }),
  z.object({ kind: z.literal('progress'), payload: OperatorJsonObjectSchema }),
  z.object({ kind: z.literal('shell-command'), payload: OperatorShellCommandPayloadSchema }),
  z.object({ kind: z.literal('fs-write'), payload: OperatorFsWritePayloadSchema }),
  z.object({ kind: z.literal('instance-spawn'), payload: OperatorInstanceSpawnPayloadSchema }),
  z.object({ kind: z.literal('verification-result'), payload: OperatorVerificationResultPayloadSchema }),
  z.object({ kind: z.literal('recovery'), payload: OperatorJsonObjectSchema }),
  z.object({ kind: z.literal('budget'), payload: OperatorJsonObjectSchema }),
]);

export const OperatorListRunsPayloadSchema = z.object({
  threadId: z.string().min(1).optional(),
  status: OperatorRunStatusSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).optional();

export const OperatorRunIdPayloadSchema = z.object({
  runId: z.string().min(1),
});

export type OperatorGetThreadPayload = z.infer<typeof OperatorGetThreadPayloadSchema>;
export type OperatorSendMessagePayload = z.infer<typeof OperatorSendMessagePayloadSchema>;
export type OperatorListProjectsPayload = z.infer<typeof OperatorListProjectsPayloadSchema>;
export type OperatorRescanProjectsPayload = z.infer<typeof OperatorRescanProjectsPayloadSchema>;
export type OperatorListRunsPayload = z.infer<typeof OperatorListRunsPayloadSchema>;
export type OperatorRunIdPayload = z.infer<typeof OperatorRunIdPayloadSchema>;
export type OperatorRunBudgetPayload = z.infer<typeof OperatorRunBudgetSchema>;
export type OperatorRunUsagePayload = z.infer<typeof OperatorRunUsageSchema>;
export type OperatorRunEventPayload = z.infer<typeof OperatorRunEventPayloadSchema>;
