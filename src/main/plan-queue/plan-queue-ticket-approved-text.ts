/**
 * The text of a Linear ticket as James approved it: the JSON kept in `plan_queue_linear_tickets.approved_text_json`
 * and the only thing the brief (`plan-queue-ticket-brief.ts`) is written from. The ticket's title has a column of its
 * own, so it is not part of this value.
 *
 * Everything here is other people's text. It is never logged and never put in an error message. This file does not
 * import the Linear folder: the page reads Linear and hands over plain values, and nothing in here can call it.
 */
import { z } from 'zod';

const ApprovedCommentSchema = z.object({
  id: z.string().min(1),
  authorId: z.string().nullable(),
  authorName: z.string().nullable(),
  body: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** From a bot or integration: the programme ignores these, so they are not hashed and not shown to a session. */
  fromBot: z.boolean(),
}).strict();

export const TICKET_RELATION_KINDS = ['parent', 'sub-issue', 'blocked-by', 'blocks', 'related', 'duplicate-of'] as const;
export const TicketRelationKindSchema = z.enum(TICKET_RELATION_KINDS);
export type TicketRelationKind = z.infer<typeof TicketRelationKindSchema>;

/** A ticket this one points at. The title is kept only when James's preview showed it (`pinTicketRelations`). */
const ApprovedRelatedTicketSchema = z.object({
  relation: TicketRelationKindSchema,
  identifier: z.string().min(1),
  title: z.string().nullable(),
}).strict();

/** The description, comments and fields of a ticket as James saw them. */
export const ApprovedTicketTextSchema = z.object({
  description: z.string(),
  comments: z.array(ApprovedCommentSchema),
  labels: z.array(z.string()),
  /** Linear's priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. */
  priority: z.number().int().min(0).max(4),
  projectName: z.string().nullable(),
  relatedTickets: z.array(ApprovedRelatedTicketSchema),
  attachmentNames: z.array(z.string()),
}).strict();

export type ApprovedTicketText = z.infer<typeof ApprovedTicketTextSchema>;
export type ApprovedTicketComment = ApprovedTicketText['comments'][number];
export type ApprovedRelatedTicket = ApprovedTicketText['relatedTickets'][number];

/** A ticket the pinned preview listed. The preview lists only the linked projects' tickets, and carries each one's project. */
export interface PreviewedTicket {
  identifier: string;
  title: string;
  projectId: string | null;
}

/**
 * The related tickets to approve. A related ticket is named by its identifier alone, except one in a linked project
 * whose title was in the pinned preview: that title is text James has already seen. A title Linear sent with the
 * relation is never used, because a ticket outside the linked projects may belong to a team James never chose.
 */
export function pinTicketRelations(
  relations: readonly { relation: TicketRelationKind; identifier: string }[],
  preview: { linkedProjectIds: ReadonlySet<string>; tickets: readonly PreviewedTicket[] },
): ApprovedRelatedTicket[] {
  const shown = new Map<string, string>();
  for (const ticket of preview.tickets) {
    if (ticket.projectId !== null && preview.linkedProjectIds.has(ticket.projectId)) shown.set(ticket.identifier, ticket.title);
  }
  return relations.map(({ relation, identifier }) => ({ relation, identifier, title: shown.get(identifier) ?? null }));
}
