import { z } from 'zod';

export const RtkSummaryPayloadSchema = z
  .object({
    projectPath: z.string().min(1).max(4000).optional(),
    sinceMs: z.number().int().nonnegative().optional(),
    topN: z.number().int().min(1).max(100).optional(),
  })
  .optional()
  .default({});

export const RtkHistoryPayloadSchema = z
  .object({
    projectPath: z.string().min(1).max(4000).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
  })
  .optional()
  .default({});

export type RtkSummaryPayload = z.infer<typeof RtkSummaryPayloadSchema>;
export type RtkHistoryPayload = z.infer<typeof RtkHistoryPayloadSchema>;
