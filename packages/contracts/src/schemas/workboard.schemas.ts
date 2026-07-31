import { z } from 'zod';

/**
 * WS-C1 Workboard decision timeline.
 *
 * `OperationalDecision` is a small cross-domain, read-only projection over
 * already-persisted operator-relevant events: provider-limit parks, loop
 * terminal/review-gate outcomes, context compaction, automation retries, and
 * send-admission suppressions. It never becomes a second policy engine or an
 * independently-editable audit feed — every entry cites a real field from an
 * existing authoritative store; see
 * `src/main/workboard/operational-decision-projection.ts`.
 */
export const OperationalDecisionSourceSchema = z.enum([
  'provider-limit',
  'loop-gate',
  'compaction',
  'automation',
  'admission',
]);
export type OperationalDecisionSource = z.infer<typeof OperationalDecisionSourceSchema>;

/**
 * The one safe operator action a decision entry may offer. Deliberately a
 * single literal kind today — it dispatches to the EXISTING loop resume
 * command (`LoopStore.resume`), never a new mutation path.
 */
export const OperationalDecisionActionSchema = z.object({
  kind: z.literal('resume-loop'),
  label: z.string(),
  loopRunId: z.string(),
});
export type OperationalDecisionAction = z.infer<typeof OperationalDecisionActionSchema>;

export const OperationalDecisionSchema = z.object({
  /** Stable id, unique within one item's timeline. */
  id: z.string(),
  /** Epoch ms the underlying event/state was recorded. */
  at: z.number().int(),
  source: OperationalDecisionSourceSchema,
  /** Plain-language: what happened, not the internal enum. */
  title: z.string(),
  /** Optional secondary detail (raw reason text, statusReason, error excerpt). */
  detail: z.string().optional(),
  /** Raw resulting status from the owning domain, when the event set one. */
  resultingStatus: z.string().optional(),
  /** When set, the epoch ms this can/will resume — null means "unknown". */
  resumeAt: z.number().int().nullable().optional(),
  operatorAction: OperationalDecisionActionSchema.optional(),
});
export type OperationalDecision = z.infer<typeof OperationalDecisionSchema>;

/** At least one correlated id is required — the handler resolves each
 *  present id against its owning store and merges whatever it finds. */
export const WorkboardDecisionsForItemPayloadSchema = z
  .object({
    loopRunId: z.string().optional(),
    automationRunId: z.string().optional(),
    instanceId: z.string().optional(),
  })
  .refine(
    (value) => Boolean(value.loopRunId || value.automationRunId || value.instanceId),
    { message: 'At least one of loopRunId, automationRunId, instanceId is required' },
  );
export type WorkboardDecisionsForItemPayload = z.infer<typeof WorkboardDecisionsForItemPayloadSchema>;

export const WorkboardDecisionsForItemResponseSchema = z.array(OperationalDecisionSchema);
export type WorkboardDecisionsForItemResponse = z.infer<typeof WorkboardDecisionsForItemResponseSchema>;
