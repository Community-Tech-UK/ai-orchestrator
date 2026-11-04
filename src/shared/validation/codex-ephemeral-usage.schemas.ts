import { z } from 'zod';
const count = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const CodexUsageIdSchema = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/);
const tokens = z.object({ input: count.nullable(), cache: count.nullable(), output: count.nullable(),
  reasoning: count.nullable(), total: count.nullable(), estimated: z.boolean() }).strict()
  .refine(t => t.cache === null || t.input === null || t.cache <= t.input)
  .refine(t => t.reasoning === null || t.output === null || t.reasoning <= t.output);
export const CodexEphemeralUsageSchema = z.object({
  version: z.literal(1), threadId: CodexUsageIdSchema, instanceId: CodexUsageIdSchema.nullable(), jobId: CodexUsageIdSchema.nullable(),
  kind: z.enum(['chat', 'child', 'loop', 'plan-queue', 'automation', 'review']),
  trialKey: z.string().regex(/^[a-f0-9]{64}$/).nullable(), trialArm: z.enum(['control', 'candidate', 'unassigned']),
  requests: count.nullable(), requestsAvailable: z.boolean(), tokens,
  helpers: z.object({ count: count.nullable(), tokens }).strict(), compactions: count.nullable(), startedAt: count, endedAt: count,
  durationMs: count, finishReason: z.enum(['stopped', 'runtime-exit', 'reopened', 'exec-exit', 'exec-failed', 'abandoned']),
}).strict().refine(row => row.requestsAvailable === (row.requests !== null))
  .refine(row => row.endedAt >= row.startedAt && row.durationMs === row.endedAt - row.startedAt);
export const CodexEphemeralUsageQuerySchema = z.object({ limit: count.min(1).max(1000).optional() }).strict().optional();
