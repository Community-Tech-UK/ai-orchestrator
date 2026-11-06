import { z } from 'zod';
import { RequiredModelIdSchema } from './common.schemas';

/** Native per-model deltas attached to a priced completion. */
export const CostModelUsageDeltaSchema = z.object({
  model: RequiredModelIdSchema,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative().finite().optional(),
}).strict();
