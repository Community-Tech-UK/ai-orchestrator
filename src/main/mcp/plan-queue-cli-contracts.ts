import { z } from 'zod';

export const PLAN_QUEUE_CLI_METHODS = { move: 'orchestrator_tools.plan_queue_cli.move' } as const;

const IdSchema = z.string().trim().min(1).max(200);
export const PlanQueueCliMovePayloadSchema = z.object({ runId: IdSchema, targetInstanceId: IdSchema.optional() }).strict();
/** The owner id is null when it is the calling session, so the CLI never prints its own injected id. */
export const PlanQueueCliMoveResultSchema = z.object({ runId: z.string(), ownerInstanceId: z.string().nullable() }).strict();
export type PlanQueueCliMovePayload = z.infer<typeof PlanQueueCliMovePayloadSchema>;
export type PlanQueueCliMoveResult = z.infer<typeof PlanQueueCliMoveResultSchema>;
