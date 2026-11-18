/**
 * Reads a ticket as Linear holds it now, for the check before a session (`plan-queue-ticket-guard.ts`). It uses the same
 * read and the same hash as the Start preview, so an unchanged ticket gives exactly the hash James approved.
 *
 * It is other people's text. It is returned to the caller and goes nowhere else: no log line and no error message.
 */
import type { LiveTicketRead } from '../plan-queue-ticket-guard';
import type { LinearCallDependencies } from './linear-call';
import { isLinearCallError } from './linear-errors';
import { approvedTextOf, readTicketText } from './linear-ticket-text';
import { LinearCallCounter } from './linear-tickets';

/** One ticket, then its comments: two calls for a page of comments or fewer, one more for each further page. */
export const LINEAR_TICKET_CHECK_CALL_LIMIT = 20;

/** How the connector says it has no such ticket. Only matched, never shown: it is Linear's own wording. */
const NO_SUCH_TICKET = /not found|does not exist|no such|archived|deleted/i;

export async function readLiveTicket(
  identifier: string,
  dependencies?: LinearCallDependencies,
  counter: LinearCallCounter = new LinearCallCounter(LINEAR_TICKET_CHECK_CALL_LIMIT),
): Promise<LiveTicketRead> {
  try {
    const read = await readTicketText(identifier, counter, dependencies);
    return {
      kind: 'ticket',
      ticket: {
        title: read.ticket.title,
        // Related tickets are named by address alone: a title Linear sends with a relation may be a team James never chose.
        text: approvedTextOf(read, { linkedProjectIds: new Set(), tickets: [] }),
        hash: read.hash,
        teamId: read.ticket.team.id,
        projectId: read.ticket.project?.id ?? null,
      },
    };
  } catch (error) {
    // A ticket that is deleted or archived is not a read failure: it is a change, and James is asked about it.
    if (isLinearCallError(error) && error.code === 'unexpected-result' && error.detail && NO_SUCH_TICKET.test(error.detail)) return { kind: 'gone' };
    throw error;
  }
}
