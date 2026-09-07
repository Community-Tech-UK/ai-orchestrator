/**
 * N12 — "while you were away" recap contract.
 *
 * Its own file rather than an addition to `loop.schemas.ts`, which is already
 * 915 lines against a 935 ceiling: four more schemas would push it over the LOC
 * ratchet. Same `export * from './loop-x.schemas'` convention already used by
 * `loop-audit.schemas.ts` and `loop-health.schemas.ts`.
 */
import { z } from 'zod';

export const AwayOutcomeSchema = z.enum(['needs-you', 'stopped-short', 'finished']);

export const AwayRunCardSchema = z.object({
  runId: z.string(),
  goal: z.string(),
  outcome: AwayOutcomeSchema,
  status: z.string(),
  iterations: z.number(),
  durationMs: z.number(),
  costCents: z.number(),
  outstandingCount: z.number(),
  endReason: z.string().nullable(),
});

export const AwayRecapSchema = z.object({
  cards: z.array(AwayRunCardSchema),
  finished: z.number(),
  stoppedShort: z.number(),
  needsYou: z.number(),
  totalCostCents: z.number(),
  headline: z.string(),
});

export const LoopGetAwayRecapPayloadSchema = z.object({
  /** Only runs that ended at or after this are reported. */
  awaySince: z.number().int().nonnegative(),
});

export type AwayRecapPayload = z.infer<typeof AwayRecapSchema>;
