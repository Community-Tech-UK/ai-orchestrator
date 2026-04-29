import { z } from 'zod';

import { InstanceIdSchema } from './common.schemas';

export const WorkflowStartSourceSchema = z.enum([
  'slash-command',
  'nl-suggestion',
  'automation',
  'manual-ui',
  'restore',
]);

export const WorkflowCanTransitionPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  templateId: z.string().min(1).max(200),
  source: WorkflowStartSourceSchema,
});

export const WorkflowNlSuggestPayloadSchema = z.object({
  promptText: z.string().min(1).max(500000),
  provider: z.string().max(100).optional(),
  workingDirectory: z.string().max(4000).optional(),
});
