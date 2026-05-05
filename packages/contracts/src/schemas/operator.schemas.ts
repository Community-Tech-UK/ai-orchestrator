import { z } from 'zod';

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
