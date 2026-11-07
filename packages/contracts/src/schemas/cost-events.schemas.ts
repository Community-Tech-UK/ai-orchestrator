import { z } from 'zod';
import { InstanceIdSchema, SessionIdSchema, RequiredModelIdSchema } from './common.schemas';
import { CostModelUsageDeltaSchema } from './cost-model-usage.schemas';

const tokens = z.number().int().nonnegative();
const credits = z.number().nonnegative().finite();

/** Full cost entries cross the renderer boundary, including provider accounting. */
export const CostEntryEventSchema = z.object({
  id: z.string().min(1).max(200),
  timestamp: z.number().int().nonnegative(),
  instanceId: InstanceIdSchema,
  sessionId: SessionIdSchema,
  model: RequiredModelIdSchema,
  provider: z.string().min(1).max(100).optional(),
  inputTokens: tokens,
  outputTokens: tokens,
  cacheReadTokens: tokens.optional(),
  cacheWriteTokens: tokens.optional(),
  reasoningTokens: tokens.optional(),
  cost: z.number().nonnegative().finite(),
  isEstimated: z.boolean().optional(),
  aiCreditsNano: credits.optional(),
  premiumRequests: credits.optional(),
  creditCheckpointId: z.string().min(1).max(500).optional(),
  creditCheckpointTotalNano: credits.optional(),
  creditCheckpointPremiumTotal: credits.optional(),
  byModel: z.array(CostModelUsageDeltaSchema).max(100).optional(),
}).strict();
