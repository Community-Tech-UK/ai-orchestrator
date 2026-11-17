/**
 * The Linear query a `tickets` run carries in its config: which linked projects it reads and which tickets James
 * ticked, each pinned to the hash of the text he saw. Re-exported from `plan-queue.schemas.ts`, so callers import it
 * from `@contracts/schemas/plan-queue`.
 *
 * The run config is sent to the Plan Queue page, the phone and `plan_queue_status`, so it holds ids, short addresses
 * and hashes only. No ticket title and no ticket text: those live in their own table (`plan_queue_linear_tickets`).
 */
import { z } from 'zod';

const LinearIdSchema = z.string().trim().min(1).max(200);

/** A ticket's short address such as `COM-123`; the same shape the connector's tickets are checked for. */
const LinearIdentifierSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,9}-\d{1,9}$/);

/** The most tickets one run can hold. */
export const PLAN_QUEUE_LINEAR_RUN_MAX_TICKETS = 200;
/** The most linked projects one run can read: one private project plus up to twenty client projects. */
export const PLAN_QUEUE_LINEAR_RUN_MAX_PROJECTS = 21;

export const PlanQueueLinearRunProjectSchema = z.object({
  projectId: LinearIdSchema,
  teamId: LinearIdSchema,
}).strict();

export const PlanQueueLinearRunTicketSchema = z.object({
  linearId: LinearIdSchema,
  identifier: LinearIdentifierSchema,
  /** SHA-256 (lowercase hex) of the text James saw in the preview. */
  previewHash: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export const PlanQueueLinearRunQuerySchema = z.object({
  projects: z.array(PlanQueueLinearRunProjectSchema).min(1).max(PLAN_QUEUE_LINEAR_RUN_MAX_PROJECTS),
  /** Unix milliseconds when the preview was loaded. */
  previewLoadedAt: z.number().int().positive(),
  tickets: z.array(PlanQueueLinearRunTicketSchema).max(PLAN_QUEUE_LINEAR_RUN_MAX_TICKETS),
}).strict();

export type PlanQueueLinearRunProject = z.infer<typeof PlanQueueLinearRunProjectSchema>;
export type PlanQueueLinearRunTicket = z.infer<typeof PlanQueueLinearRunTicketSchema>;
export type PlanQueueLinearRunQuery = z.infer<typeof PlanQueueLinearRunQuerySchema>;
