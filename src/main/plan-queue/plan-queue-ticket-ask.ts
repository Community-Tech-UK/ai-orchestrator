/**
 * The words and the refusal for a Linear ticket that may not be sent to a session: its text changed since James approved
 * it, it is gone, or Linear could not be read. Everything here is fixed words plus the ticket's short address (checked
 * for its shape when the run was made). No ticket text is ever put in a sentence, a question or an error: the text a
 * change would bring waits in the ticket table, and only the Plan Queue page reads it.
 */
import type { PlanQueueQuestion } from '@contracts/schemas/plan-queue';
import type { OpenTicketAskKind } from './plan-queue-linear-ticket-store';

const ASK_TAIL = ' Answer on the Plan Queue page.';

const ASK_PHRASE: Record<OpenTicketAskKind, string> = {
  changed: 'changed in Linear.',
  gone: 'was removed from Linear or moved out of its project.',
  unconfirmed: 'has no text Harness can confirm you approved.',
};

/** What the item's `answer` records: the fixed sentence and the choice, never any ticket text. "ORC-12 changed in Linear → Use the ticket as it is now". */
export function ticketAnswerRecord(identifier: string, kind: OpenTicketAskKind, choiceLabel: string): string {
  return `${identifier} ${ASK_PHRASE[kind].replace(/\.$/, '')} → ${choiceLabel}`;
}

const UNREADABLE_TAIL = ' could not be read in Linear, so nothing was started. Harness will try again soon.';
/** The start of every sentence of the Linear connection (`linear-connection-reason.ts`). */
const CONNECTION_PREFIX = 'Linear work is paused';

/** The one sentence for an open question: the item's `question`, its `detail` and the note to the run's parent say exactly this. */
export function ticketAskSentence(identifier: string, kind: OpenTicketAskKind): string {
  return `${identifier} ${ASK_PHRASE[kind]}${ASK_TAIL}`;
}

/** Why a ticket was not read: the connection's own sentence when it has one, else words of ours. */
export function ticketUnreadableSentence(identifier: string, connectionReason: string | null): string {
  return connectionReason ?? `${identifier}${UNREADABLE_TAIL}`;
}

const USE_NOW = { id: 'use-now', label: 'Use the ticket as it is now' };
const KEEP_APPROVED = { id: 'keep-approved', label: 'Carry on with the version I approved' };
const STOP = { id: 'stop', label: 'Stop work on this ticket' };
const LEAVE_WAITING = { id: 'leave-waiting', label: 'Leave it waiting' };

/** The item's question. Only James can answer it, on the page: `jamesOnly` is what refuses every session. */
export function ticketAskQuestion(identifier: string, kind: OpenTicketAskKind): PlanQueueQuestion {
  return {
    question: ticketAskSentence(identifier, kind),
    options: kind === 'changed' ? [USE_NOW, KEEP_APPROVED, STOP] : [STOP, LEAVE_WAITING],
    jamesOnly: true,
  };
}

/** A job's `detail` that is a status for James and must never be sent to a worker as an instruction. */
export function isTicketHoldNote(detail: string | null | undefined): boolean {
  if (!detail) return false;
  return detail.startsWith(CONNECTION_PREFIX)
    || detail.endsWith(UNREADABLE_TAIL)
    || Object.values(ASK_PHRASE).some((phrase) => detail.endsWith(` ${phrase}${ASK_TAIL}`));
}

/**
 * No session may be told about this ticket now. The job is held, not failed: no round is counted and it is not set aside.
 * `askKind` is set when a question is open for James, and null when Linear could not be read (nothing is asked).
 */
export class PlanQueueTicketHeld extends Error {
  constructor(note: string, readonly identifier: string, readonly askKind: OpenTicketAskKind | null) {
    super(note);
    this.name = 'PlanQueueTicketHeld';
  }

  /** The question to put on the item, or null when there is none. */
  get question(): PlanQueueQuestion | null {
    return this.askKind ? ticketAskQuestion(this.identifier, this.askKind) : null;
  }
}

/** What a held job's row gets. The same fixed sentence is the detail, whichever way it was held. */
export function ticketHoldPatch(held: PlanQueueTicketHeld): { detail: string; question: PlanQueueQuestion | null } {
  return { detail: held.message, question: held.question };
}
