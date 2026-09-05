/**
 * Loop health / non-convergence state fields (L1, L4, L6, L7).
 *
 * Split out of `loop.schemas.ts` to keep that file inside its size ceiling.
 * Spread into `LoopStateSchema` via `.shape`, so the persisted shape is
 * unchanged and existing checkpoints keep parsing.
 */

import { z } from 'zod';

const NonConvergenceReasonSchema = z.enum([
  'code_review_non_converging',
  'landable_uncommitted',
  'scope_expanded',
  'no_progress',
]);

export const LoopHealthStateFieldsSchema = z.object({
  /** L6: ledger leaves deferred with a named reason; the work is never dropped. */
  parkedLeaves: z.array(z.object({
    id: z.string().min(1),
    reason: NonConvergenceReasonSchema,
    note: z.string(),
    parkedAtSeq: z.number().int().nonnegative(),
  })).optional(),
  /** L6: consecutive CRITICAL stalls on the current ledger leaf. */
  leafStall: z.object({
    leafId: z.string().min(1),
    criticalIterations: z.number().int().nonnegative(),
  }).optional(),
  /** L6: the named reason this run stopped converging. */
  nonConvergence: z.object({
    reason: NonConvergenceReasonSchema,
    message: z.string(),
    seq: z.number().int().nonnegative(),
  }).optional(),
  /** L7: completion attempts rejected for stale build output. */
  staleArtifactRejections: z.number().int().nonnegative().optional(),
  /** L1: same-session idle nudges queued this run, and the iteration of the last. */
  idleNudgeCount: z.number().int().nonnegative().optional(),
  idleNudgeSeq: z.number().int().nonnegative().optional(),
  /** L4: advisory intra-iteration phase inferred from the command stream. */
  inferredPhase: z.enum(['investigating', 'editing', 'verifying', 'reviewing']).optional(),
  inferredPhaseAt: z.number().int().nonnegative().optional(),
});
