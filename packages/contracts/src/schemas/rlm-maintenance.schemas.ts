import { z } from 'zod';

export const RlmStorageHealthRequestSchema = z.object({}).strict();

export const RlmMaintenanceRequestSchema = z
  .object({
    loopRunId: z.string().min(1).optional(),
  })
  .strict();

export type RlmMaintenanceRequestPayload = z.infer<
  typeof RlmMaintenanceRequestSchema
>;
