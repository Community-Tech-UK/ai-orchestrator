import { z } from 'zod';

export const PLAN_QUEUE_CLI_METHODS = { move: 'orchestrator_tools.plan_queue_cli.move', discard: 'orchestrator_tools.plan_queue_cli.discard' } as const;

const IdSchema = z.string().trim().min(1).max(200);
export const PlanQueueCliMovePayloadSchema = z.object({ runId: IdSchema, targetInstanceId: IdSchema.optional() }).strict();
/** The owner id is null when it is the calling session, so the CLI never prints its own injected id. */
export const PlanQueueCliMoveResultSchema = z.object({ runId: z.string(), ownerInstanceId: z.string().nullable() }).strict();
/** Jobs per call: page updates wait for a call to finish, so a call stays short. */
export const PLAN_QUEUE_CLI_DISCARD_BATCH = 10;
export const PlanQueueCliDiscardPayloadSchema = z.object({ itemIds: z.array(IdSchema).min(1).max(PLAN_QUEUE_CLI_DISCARD_BATCH) }).strict();
export const PlanQueueCliDiscardResultSchema = z.object({
  discarded: z.array(z.string()),
  /** Discarded jobs whose branch or worktree git would not release. */
  leftInPlace: z.array(z.object({ itemId: z.string(), what: z.array(z.string()) }).strict()),
  failed: z.array(z.object({ itemId: z.string(), error: z.string() }).strict()),
}).strict();
export type PlanQueueCliMovePayload = z.infer<typeof PlanQueueCliMovePayloadSchema>;
export type PlanQueueCliMoveResult = z.infer<typeof PlanQueueCliMoveResultSchema>;
