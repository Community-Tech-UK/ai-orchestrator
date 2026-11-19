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

/**
 * What the Plan Queue page sends to start a Linear run: the session that starts it, the folder the list was loaded for, the
 * preview it was loaded in, and the Linear ids of the ticked tickets. Nothing else: no hash, title or text comes from the
 * page, because the main process takes them from the preview it holds. The count is checked in the main process, in fixed
 * words; the limit here only keeps a message from being absurdly large.
 */
export const PlanQueueLinearStartPayloadSchema = z.object({
  parentInstanceId: z.string().trim().min(1).max(200),
  workspaceCwd: z.string().trim().min(1).max(1000).optional(),
  previewId: z.string().trim().min(1).max(100),
  linearIds: z.array(LinearIdSchema).max(1000),
}).strict();
export type PlanQueueLinearStartPayload = z.infer<typeof PlanQueueLinearStartPayloadSchema>;
