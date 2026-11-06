import { z } from 'zod/v4';
import { MACHINE_SESSION_REASONS } from '../../shared/utils/machine-session';

/**
 * Claude policies a local spawn applies inside `createClaudeAdapter`, carried on
 * `instance.spawn` so the worker's own `createClaudeAdapter` applies them the
 * same way. Only sent to workers advertising `claudeSpawnPolicy: 2` (v1 receives only its original fields); an older
 * worker would strip it. Strict, so a field this worker does not know fails the
 * spawn instead of being silently dropped.
 */
export const RemoteClaudeSpawnPolicySchema = z.object({
  sessionKind: z.enum(['chat', 'child', 'loop', 'plan-queue', 'automation', 'review']).optional(),
  timeout: z.number().int().positive().max(86_400_000).optional(),
  systemPromptMode: z.enum(['append', 'replace']).optional(),
  fastMode: z.boolean().optional(),
  fallbackModel: z.string().min(1).max(256).optional(),
  jsonSchema: z.string().max(1_000_000).optional(),
  residentClaude: z.boolean().optional(),
  bare: z.boolean().optional(),
  name: z.string().max(512).optional(),
  chrome: z.boolean().optional(),
  excludeDynamicSystemPromptSections: z.boolean().optional(),
  bashOutputMaxChars: z.number().int().min(4_000).max(128_000).optional(),
  machineSession: z.enum(MACHINE_SESSION_REASONS).optional(),
  contextCeilingTokens: z.number().int().positive().max(1_000_000).optional(),
  readOnlyReview: z.literal(true).optional(),
  maxTurns: z.number().int().positive().max(10_000).optional(),
  maxBudgetUsd: z.number().positive().max(100_000).optional(),
}).strict();
export type RemoteClaudeSpawnPolicy = z.infer<typeof RemoteClaudeSpawnPolicySchema>;
