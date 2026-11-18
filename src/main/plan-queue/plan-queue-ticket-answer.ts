/**
 * James's answer to the question a Linear ticket opens (`plan-queue-ticket-ask.ts`), and everything else that decides who
 * may answer it and what may start while it is open. Three answers, for a ticket whose text changed:
 *
 * - use the ticket as it is now: the held text becomes the approved text (with its hash and time), the question closes and
 *   the hold is released, so the next worker prompt carries the new text and says the ticket changed;
 * - carry on with the version he approved: the held text's hash is recorded as left out, so the same change is not asked
 *   about again, and the hold is released;
 * - stop work on the ticket: a ticket that has not started is skipped, one that has is set aside as `needs-james`.
 *
 * A ticket whose approved text was cleared offers the first and the last: the ticket was read again for the question, and its text
 * is what he approves. A ticket that has gone, or whose approved text cannot be confirmed, offers only stop and "Leave it waiting".
 *
 * Only the Plan Queue page reaches this file: the page's two handlers (read the question, answer it) and the coordinator.
 * No tool, command, session method or phone route does (`plan-queue-ticket-answer-not-agent-reachable.spec.ts`). The text
 * it reads is other people's text; nothing here logs it or puts it in an error or in the item's row.
 */
import type { PlanQueueParkReason, PlanQueueTicketAskView } from '@contracts/schemas/plan-queue';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { getPlanQueueLinearTicketStore } from './plan-queue-linear-ticket-store-singleton';
import { openTicketAskHash, type PlanQueueLinearTicketRecord, type PlanQueueLinearTicketStore } from './plan-queue-linear-ticket-store';
import { PRE_START_STATES } from './plan-queue-readiness';
import { isTerminalItemState } from './plan-queue-state';
import { buildTicketBrief } from './plan-queue-ticket-brief';
import { isTicketHoldNote, ticketAnswerRecord, ticketAskQuestion } from './plan-queue-ticket-ask';
import type { PlanQueueItem } from './plan-queue.types';

/** A session (the run's parent included) asked to answer a question only James may. */
export const JAMES_ONLY_REFUSAL = 'Only James can answer this, on the Plan Queue page.';
/** The answer route with no caller (the phone, or a page call to the wrong channel) asked to answer one. */
export const PAGE_ONLY_REFUSAL = 'Answer this one on the Plan Queue page.';
const ASK_OPEN_REFUSAL = 'Answer the question about this ticket first.';
const ALREADY_ANSWERED = 'This question has already been answered.';
const CHANGED_AGAIN = 'The ticket changed again. Read the new version.';
const STOPPED_SKIP = 'James chose to stop work on this ticket.';
const STOPPED_PARK = 'James chose to stop work on this ticket. Resume it from Set aside when ready.';

/** `plan_queue_answer` and the phone's answer route: a question only James may answer is refused, whoever asks. */
export function refuseJamesOnlyAnswer(item: Pick<PlanQueueItem, 'question'>, callerInstanceId: string | undefined): void {
  if (item.question?.jamesOnly) throw new Error(callerInstanceId !== undefined ? JAMES_ONLY_REFUSAL : PAGE_ONLY_REFUSAL);
}

/** Item controls that start a round of work: resume, retry landing, land anyway and recheck readiness. */
export const CONTROLS_THAT_START_WORK: ReadonlySet<string> = new Set(['resume-item', 'retry-landing', 'land-anyway', 'recheck-readiness']);

/** Refuses an action that would start a round for a ticket with an open question, from anyone. Skip and Discard start nothing. */
export function refuseWhileTicketAskOpen(item: Pick<PlanQueueItem, 'id' | 'sourceKind'>): void {
  if (item.sourceKind !== 'linear') return;
  if (getPlanQueueLinearTicketStore()?.holdState(item.id)?.askKind) throw new Error(ASK_OPEN_REFUSAL);
}

function requireTable(): PlanQueueLinearTicketStore {
  const table = getPlanQueueLinearTicketStore();
  if (!table) throw new Error('The Linear ticket table is not available.');
  return table;
}

function requireRecord(table: PlanQueueLinearTicketStore, itemId: string): PlanQueueLinearTicketRecord {
  const record = table.get(itemId);
  if (!record) throw new Error('This job has no Linear ticket.');
  return record;
}

/** The question for the page, with both texts as plain strings; null when none is open. */
export function readTicketAsk(itemId: string): PlanQueueTicketAskView | null {
  const record = requireRecord(requireTable(), itemId);
  const ask = record.openAsk;
  if (!ask) return null;
  const { identifier } = record;
  return {
    itemId, identifier, kind: ask.kind, askHash: openTicketAskHash(ask), openedAt: ask.openedAt,
    approved: record.approvedText
      ? { title: record.approvedTitle, text: buildTicketBrief({ identifier, title: record.approvedTitle, text: record.approvedText }), hash: record.approvedHash, approvedAt: record.approvedAt }
      : null,
    held: ask.kind === 'changed' || ask.kind === 'cleared'
      ? { title: ask.heldTitle, text: buildTicketBrief({ identifier, title: ask.heldTitle, text: ask.heldText }), hash: ask.heldHash, changed: ask.kind === 'changed' ? ask.changed : [] }
      : null,
    options: ticketAskQuestion(identifier, ask.kind).options,
  };
}

/**
 * What a job's row gets when its question is answered. The question always goes. A job held for this ticket's question also
 * loses its hold note and its hold, so the pump starts it again; a job held for something else keeps that hold.
 */
export function releasedTicketPatch(item: Pick<PlanQueueItem, 'detail'>): Partial<PlanQueueItem> {
  return isTicketHoldNote(item.detail) ? { question: null, detail: null, heldAt: null } : { question: null };
}

export interface TicketAnswerInput {
  itemId: string;
  optionId: string;
  /** What the read returned: the answer is applied only while the question is still the one James was shown. */
  askHash: string;
}

type AnswerHost = Pick<PlanQueueFlowHost, 'getItem' | 'save' | 'transition' | 'requestPump'>;
interface Parker { park(itemId: string, reason: PlanQueueParkReason, detail: string): Promise<void> }

/**
 * Applies James's answer. The coordinator lets one answer per job run at a time, so a second click is refused while the
 * first is applied; one that arrives after finds the question closed. Everything up to the first `await` runs in one turn,
 * so nothing can change the question between the check and the change.
 */
export async function answerTicketAsk(host: AnswerHost, flow: Parker, input: TicketAnswerInput): Promise<void> {
  const table = requireTable();
  const { identifier, openAsk: ask } = requireRecord(table, input.itemId);
  if (!ask) throw new Error(ALREADY_ANSWERED);
  if (openTicketAskHash(ask) !== input.askHash) throw new Error(CHANGED_AGAIN);
  const option = ticketAskQuestion(identifier, ask.kind).options.find((candidate) => candidate.id === input.optionId);
  if (!option) throw new Error('That answer is not offered for this question.');
  // "Leave it waiting": the question stays open and nothing changes.
  if (option.id === 'leave-waiting') return;
  const answer = ticketAnswerRecord(identifier, ask.kind, option.label);

  if (option.id === 'stop') {
    const item = host.getItem(input.itemId);
    if (!isTerminalItemState(item.state)) {
      if (PRE_START_STATES.has(item.state) && !item.branchName && !item.worktreePath) {
        host.transition(item, 'skipped', { workerSession: undefined, question: null, heldAt: null, detail: STOPPED_SKIP, answer });
      } else {
        // Set aside first and close the question after: a stop between them leaves a set-aside job with a question open, never a
        // job that goes on because its question was closed.
        await flow.park(input.itemId, 'needs-james', STOPPED_PARK);
      }
    }
    host.save({ ...host.getItem(input.itemId), question: null, answer });
    // A job that is skipped has had its text cleared with the question, which is the stop, not an earlier answer.
    const stopped = host.getItem(input.itemId).state === 'skipped';
    closeAsk(table, input, { choice: 'stop' }, stopped);
    host.requestPump();
    return;
  }

  closeAsk(table, input, option.id === 'use-now' ? { choice: 'use-now', at: Date.now() } : { choice: 'keep-approved' });
  const item = host.getItem(input.itemId);
  host.save({ ...item, ...releasedTicketPatch(item), answer });
  host.requestPump();
}

function closeAsk(table: PlanQueueLinearTicketStore, input: TicketAnswerInput, choice: Parameters<PlanQueueLinearTicketStore['answerAsk']>[2], closedWithTheJob = false): void {
  const result = table.answerAsk(input.itemId, input.askHash, choice);
  if (result === 'no-ask' && !closedWithTheJob) throw new Error(ALREADY_ANSWERED);
  if (result === 'stale') throw new Error(CHANGED_AGAIN);
}
