/**
 * Reads one ticket's text (its title, description and comments) and hashes it the one way the whole queue hashes it.
 * The Start preview uses it to pin what James sees; a later step uses it to compare what Linear says now with what he
 * approved, so both must give the same hash for the same text.
 *
 * It is other people's text. It is returned to the caller and goes nowhere else: no log line and no error message.
 */
import { hashTicketText, type TicketText } from '../plan-queue-linear-ticket-hash';
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
