import { z } from 'zod';

export const LoopCommitRatchetConfigSchema = z.preprocess((value) => value ?? {}, z.object({
  enabled: z.boolean().default(false),
  worktreeOnly: z.boolean().default(true),
  keepPolicy: z.literal('score-improvement').default('score-improvement'),
  resetOnRegression: z.boolean().default(true),
}));

export const LoopFreshSessionPerIterationConfigSchema = z.preprocess((value) => value ?? {}, z.object({
  enabled: z.boolean().default(false),
}));

export const LoopSubagentContractsConfigSchema = z.preprocess((value) => value ?? {}, z.object({
  enabled: z.boolean().default(false),
  maxDepth: z.number().int().min(0).max(5).default(1),
  requireNonOverlappingWriteScopes: z.boolean().default(true),
}));

export const LoopToolRwLockConfigSchema = z.preprocess((value) => value ?? {}, z.object({
  enabled: z.boolean().default(false),
}));

export const LoopPhase4ConfigSchema = z.preprocess((value) => value ?? {}, z.object({
  commitRatchet: LoopCommitRatchetConfigSchema,
  freshSessionPerIteration: LoopFreshSessionPerIterationConfigSchema,
  subagentContracts: LoopSubagentContractsConfigSchema,
  toolRwLocks: LoopToolRwLockConfigSchema,
}));
