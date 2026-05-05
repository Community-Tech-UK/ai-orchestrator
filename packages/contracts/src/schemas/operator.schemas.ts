import { z } from 'zod';

export const OperatorGetThreadPayloadSchema = z.object({}).strict();

export const OperatorSendMessagePayloadSchema = z.object({
  text: z.string().trim().min(1).max(20_000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const OperatorListRunsPayloadSchema = z.object({
  limit: z.number().int().positive().max(500).optional(),
}).strict();

export const OperatorRunIdPayloadSchema = z.object({
  runId: z.string().min(1),
});

export const OperatorGetRunPayloadSchema = OperatorRunIdPayloadSchema;
export const OperatorCancelRunPayloadSchema = OperatorRunIdPayloadSchema;
export const OperatorRetryRunPayloadSchema = OperatorRunIdPayloadSchema;

export const OperatorListProjectsPayloadSchema = z.object({
  limit: z.number().int().positive().max(500).optional(),
}).strict();

export const OperatorRescanProjectsPayloadSchema = z.object({
  roots: z.array(z.string().min(1)).optional(),
}).strict();

export type OperatorGetThreadPayload = z.infer<typeof OperatorGetThreadPayloadSchema>;
export type OperatorSendMessagePayload = z.infer<typeof OperatorSendMessagePayloadSchema>;
export type OperatorListRunsPayload = z.infer<typeof OperatorListRunsPayloadSchema>;
export type OperatorRunIdPayload = z.infer<typeof OperatorRunIdPayloadSchema>;
export type OperatorGetRunPayload = z.infer<typeof OperatorGetRunPayloadSchema>;
export type OperatorListProjectsPayload = z.infer<typeof OperatorListProjectsPayloadSchema>;
export type OperatorRescanProjectsPayload = z.infer<typeof OperatorRescanProjectsPayloadSchema>;
