import { z } from 'zod';
import { InstanceIdSchema } from './common.schemas';

export const PromptHistoryEntrySchema = z.object({
  id: z.string().min(1).max(200),
  text: z.string().min(1).max(500000),
  createdAt: z.number().int().nonnegative(),
  projectPath: z.string().min(1).max(10000).optional(),
  provider: z.string().min(1).max(100).optional(),
  model: z.string().min(1).max(200).optional(),
  wasSlashCommand: z.boolean().optional(),
});

export const PromptHistoryRecordSchema = z.object({
  instanceId: InstanceIdSchema,
  entries: z.array(PromptHistoryEntrySchema).max(500),
  updatedAt: z.number().int().nonnegative(),
});

export const PromptHistoryProjectAliasSchema = z.object({
  projectPath: z.string().min(1).max(10000),
  entries: z.array(PromptHistoryEntrySchema).max(500),
  updatedAt: z.number().int().nonnegative(),
});

export const PromptHistoryGetSnapshotPayloadSchema = z.object({}).strict();

export const PromptHistoryRecordPayloadSchema = z.object({
  instanceId: InstanceIdSchema,
  entry: PromptHistoryEntrySchema,
});

export const PromptHistoryClearInstancePayloadSchema = z.object({
  instanceId: InstanceIdSchema,
});

export type PromptHistoryRecordPayload = z.infer<typeof PromptHistoryRecordPayloadSchema>;
export type PromptHistoryClearInstancePayload = z.infer<typeof PromptHistoryClearInstancePayloadSchema>;
