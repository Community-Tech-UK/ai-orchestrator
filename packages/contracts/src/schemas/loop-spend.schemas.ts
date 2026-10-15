import { z } from 'zod';
export const LoopSpendTotalsSchema = z.object({ tokens: z.number().int().nonnegative(), costCents: z.number().int().nonnegative(), knownCents: z.number().int().nonnegative(), calls: z.number().int().nonnegative(), estimatedCalls: z.number().int().nonnegative().optional(), unknownCalls: z.number().int().nonnegative().optional() });
export const LoopSpendByPurposeSchema = z.object({ builder: LoopSpendTotalsSchema.optional(), review: LoopSpendTotalsSchema.optional(), verify: LoopSpendTotalsSchema.optional(), 'context-action': LoopSpendTotalsSchema.optional(), classification: LoopSpendTotalsSchema.optional(), housekeeping: LoopSpendTotalsSchema.optional() });
export const LoopPhase2StateFieldsSchema = z.object({
  spendByPurpose: LoopSpendByPurposeSchema.optional(),
  reviewEffort: z.enum(['light', 'standard']).optional(),
  finishPhase: z.object({ enteredAtSeq: z.number().int().nonnegative(), roundsUsed: z.number().int().nonnegative(), maxRounds: z.number().int().positive() }).optional(),
  knownFailures: z.array(z.string()).optional(),
  followUps: z.array(z.string()).optional(),
  fullVerifyWorkHash: z.string().optional(),
});
export const LoopScorecardRequestSchema = z.object({ loopRunId: z.string().min(1).max(200) });
export const LoopScorecardSchema = z.object({
  costCents: z.number().nonnegative(), tokens: z.number().nonnegative(), knownCents: z.number().nonnegative(),
  unattributedCents: z.number().nonnegative(), unattributedTokens: z.number().nonnegative(), byPurpose: LoopSpendByPurposeSchema,
  legacyRounds: z.number().int().nonnegative(), rounds: z.number().int().nonnegative(), roundsAfterLedgerClosed: z.number().int().nonnegative(),
  stepLimitedRounds: z.number().int().nonnegative(), recordedStopRounds: z.number().int().nonnegative(), stopReasons: z.record(z.string(), z.number().int().nonnegative()),
  medianPromptBytes: z.number().nonnegative().nullable(), finishedTasks: z.number().int().nonnegative().nullable(), totalTasks: z.number().int().nonnegative().nullable(), unknownCalls: z.number().int().nonnegative(),
});
export const LoopScorecardResponseSchema = z.object({ scorecard: LoopScorecardSchema.nullable() });
