import { z } from 'zod';
import {
  FileAttachmentSchema,
  WorkingDirectorySchema,
} from './common.schemas';

export const AutomationIdSchema = z.string().min(1).max(100);
export const AutomationRunIdSchema = z.string().min(1).max(100);

export const AutomationScheduleTypeSchema = z.enum(['cron', 'oneTime']);
export const AutomationMissedRunPolicySchema = z.enum(['skip', 'notify', 'runOnce']);
export const AutomationReasoningEffortSchema = z.enum([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
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

export const AutomationActionSchema = z.object({
  prompt: z.string().min(1).max(500000),
  workingDirectory: WorkingDirectorySchema,
  provider: z.enum(['auto', 'claude', 'codex', 'gemini', 'copilot', 'cursor']).optional(),
  model: z.string().max(100).optional(),
  agentId: z.string().max(100).optional(),
  yoloMode: z.boolean().optional(),
  reasoningEffort: AutomationReasoningEffortSchema.optional(),
  forceNodeId: z.string().uuid().optional(),
  attachments: z.array(AutomationFileAttachmentSchema).max(10).optional(),
});

export const AutomationCreatePayloadSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  enabled: z.boolean().optional(),
  schedule: AutomationScheduleSchema,
  missedRunPolicy: AutomationMissedRunPolicySchema.optional(),
  concurrencyPolicy: z.enum(['skip', 'queue']).optional(),
  action: AutomationActionSchema,
});

export const AutomationUpdatePayloadSchema = z.object({
  id: AutomationIdSchema,
  updates: AutomationCreatePayloadSchema.partial().extend({
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

export const AutomationValidateCronPayloadSchema = z.object({
  expression: z.string().min(1).max(200),
  timezone: z.string().min(1).max(100),
});

export type AutomationCreatePayload = z.infer<typeof AutomationCreatePayloadSchema>;
export type AutomationUpdatePayload = z.infer<typeof AutomationUpdatePayloadSchema>;
export type AutomationGetPayload = z.infer<typeof AutomationGetPayloadSchema>;
export type AutomationDeletePayload = z.infer<typeof AutomationDeletePayloadSchema>;
export type AutomationRunNowPayload = z.infer<typeof AutomationRunNowPayloadSchema>;
export type AutomationListRunsPayload = z.infer<typeof AutomationListRunsPayloadSchema>;
