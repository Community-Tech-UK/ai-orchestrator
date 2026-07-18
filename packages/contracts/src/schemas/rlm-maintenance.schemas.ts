import { z } from 'zod';

export const RlmStorageHealthRequestSchema = z.object({}).strict();

export const RlmMaintenanceRequestSchema = z
  .object({
    loopRunId: z.string().min(1).optional(),
  })
  .strict();

export const RlmMaintenanceProgressEventSchema = z.object({
  operationId: z.string().min(1).max(500),
  stage: z.enum([
    'preparing',
    'backing-up',
    'pruning',
    'compacting',
    'reloading',
    'complete',
    'failed',
  ]),
  message: z.string().max(10_000),
  startedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();

export type RlmMaintenanceRequestPayload = z.infer<
  typeof RlmMaintenanceRequestSchema
>;
