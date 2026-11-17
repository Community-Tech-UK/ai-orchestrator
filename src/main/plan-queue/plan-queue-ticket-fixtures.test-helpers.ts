import type { PlanQueueItem } from './plan-queue.types';
import type { ApprovedTicketText } from './plan-queue-ticket-approved-text';
import type { TicketForBrief } from './plan-queue-ticket-brief';

/** A ticket that uses every part of the brief. Shared by the brief, prompt and file specs. */
export function fullTicketText(over: Partial<ApprovedTicketText> = {}): ApprovedTicketText {
  return {
    description: 'The button does nothing.\nSeen on Safari.',
    comments: [
      { id: 'c2', authorId: 'u2', authorName: 'Sam Lee', body: 'Seen on Safari too.', createdAt: '2026-11-02T09:00:00.000Z', updatedAt: '2026-11-02T09:00:00.000Z', fromBot: false },
      { id: 'c1', authorId: 'u1', authorName: 'Alex Kim', body: 'Reproduced on Chrome.', createdAt: '2026-11-01T10:30:00.000Z', updatedAt: '2026-11-01T10:30:00.000Z', fromBot: false },
      { id: 'c3', authorId: null, authorName: 'Deploy bot', body: 'Preview deployed.', createdAt: '2026-11-03T08:00:00.000Z', updatedAt: '2026-11-03T08:00:00.000Z', fromBot: true },
    ],
    labels: ['Harness', 'Bug'],
    priority: 2,
    projectName: 'Website',
    relatedTickets: [
      { relation: 'parent', identifier: 'ORC-1', title: 'Sign-in work' },
      { relation: 'blocked-by', identifier: 'ORC-3', title: null },
    ],
    attachmentNames: ['mockup.png'],
    ...over,
  };
}

export function fullTicket(over: Partial<ApprovedTicketText> = {}): TicketForBrief {
  return { identifier: 'ORC-12', title: 'Make the sign-in button work', text: fullTicketText(over) };
}

/** A queue item with only the fields the ticket prompts read. */
export const ticketItem = {
  id: 'item-0123456789', runId: 'run-1', sourceRef: 'linear:lin-12', branchName: 'queue/orc-12-make-the-sign-in-button-work-456789',
} as PlanQueueItem;
