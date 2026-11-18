/**
 * Reads one ticket's text (its title, description and comments) and hashes it the one way the whole queue hashes it.
 * The Start preview uses it to pin what James sees; a later step uses it to compare what Linear says now with what he
 * approved, so both must give the same hash for the same text.
 *
 * It is other people's text. It is returned to the caller and goes nowhere else: no log line and no error message.
 */
import { hashTicketText, type TicketText } from '../plan-queue-linear-ticket-hash';
import { pinTicketRelations, type ApprovedTicketText, type PreviewedTicket, type TicketRelationKind } from '../plan-queue-ticket-approved-text';
import type { LinearCallDependencies } from './linear-call';
import {
  listLinearTicketComments,
  readLinearTicket,
  type LinearCallCounter,
  type LinearComment,
  type LinearTicket,
} from './linear-tickets';

/** A comment written by an agent or integration, or one Linear names no author for. The programme ignores these. */
export function isBotComment(comment: LinearComment): boolean {
  return comment.author === null || comment.onBehalfOf !== null;
}

export function ticketTextOf(ticket: LinearTicket, comments: readonly LinearComment[]): TicketText {
  return {
    title: ticket.title,
    description: ticket.description,
    comments: comments.map((comment) => ({
      id: comment.id,
      authorId: comment.author?.id ?? null,
      body: comment.body,
      createdAt: comment.createdAt,
      fromBot: isBotComment(comment),
    })),
  };
}

export interface TicketTextRead {
  ticket: LinearTicket;
  comments: LinearComment[];
  /** SHA-256 over the title, the description and each person's comment. */
  hash: string;
}

/** Two connector calls for a ticket with a page of comments or fewer: the ticket, then its comments. */
export async function readTicketText(
  identifier: string,
  counter: LinearCallCounter,
  dependencies?: LinearCallDependencies,
): Promise<TicketTextRead> {
  const { value: ticket } = await readLinearTicket(identifier, counter, dependencies);
  const { value: comments } = await listLinearTicketComments(identifier, counter, dependencies);
  return { ticket, comments, hash: hashTicketText(ticketTextOf(ticket, comments)) };
}

/**
 * The ticket as an approved text: the description, the comments, the fields and the related tickets, which are named by
 * their short address alone except where the preview James saw showed a title (`pinTicketRelations`). The Start preview
 * pins this at Start, and the check before a session builds the text a change would bring from the same function.
 */
export function approvedTextOf(
  read: TicketTextRead,
  preview: { parentIdentifier?: string; linkedProjectIds: ReadonlySet<string>; tickets: readonly PreviewedTicket[] },
): ApprovedTicketText {
  const { ticket, comments } = read;
  const relations: { relation: TicketRelationKind; identifier: string }[] = [
    ...ticket.relations.blockedBy.map((related) => ({ relation: 'blocked-by' as const, identifier: related.identifier })),
    ...ticket.relations.blocks.map((related) => ({ relation: 'blocks' as const, identifier: related.identifier })),
    ...ticket.relations.related.map((related) => ({ relation: 'related' as const, identifier: related.identifier })),
    ...ticket.relations.duplicateOf.map((related) => ({ relation: 'duplicate-of' as const, identifier: related.identifier })),
  ];
  if (preview.parentIdentifier) relations.unshift({ relation: 'parent', identifier: preview.parentIdentifier });
  return {
    description: ticket.description,
    comments: comments.map((comment) => ({
      id: comment.id,
      authorId: comment.author?.id ?? null,
      authorName: comment.author?.name ?? null,
      body: comment.body,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      fromBot: isBotComment(comment),
    })),
    labels: [...ticket.labels],
    priority: ticket.priority,
    projectName: ticket.project?.name ?? null,
    relatedTickets: pinTicketRelations(relations, preview),
    attachmentNames: [...ticket.attachmentNames],
  };
}
