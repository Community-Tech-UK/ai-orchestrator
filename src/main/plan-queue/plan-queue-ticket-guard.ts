/**
 * The one check before a session is told about a Linear ticket. It runs before a worker or checker session is created,
 * before a turn is sent to a live worker, and before a landing, so every prompt that reaches a session passes it.
 *
 * In order: (1) an open question refuses, and nothing is read from Linear; (2) the ticket and its comments are read and
 * hashed the way the approved text was, and an equal hash (or the hash of a change James chose to leave out) carries on;
 * (3) anything else opens a question for James and refuses. A ticket whose approved text was cleared always asks, showing
 * the ticket as it is now. It is opened the same way whoever made the change: the
 * connector cannot say who did, and another session using his Linear tools would look like him.
 *
 * Reading Linear is injected, so this file imports nothing from the Linear folder. Ticket text is other people's text:
 * the held text goes into the ticket table and nowhere else, and no sentence, log line or error here holds any of it.
 */
import { getLogger } from '../logging/logger';
import { createdOrder, normaliseTicketLineEndings, type TicketText } from './plan-queue-linear-ticket-hash';
import type { OpenTicketAsk, OpenTicketAskKind, PlanQueueLinearTicketStore, TicketChangeKind } from './plan-queue-linear-ticket-store';
import type { ApprovedTicketText } from './plan-queue-ticket-approved-text';
import { PlanQueueTicketHeld, ticketAskQuestion, ticketAskSentence, ticketUnreadableSentence } from './plan-queue-ticket-ask';
import { TicketTextUnavailable } from './plan-queue-ticket-round';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import type { WorkItemHold } from './plan-queue-work-source';

const logger = getLogger('PlanQueueTicketGuard');

/** A ticket as Linear holds it now. */
export interface LiveTicket {
  title: string;
  /** The held text a question would carry: what James is shown if he chooses to use the ticket as it is. */
  text: ApprovedTicketText;
  /** The hash of the title, description and people's comments, worked out the way the approved hash is. */
  hash: string;
  teamId: string;
  projectId: string | null;
}

/** `gone`: Linear has no such ticket now (deleted or archived). A ticket that cannot be read at all throws instead. */
export type LiveTicketRead = { kind: 'ticket'; ticket: LiveTicket } | { kind: 'gone' };

export interface TicketGuardDependencies {
  table(): PlanQueueLinearTicketStore | null;
  /** Reads one ticket and its comments by short address. Throws when Linear cannot be read. */
  read(identifier: string): Promise<LiveTicketRead>;
  /** The Linear connection's own sentence while it cannot be used, or null. */
  connectionReason(): string | null;
  /** Tells the connection a read failed, so it checks itself again. */
  noteReadFailure(error: unknown): void;
  now(): number;
}

/** How long a job whose ticket could not be read waits before the pump tries it again. */
export const TICKET_UNREADABLE_RETRY_MS = 60_000;

const PARKED_OR_SKIPPED = new Set(['parked', 'skipped']);

function same(a: string, b: string): boolean {
  return normaliseTicketLineEndings(a) === normaliseTicketLineEndings(b);
}

function peopleComments(comments: TicketText['comments']): string {
  return JSON.stringify(comments.filter((comment) => !comment.fromBot).slice().sort(createdOrder)
    .map((comment) => [comment.id, comment.authorId ?? '', normaliseTicketLineEndings(comment.body)]));
}

/** Which of the title, the description and the people's comments differ. Never empty: the hash is over exactly these. */
function changedParts(approved: TicketText, live: TicketText): TicketChangeKind[] {
  const changed: TicketChangeKind[] = [];
  if (!same(approved.title, live.title)) changed.push('title');
  if (!same(approved.description, live.description)) changed.push('description');
  if (peopleComments(approved.comments) !== peopleComments(live.comments) || changed.length === 0) changed.push('comments');
  return changed;
}

function ticketTextOfApproved(title: string, text: ApprovedTicketText): TicketText {
  return { title, description: text.description, comments: text.comments.map(({ id, authorId, body, createdAt, fromBot }) => ({ id, authorId, body, createdAt, fromBot })) };
}

export interface TicketGuard {
  /** Throws `PlanQueueTicketHeld` when no session may be told about the ticket now. */
  check(item: Pick<PlanQueueItem, 'id'>, run: Pick<PlanQueueRun, 'config'>): Promise<void>;
  /** Why the pump must not start this job now, from the ticket table alone, or null. Calls nothing outside. */
  itemHold(item: PlanQueueItem, runItems: readonly PlanQueueItem[]): WorkItemHold | null;
}

export function createTicketGuard(deps: TicketGuardDependencies): TicketGuard {
  /** Jobs whose ticket could not be read, and when the pump may try them again. Memory only: a restart tries at once. */
  const unreadableUntil = new Map<string, number>();

  const requireTable = (): PlanQueueLinearTicketStore => {
    const table = deps.table();
    if (!table) throw new Error('The Linear ticket table is not available.');
    return table;
  };

  const held = (identifier: string, kind: OpenTicketAskKind): PlanQueueTicketHeld =>
    new PlanQueueTicketHeld(ticketAskSentence(identifier, kind), identifier, kind);

  /** Opens the question for this job and returns the refusal. Synchronous after the read, so two checks never open two. */
  const ask = (table: PlanQueueLinearTicketStore, itemId: string, identifier: string, opened: OpenTicketAsk): PlanQueueTicketHeld => {
    table.openAsk(itemId, opened);
    return held(identifier, opened.kind);
  };

  async function check(item: Pick<PlanQueueItem, 'id'>, run: Pick<PlanQueueRun, 'config'>): Promise<void> {
    const table = requireTable();
    const first = table.get(item.id);
    if (!first) throw new Error(`No Linear ticket row for item ${item.id}.`);
    // 1. A question is already open: refuse without reading anything.
    if (first.openAsk) throw held(first.identifier, first.openAsk.kind);

    // 2. Read the ticket and its comments.
    let read: LiveTicketRead;
    try {
      read = await deps.read(first.identifier);
    } catch (error) {
      deps.noteReadFailure(error);
      unreadableUntil.set(item.id, deps.now() + TICKET_UNREADABLE_RETRY_MS);
      // Fixed words only: nothing the connector said goes anywhere.
      logger.warn('Linear ticket could not be read before a session', { itemId: item.id });
      throw new PlanQueueTicketHeld(ticketUnreadableSentence(first.identifier, deps.connectionReason()), first.identifier, null);
    }
    unreadableUntil.delete(item.id);

    // Everything below runs with no await, so it sees the table as it is now and cannot interleave with another check.
    const record = table.get(item.id);
    if (!record) throw new Error(`No Linear ticket row for item ${item.id}.`);
    if (record.openAsk) throw held(record.identifier, record.openAsk.kind);
    const now = deps.now();

    if (read.kind === 'gone' || read.ticket.teamId !== record.teamId || read.ticket.projectId !== record.projectId) {
      throw ask(table, item.id, record.identifier, { kind: 'gone', openedAt: now });
    }
    const live = read.ticket;
    if (!record.approvedText) {
      // Cleared on purpose (`plan-queue-ticket-retention.ts`): nothing can be built from it, so he reads the ticket again.
      if (record.textClearedAt === null) throw new TicketTextUnavailable();
      throw ask(table, item.id, record.identifier, { kind: 'cleared', heldTitle: live.title, heldText: live.text, heldHash: live.hash, openedAt: now });
    }

    // At the claim, what James approved must still be what the run was started with: the hash saved with the run.
    if (record.claimedAt === null) {
      const pin = run.config.linear?.tickets.find((ticket) => ticket.linearId === record.linearId)?.previewHash;
      if (pin !== record.approvedHash) throw ask(table, item.id, record.identifier, { kind: 'unconfirmed', openedAt: now });
    }

    if (live.hash === record.approvedHash || live.hash === record.leftOutHash) {
      // The first check that finds no change is the claim; a later one never moves its time.
      table.recordClaim(item.id, now);
      return;
    }
    throw ask(table, item.id, record.identifier, {
      kind: 'changed',
      heldTitle: live.title,
      heldText: live.text,
      heldHash: live.hash,
      changed: changedParts(ticketTextOfApproved(record.approvedTitle, record.approvedText), {
        title: live.title,
        description: live.text.description,
        comments: live.text.comments.map(({ id, authorId, body, createdAt, fromBot }) => ({ id, authorId, body, createdAt, fromBot })),
      }),
      openedAt: now,
    });
  }

  function itemHold(item: PlanQueueItem, runItems: readonly PlanQueueItem[]): WorkItemHold | null {
    const table = deps.table();
    const state = table?.holdState(item.id);
    if (!table || !state) return null;
    if (state.askKind) return { note: ticketAskSentence(state.identifier, state.askKind), setAside: false, question: ticketAskQuestion(state.identifier, state.askKind) };
    const retryAt = unreadableUntil.get(item.id);
    if (retryAt !== undefined) {
      if (deps.now() < retryAt) return { note: ticketUnreadableSentence(state.identifier, null), setAside: false };
      unreadableUntil.delete(item.id);
    }
    // A job that has begun is never held by a blocker: it began once its blockers had landed.
    if (item.state !== 'queued' || item.branchName || state.blockedBy.length === 0) return null;
    const holders = table.itemIdsByIdentifier(item.runId);
    const waiting: string[] = [];
    for (const blocker of state.blockedBy) {
      const blockerItemId = holders.get(blocker);
      const blockerItem = blockerItemId === undefined ? undefined : runItems.find((candidate) => candidate.id === blockerItemId);
      if (!blockerItem || blockerItem.state === 'landed') continue;
      if (PARKED_OR_SKIPPED.has(blockerItem.state)) return { note: `Blocked by ${blocker}, which stopped`, setAside: true };
      waiting.push(blocker);
    }
    return waiting.length ? { note: `Waiting for ${waiting.join(', ')}`, setAside: false } : null;
  }

  return { check, itemHold };
}
