import { z } from 'zod/v4';
import { MACHINE_SESSION_REASONS } from '../../shared/utils/machine-session';

/**
 * Claude policies a local spawn applies inside `createClaudeAdapter`, carried on
 * `instance.spawn` so the worker's own `createClaudeAdapter` applies them the
 * same way. Only sent to workers advertising `claudeSpawnPolicy: 1`; an older
 * worker would strip it. Strict, so a field this worker does not know fails the
 * spawn instead of being silently dropped.
 */
export const RemoteClaudeSpawnPolicySchema = z.object({
  machineSession: z.enum(MACHINE_SESSION_REASONS).optional(),
  contextCeilingTokens: z.number().int().positive().max(1_000_000).optional(),
  readOnlyReview: z.literal(true).optional(),
  maxTurns: z.number().int().positive().max(10_000).optional(),
  maxBudgetUsd: z.number().positive().max(100_000).optional(),
}).strict();
export type RemoteClaudeSpawnPolicy = z.infer<typeof RemoteClaudeSpawnPolicySchema>;
