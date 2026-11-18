/** What the queue does when the check before a session refuses: hold the job, never fail it or set it aside. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { holdTicketJob, holdTicketLanding, ticketNotReady } from './plan-queue-ticket-hold';
import { PlanQueueTicketHeld, ticketAskQuestion, ticketAskSentence } from './plan-queue-ticket-ask';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

/** A plain function, not a `vi.fn`: vitest would attach a handler to the rejected promise it returns and report it as unhandled. */
const readiness = vi.hoisted(() => ({ calls: 0, outcome: async (): Promise<void> => undefined }));
vi.mock('./plan-queue-work-sources', () => ({ workSourceFor: () => ({ assertReadyForSession: () => { readiness.calls += 1; return readiness.outcome(); } }) }));

const SENTENCE = ticketAskSentence('ORC-12', 'changed');
const held = () => new PlanQueueTicketHeld(SENTENCE, 'ORC-12', 'changed');
const base = { id: 'item-1', runId: 'run-1', sourceKind: 'linear', question: null, detail: 'Running checks', heldAt: null } as unknown as PlanQueueItem;

function host(kind: PlanQueueRun['kind'] = 'tickets', start: PlanQueueItem = base) {
  let current = start;
  const notify = vi.fn();
  return {
    host: {
      getItem: () => current, getRun: () => ({ id: 'run-1', kind } as PlanQueueRun),
      save: vi.fn((item: PlanQueueItem) => { current = item; return item; }),
      transition: vi.fn((item: PlanQueueItem, state: string, patch: object) => { current = { ...item, ...patch, state } as PlanQueueItem; return current; }),
      notifyParent: notify,
    },
    notify, current: () => current,
  };
}
beforeEach(() => { readiness.calls = 0; readiness.outcome = async () => undefined; });

describe('holding a job whose ticket may not be sent to a session', () => {
  it('holds it, puts the sentence in its detail over any other note, and tells the parent once', async () => {
    const h = host();
    const hold = vi.fn(async () => undefined);
    await holdTicketJob(h.host as never, hold, base, held());
    expect(hold).toHaveBeenCalledWith(base, SENTENCE);
    expect(h.current()).toMatchObject({ detail: SENTENCE, question: ticketAskQuestion('ORC-12', 'changed') });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.notify).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-1' }), SENTENCE);

    await holdTicketJob(h.host as never, hold, h.current(), held());
    expect(h.notify).toHaveBeenCalledTimes(1);
  });

  it('puts no question on a job whose ticket could not be read, and tells no one', async () => {
    const h = host();
    await holdTicketJob(h.host as never, async () => undefined, base, new PlanQueueTicketHeld('ORC-12 could not be read.', 'ORC-12', null));
    expect(h.current()).toMatchObject({ detail: 'ORC-12 could not be read.', question: null });
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('holds a landing as a job waiting for a check, with the built commit dropped and no round failed', async () => {
    const h = host('tickets', { ...base, state: 'landing', landedCommit: 'abc', verifiedMainCommit: 'def' } as PlanQueueItem);
    await holdTicketLanding(h.host as never, h.current(), held());
    expect(h.host.transition).toHaveBeenCalledWith(expect.anything(), 'awaiting-slot', expect.objectContaining({
      landedCommit: null, verifiedMainCommit: null, detail: SENTENCE, question: ticketAskQuestion('ORC-12', 'changed'), heldAt: expect.any(Number) }));
    expect(h.current()).toMatchObject({ state: 'awaiting-slot' });
    expect(h.current().parkReason).toBeUndefined();
    expect(h.notify).toHaveBeenCalledWith(expect.anything(), SENTENCE);
  });
});

describe('before a turn is sent to a live worker', () => {
  it('lets a turn through when the ticket is as approved, and asks nothing for a markdown run', async () => {
    const hold = vi.fn(); const park = vi.fn();
    expect(await ticketNotReady(host('tickets').host as never, base, hold, park)).toBe(false);
    expect(readiness.calls).toBe(1);
    expect(await ticketNotReady(host('plans').host as never, base, hold, park)).toBe(false);
    expect(readiness.calls).toBe(1);
    expect(hold).not.toHaveBeenCalled(); expect(park).not.toHaveBeenCalled();
  });

  it('holds the job and sends nothing when the check refuses', async () => {
    const refusal = held();
    readiness.outcome = async () => { throw refusal; };
    const hold = vi.fn(async () => undefined); const park = vi.fn();
    expect(await ticketNotReady(host().host as never, base, hold, park)).toBe(true);
    expect(hold).toHaveBeenCalledWith(base, expect.any(PlanQueueTicketHeld));
    expect(park).not.toHaveBeenCalled();
  });

  it('sets the job aside as a worker error when the ticket cannot be checked for any other reason', async () => {
    readiness.outcome = async () => { throw new Error('No Linear ticket row for item item-1.'); };
    const hold = vi.fn(); const park = vi.fn(async () => undefined);
    expect(await ticketNotReady(host().host as never, base, hold, park)).toBe(true);
    expect(park).toHaveBeenCalledWith(base, 'Could not check the ticket before sending the next turn: No Linear ticket row for item item-1.');
    expect(hold).not.toHaveBeenCalled();
  });
});
