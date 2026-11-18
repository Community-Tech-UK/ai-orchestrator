/**
 * What the queue does with a job whose Linear ticket may not be sent to a session (`plan-queue-ticket-guard.ts`): it holds
 * the job. A hold stops the job's sessions and keeps its work folder and its next instruction; no round is counted as
 * failed and the job is not set aside. Every sentence here is the fixed one from `plan-queue-ticket-ask.ts`.
 */
import type { PlanQueueFlowHost } from './plan-queue-host';
import { PlanQueueTicketHeld, ticketHoldPatch } from './plan-queue-ticket-ask';
import { workSourceFor } from './plan-queue-work-sources';
import type { PlanQueueItem } from './plan-queue.types';

type HoldHost = Pick<PlanQueueFlowHost, 'getItem' | 'save' | 'notifyParent'> & { getRun: PlanQueueFlowHost['getRun'] };

/**
 * Holds the job and, for a question, puts it on the item and tells the run's parent session the one sentence (a quiet
 * note: it starts no turn). Lock held. The question was saved in the ticket table before this runs, so a job can never be
 * held for a question that was not recorded.
 */
export async function holdTicketJob(
  host: HoldHost,
  hold: (item: PlanQueueItem, reason: string) => Promise<void>,
  item: PlanQueueItem,
  held: PlanQueueTicketHeld,
): Promise<void> {
  await hold(item, held.message);
  const current = host.getItem(item.id);
  const patch = ticketHoldPatch(held);
  const alreadyAsked = held.askKind !== null && current.question?.question === patch.question?.question;
  // The hold keeps any other note on the job (such as "Running checks"); the sentence is what James must see.
  host.save({ ...current, ...patch });
  if (held.askKind && !alreadyAsked) host.notifyParent(host.getRun(item.runId), held.message);
}

/**
 * Before a turn is sent to a live worker: true when the job was held instead and nothing may be sent. A ticket that cannot
 * be checked for a reason other than a change (its row is gone) sets the job aside as a worker error. Lock held.
 * The caller makes this the last wait before the turn is sent, after any Copilot context refresh, so a change made during
 * that refresh is still seen. A worker whose session is gone is checked when its new session is created instead.
 */
export async function ticketNotReady(
  host: HoldHost,
  item: PlanQueueItem,
  hold: (item: PlanQueueItem, held: PlanQueueTicketHeld) => Promise<void>,
  park: (item: PlanQueueItem, reason: string) => Promise<void>,
): Promise<boolean> {
  const run = host.getRun(item.runId);
  if (run.kind !== 'tickets') return false;
  try {
    await workSourceFor(item.sourceKind).assertReadyForSession(item, run);
    return false;
  } catch (error) {
    if (error instanceof PlanQueueTicketHeld) { await hold(host.getItem(item.id), error); return true; }
    await park(host.getItem(item.id), `Could not check the ticket before sending the next turn: ${error instanceof Error ? error.message : String(error)}`);
    return true;
  }
}

/**
 * A landing the ticket's change stopped: back to waiting for a check, held, with the question on the item. The commit built
 * so far is dropped, as Pause does, because the check that passed was of text James has been asked about again.
 */
export async function holdTicketLanding(host: HoldHost & Pick<PlanQueueFlowHost, 'transition'>, item: PlanQueueItem, held: PlanQueueTicketHeld): Promise<void> {
  const alreadyAsked = held.askKind !== null && item.question?.question === held.question?.question;
  host.transition(item, 'awaiting-slot', { verifiedMainCommit: null, landedCommit: null, heldAt: item.heldAt ?? Date.now(), ...ticketHoldPatch(held) });
  if (held.askKind && !alreadyAsked) host.notifyParent(host.getRun(item.runId), held.message);
}
