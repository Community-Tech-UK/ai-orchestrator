/**
 * Pending-input (intervention queue) schemas.
 *
 * Split out of `loop.schemas.ts` to keep that file inside its size ceiling.
 * Shapes are unchanged; `loop.schemas.ts` re-exports them so existing imports
 * keep working.
 */

import { z } from 'zod';

export const LoopPendingInputKindSchema = z.enum(['steer', 'queue', 'follow-up']);
/** Task 18 drain policy. Mirrors `LoopQueueDrainMode`. */
export const LoopQueueDrainModeSchema = z.enum(['all', 'one-at-a-time']);
export const LoopPendingInputSourceSchema = z.enum([
  'human', 'block-override', 'plan-regen', 'phase-recovery',
  'context-survival', 'announce-then-halt', 'subagent-result', 'wakeup',
  'cap-wrap-up', 'auto-unstick', 'idle-nudge',
]);

export const LoopPendingInputSchema = z.object({
  id: z.string().min(1),
  kind: LoopPendingInputKindSchema,
  message: z.string().min(1),
  enqueuedAt: z.number().int().nonnegative(),
  source: LoopPendingInputSourceSchema,
  /** Task 18 drain policy; absent is treated as `all`. */
  drainMode: LoopQueueDrainModeSchema.optional(),
  /** L8 lease: iteration this payload was handed to, and when. */
  leaseSeq: z.number().int().nonnegative().optional(),
  leasedAt: z.number().int().nonnegative().optional(),
});

export const LegacyLoopPendingInputSchema = z.string().min(1).transform((message) => ({
  id: `legacy-${Math.abs(hashPendingMessage(message))}`,
  kind: 'queue' as const,
  message,
  enqueuedAt: 0,
  source: 'human' as const,
}));

function hashPendingMessage(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = Math.imul(31, hash) + input.charCodeAt(i);
  }
  return hash;
}
