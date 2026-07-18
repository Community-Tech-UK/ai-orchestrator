import { z } from 'zod';
import {
  FileAttachmentSchema,
  ModelIdSchema,
  WorkingDirectorySchema,
} from './common.schemas';

export const AutomationIdSchema = z.string().min(1).max(100);
export const AutomationRunIdSchema = z.string().min(1).max(100);
export const AutomationTriggerSchema = z.enum([
  'scheduled',
  'catchUp',
  'manual',
  'webhook',
  'channel',
  'providerRuntime',
  'orchestrationEvent',
]);
export const AutomationDeliveryModeSchema = z.enum(['notify', 'silent', 'localOnly']);
export const AutomationTriggerSourceSchema = z.object({
  type: AutomationTriggerSchema,
  id: z.string().max(200).optional(),
  eventType: z.string().max(200).optional(),
  deliveryId: z.string().max(500).optional(),
  instanceId: z.string().max(200).optional(),
  provider: z.string().max(100).optional(),
  channel: z.string().max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const AutomationMissedRunPolicySchema = z.enum(['skip', 'notify', 'runOnce']);
export const AutomationReasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'workflow',
]);

const AutomationFileAttachmentSchema = FileAttachmentSchema.extend({
  data: z.string().min(1),
});

export const AutomationScheduleSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('cron'),
    expression: z.string().min(1).max(200),
    timezone: z.string().min(1).max(100),
  }),
  z.object({
    type: z.literal('oneTime'),
    runAt: z.number().int().min(0),
    timezone: z.string().min(1).max(100).optional(),
  }),
]);

export const AutomationWebhookFilterSchema = z.object({
  path: z.string().min(1).max(120).regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/),
  operator: z.enum(['equals', 'contains']),
  value: z.string().min(1).max(1_000),
});

export const AutomationConfiguredTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('schedule') }),
  z.object({
    kind: z.literal('webhook'),
    routeId: z.string().min(1).max(100),
    filters: z.array(AutomationWebhookFilterSchema).max(10).default([]),
  }),
]);

export const AutomationActionSchema = z.object({
  prompt: z.string().min(1).max(500000),
  workingDirectory: WorkingDirectorySchema,
  provider: z.enum(['auto', 'claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok']).optional(),
  model: ModelIdSchema.optional(),
  agentId: z.string().max(100).optional(),
  yoloMode: z.boolean().optional(),
  reasoningEffort: AutomationReasoningEffortSchema.optional(),
  forceNodeId: z.string().uuid().optional(),
  attachments: z.array(AutomationFileAttachmentSchema).max(10).optional(),
  // WS5: spawn-loop action — the prompt becomes an autonomous loop goal.
  // verifyCommand is required (WS6 verification-authority policy).
  loop: z.object({
    verifyCommand: z.string().min(1).max(2000),
    isolateWorkspace: z.boolean().optional(),
    maxIterations: z.number().int().min(1).max(1000).optional(),
    maxCostCents: z.number().int().min(1).max(1_000_000).optional(),
    loopRecipe: z.string().min(1).max(100).optional(),
  }).optional(),
  systemAction: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('loopProviderLimitResume'),
      loopRunId: z.string().min(1).max(200),
    }),
    z.object({
      type: z.literal('instanceProviderLimitResume'),
      instanceId: z.string().min(1).max(200),
      resumePrompt: z.string().max(500000).optional(),
    }),
  ]).optional(),
});

export const AutomationDestinationSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('newInstance'),
  }),
  z.object({
    kind: z.literal('thread'),
    instanceId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200).optional(),
    historyEntryId: z.string().min(1).max(200).optional(),
    reviveIfArchived: z.boolean().default(true),
  }),
]);

export const AutomationCreatePayloadSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  enabled: z.boolean().optional(),
  schedule: AutomationScheduleSchema,
  trigger: AutomationConfiguredTriggerSchema.optional(),
  missedRunPolicy: AutomationMissedRunPolicySchema.optional(),
  concurrencyPolicy: z.enum(['skip', 'queue']).optional(),
  destination: AutomationDestinationSchema.default({ kind: 'newInstance' }),
  action: AutomationActionSchema,
});

export const AutomationUpdatePayloadSchema = z.object({
  id: AutomationIdSchema,
  updates: z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional(),
    enabled: z.boolean().optional(),
    schedule: AutomationScheduleSchema.optional(),
    trigger: AutomationConfiguredTriggerSchema.optional(),
    missedRunPolicy: AutomationMissedRunPolicySchema.optional(),
    concurrencyPolicy: z.enum(['skip', 'queue']).optional(),
    destination: AutomationDestinationSchema.optional(),
    action: AutomationActionSchema.optional(),
    active: z.boolean().optional(),
  }),
});

export const AutomationGetPayloadSchema = z.object({
  id: AutomationIdSchema,
});

export const AutomationDeletePayloadSchema = z.object({
  id: AutomationIdSchema,
});

export const AutomationRunNowPayloadSchema = z.object({
  id: AutomationIdSchema,
  idempotencyKey: z.string().max(500).optional(),
  triggerSource: AutomationTriggerSourceSchema.optional(),
  deliveryMode: AutomationDeliveryModeSchema.optional(),
});

export const AutomationCancelPendingPayloadSchema = z.object({
  id: AutomationIdSchema,
});

export const AutomationListRunsPayloadSchema = z.object({
  automationId: AutomationIdSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const AutomationMarkSeenPayloadSchema = z.object({
  automationId: AutomationIdSchema.optional(),
  runId: AutomationRunIdSchema.optional(),
}).refine((value) => value.automationId || value.runId, {
  message: 'automationId or runId is required',
});

export const AutomationPreflightPayloadSchema = z.object({
  workingDirectory: WorkingDirectorySchema,
  prompt: z.string().min(1).max(500000),
  provider: z.enum(['auto', 'claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok']).optional(),
  model: ModelIdSchema.optional(),
  yoloMode: z.boolean().optional(),
  expectedUnattended: z.boolean().optional(),
});

export const AutomationSchema = z.object({
  id: AutomationIdSchema,
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  enabled: z.boolean(),
  active: z.boolean(),
  workspaceId: z.string().min(1).max(1000),
  schedule: AutomationScheduleSchema,
  trigger: AutomationConfiguredTriggerSchema,
  missedRunPolicy: AutomationMissedRunPolicySchema,
  concurrencyPolicy: z.enum(['skip', 'queue']),
  destination: AutomationDestinationSchema,
  action: AutomationActionSchema,
  nextFireAt: z.number().int().nonnegative().nullable(),
  lastFiredAt: z.number().int().nonnegative().nullable(),
  lastRunId: AutomationRunIdSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  unreadRunCount: z.number().int().nonnegative().optional(),
  consecutiveFailures: z.number().int().nonnegative().optional(),
  lastFailureAt: z.number().int().nonnegative().nullable().optional(),
  lastFailureReason: z.string().nullable().optional(),
});

const AutomationConfigSnapshotSchema = z.object({
  name: z.string().min(1).max(200),
  schedule: AutomationScheduleSchema,
  trigger: AutomationConfiguredTriggerSchema,
  missedRunPolicy: AutomationMissedRunPolicySchema,
  concurrencyPolicy: z.enum(['skip', 'queue']),
  destination: AutomationDestinationSchema,
  action: AutomationActionSchema,
});

export const AutomationRunSchema = z.object({
  id: AutomationRunIdSchema,
  automationId: AutomationIdSchema,
  status: z.enum(['pending', 'running', 'succeeded', 'failed', 'skipped', 'cancelled']),
  trigger: AutomationTriggerSchema,
  scheduledAt: z.number().int().nonnegative(),
  startedAt: z.number().int().nonnegative().nullable(),
  finishedAt: z.number().int().nonnegative().nullable(),
  instanceId: z.string().min(1).max(200).nullable(),
  loopRunId: z.string().min(1).max(200).nullable(),
  error: z.string().nullable(),
  outputSummary: z.string().nullable(),
  outputFullRef: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  triggerSource: AutomationTriggerSourceSchema.nullable(),
  deliveryMode: AutomationDeliveryModeSchema,
  seenAt: z.number().int().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  configSnapshot: AutomationConfigSnapshotSchema.nullable(),
  attempt: z.number().int().positive(),
  maxAttempts: z.number().int().positive(),
});

export const AutomationChangedEventSchema = z.object({
  automation: AutomationSchema.nullable(),
  automationId: AutomationIdSchema,
  type: z.enum(['created', 'updated', 'deleted']),
}).strict();

export const AutomationRunChangedEventSchema = z.object({
  run: AutomationRunSchema,
  automationId: AutomationIdSchema,
}).strict();

export type AutomationCreatePayload = z.infer<typeof AutomationCreatePayloadSchema>;
export type AutomationUpdatePayload = z.infer<typeof AutomationUpdatePayloadSchema>;
export type AutomationGetPayload = z.infer<typeof AutomationGetPayloadSchema>;
export type AutomationDeletePayload = z.infer<typeof AutomationDeletePayloadSchema>;
export type AutomationRunNowPayload = z.infer<typeof AutomationRunNowPayloadSchema>;
export type AutomationListRunsPayload = z.infer<typeof AutomationListRunsPayloadSchema>;
export type AutomationPreflightPayload = z.infer<typeof AutomationPreflightPayloadSchema>;
