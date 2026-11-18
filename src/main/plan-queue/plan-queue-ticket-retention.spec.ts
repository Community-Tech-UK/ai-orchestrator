/**
 * How long a Linear ticket's text is kept (`plan-queue-ticket-retention.ts`). Real coordinator, real ticket table, real brief
 * folder and fake sessions. The clock is injected into the retention, so "29 days" and "30 days" are asked, not waited for.
 *
 * The moments: the brief file goes when the job is landed, skipped, discarded, set aside or its run is cancelled, and a Resume
 * writes it again. The text goes at every one of those but "set aside", which keeps it for 30 days, and a ticket whose text is
 * gone asks James again on Resume.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { machineGates } from './plan-queue-coordinator.test-mocks';
import {
  coordinator, defineDefaultScripts, driver, fake, itemIdOf, pass, repo, store, waitForRun, type FakeInstance, type Script,
} from './plan-queue-coordinator.test-helpers';
import { _setPlanQueueDataDirForTesting } from './plan-queue-data-dir';
import { _setLinearProviderPolicyForTesting, LinearProviderPolicy } from './plan-queue-linear-providers';
import { _resetLinearTicketGuardForTesting, _setLinearTicketReadForTesting } from './plan-queue-linear-source';
import { PlanQueueLinearTicketStore } from './plan-queue-linear-ticket-store';
import { deleteTicketBriefFile, sweepTicketBriefFiles, ticketBriefPath, writeTicketBriefFile } from './plan-queue-ticket-brief-file';
import { readTicketAsk } from './plan-queue-ticket-answer';
import { ticketAskQuestion } from './plan-queue-ticket-ask';
import { _setTicketRetentionForTesting, createTicketRetention, type TicketRetention } from './plan-queue-ticket-retention';
import { FakeLinearTickets, RUN_ID, ticketText, writeTicketsRun, type TestTicket } from './plan-queue-ticket-round.test-helpers';
import type { PlanQueueItem } from './plan-queue.types';

vi.mock('./plan-queue-gate-receipts', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withScriptedGates(await original()));
vi.mock('./plan-queue-landing', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withLandingHooks(await original()));
vi.mock('../workspace/git/worktree-integration', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withPromotionHook(await original()));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: () => 'queue-page', getAll: () => ({ planQueueAccountRules: { never: [], last: [] }, providerAccountProfiles: [], copilotAccountProfiles: [] }) }),
}));
vi.mock('./linear/linear-connection-singleton', () => ({
  getLinearConnectionService: () => ({ reasonToHold: () => null, noteCallFailure: () => undefined }),
}));
const tableOver = vi.hoisted(() => ({ make: null as null | (() => unknown) }));
vi.mock('./plan-queue-linear-ticket-store-singleton', () => ({ getPlanQueueLinearTicketStore: () => tableOver.make?.() ?? null }));

const DAY = 24 * 60 * 60_000;
const ORC12: TestTicket = {
  linearId: 'lin-12', identifier: 'ORC-12', title: 'Make the sign in button work', text: ticketText('The button does nothing.'),
};
const ORC13: TestTicket = { linearId: 'lin-13', identifier: 'ORC-13', title: 'Fix the footer link', text: ticketText('The footer link goes nowhere.') };
const LIVE = 'The button does nothing, and the footer link too.';
const CLEARED_ASK = 'ORC-12 had its text cleared (client text is kept for 30 days at most). Read it again to carry on. Answer on the Plan Queue page.';

let linear: FakeLinearTickets;
let dataDir: string;
let clock: number;
let retention: TicketRetention;
let built = 0;
/** What each worker's first turn found on disk: whether its brief file existed and what it said. */
let workerTurns: { itemId: string; message: string; briefText: string | null }[];

const table = () => new PlanQueueLinearTicketStore(driver);
const itemAt = (index = 0) => store.listItems(RUN_ID)[index];
const rowAt = (index = 0) => table().get(itemAt(index).id)!;
const workers = () => fake.created.filter((instance: FakeInstance) => instance.role === 'worker');
const sessionsStarted = () => fake.created.filter((instance: FakeInstance) => instance.role !== 'parent').length;
const briefOf = (itemId: string) => ticketBriefPath(itemId);
const flow = () => (coordinator as unknown as { requireFlow(): { park(id: string, reason: string, detail: string): Promise<void> } }).requireFlow();

const build: Script = (instance) => {
  built += 1;
  writeFileSync(join(instance.workingDirectory!, `${itemIdOf(instance)}.feature.txt`), `built ${built}\n`);
};

/** A worker script that notes what its brief file said when its turn arrived, then does the work. */
const recordingBuild = (then: Script = build): Script => async (instance, message, f) => {
  const itemId = itemIdOf(instance);
  workerTurns.push({ itemId, message, briefText: existsSync(briefOf(itemId)) ? readFileSync(briefOf(itemId), 'utf8') : null });
  await then(instance, message, f);
};

/** Writes the brief file for an item, as a round would have. */
async function writeBrief(itemId: string, text = 'brief'): Promise<void> {
  await writeTicketBriefFile({ itemId, brief: text, repoRoot: repo, workFolder: null });
}
const fileGone = (itemId: string) => vi.waitFor(() => expect(existsSync(briefOf(itemId))).toBe(false), { timeout: 5_000, interval: 10 });

/** A row that holds nothing but what stays: the identifier, the approved title, the address and the ids that place the ticket. */
function expectOnlyWhatStays(itemId: string, ticket: TestTicket): void {
  expect(table().get(itemId)).toMatchObject({
    identifier: ticket.identifier, approvedTitle: ticket.title, address: `https://linear.app/x/issue/${ticket.identifier}`,
    approvedText: null, approvedHash: '', openAsk: null, leftOutHash: null, textClearedAt: expect.any(Number),
  });
}

beforeEach(() => {
  void machineGates;
  defineDefaultScripts();
  built = 0;
  workerTurns = [];
  clock = Date.now();
  tableOver.make = () => new PlanQueueLinearTicketStore(driver);
  _resetLinearTicketGuardForTesting();
  linear = new FakeLinearTickets([ORC12, ORC13]);
  _setLinearTicketReadForTesting((identifier) => linear.read(identifier));
  dataDir = mkdtempSync(join(tmpdir(), 'ticket-retention-data-'));
  _setPlanQueueDataDirForTesting(dataDir);
  retention = createTicketRetention({ table: () => table(), deleteBrief: deleteTicketBriefFile, sweepBriefs: sweepTicketBriefFiles, now: () => clock });
  _setTicketRetentionForTesting(retention);
  _setLinearProviderPolicyForTesting(new LinearProviderPolicy({
    readTeams: () => [{ teamId: 'team-orc', providers: ['claude', 'codex'] }],
    teamsOfRun: () => [{ teamId: 'team-orc', teamKey: 'ORC' }],
  }));
  fake.scripts.worker = recordingBuild();
  fake.scripts.verifier = pass;
});

afterEach(() => {
  tableOver.make = null;
  _setTicketRetentionForTesting(null);
  _setLinearTicketReadForTesting(null);
  _setLinearProviderPolicyForTesting(null);
  _setPlanQueueDataDirForTesting(null);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('at the moment a job lands', { timeout: 60_000 }, () => {
  it('has its brief file while it works, and neither the file nor the text once it has landed', async () => {
    writeTicketsRun([ORC12], { repo });
    coordinator.requestPump();
    await waitForRun(RUN_ID);

    expect(itemAt().state).toBe('landed');
    // The first worker turn found the file, written from the table.
    expect(workerTurns[0].briefText).toContain('The button does nothing.');
    await fileGone(itemAt().id);
    expectOnlyWhatStays(itemAt().id, ORC12);
  });
});

describe('at the moment a job is skipped', { timeout: 60_000 }, () => {
  it('deletes the brief file and clears the text', async () => {
    writeTicketsRun([ORC12], { repo });
    await writeBrief(itemAt().id);
    expect(rowAt().approvedText).not.toBeNull();

    await coordinator.control({ action: 'skip-item', itemId: itemAt().id });

    expect(itemAt().state).toBe('skipped');
    await fileGone(itemAt().id);
    expectOnlyWhatStays(itemAt().id, ORC12);
  });
});

describe('at the moment a job is set aside', { timeout: 60_000 }, () => {
  it('deletes the brief file and keeps the text, and a Resume writes the file again from it', async () => {
    writeTicketsRun([ORC12], { repo });
    await writeBrief(itemAt().id);

    await flow().park(itemAt().id, 'needs-james', 'Set aside for the test.');

    expect(itemAt().state).toBe('parked');
    await fileGone(itemAt().id);
    expect(rowAt()).toMatchObject({ approvedText: { description: 'The button does nothing.' }, approvedHash: expect.stringMatching(/^[0-9a-f]{64}$/), textClearedAt: null });

    await coordinator.control({ action: 'resume-item', itemId: itemAt().id });
    await waitForRun(RUN_ID);

    // The worker's first turn found the file again, with the same text.
    expect(workerTurns).toHaveLength(1);
    expect(workerTurns[0].briefText).toContain('The button does nothing.');
    expect(workerTurns[0].message).toContain('The button does nothing.');
    expect(itemAt().state).toBe('landed');
  });

  it('keeps the text for 29 days and clears it at 30, by the clock the sweep is given', async () => {
    writeTicketsRun([ORC12], { repo });
    await flow().park(itemAt().id, 'needs-james', 'Set aside for the test.');
    const setAsideAt = table().retentionRows().find((row) => row.itemId === itemAt().id)!.setAsideAt;

    clock = setAsideAt + 29 * DAY;
    await retention.sweep();
    expect(rowAt()).toMatchObject({ approvedText: { description: 'The button does nothing.' }, textClearedAt: null });

    clock = setAsideAt + 30 * DAY - 1;
    await retention.sweep();
    expect(rowAt().textClearedAt).toBeNull();

    clock = setAsideAt + 30 * DAY;
    await retention.sweep();
    expectOnlyWhatStays(itemAt().id, ORC12);
    expect(rowAt().textClearedAt).toBe(clock);
  });
});

describe('at the moment a job is discarded', { timeout: 60_000 }, () => {
  it('deletes the brief file and clears the text', async () => {
    writeTicketsRun([ORC12], { repo });
    await flow().park(itemAt().id, 'needs-james', 'Set aside for the test.');
    await writeBrief(itemAt().id);
    expect(rowAt().approvedText).not.toBeNull();

    await coordinator.control({ action: 'discard-item', itemId: itemAt().id });

    expect(itemAt().discardedAt).not.toBeNull();
    await fileGone(itemAt().id);
    expectOnlyWhatStays(itemAt().id, ORC12);
  });
});

describe('at the moment a run is cancelled', { timeout: 60_000 }, () => {
  it('deletes every brief file and clears every text, a set-aside job\'s included', async () => {
    // The second job is working when the run is cancelled; the first was set aside earlier and still holds its text.
    fake.scripts.worker = recordingBuild(() => new Promise<void>(() => undefined));
    writeTicketsRun([ORC12, ORC13], { repo });
    const [first, second] = [itemAt(0).id, itemAt(1).id];
    await flow().park(first, 'needs-james', 'Set aside for the test.');
    await writeBrief(first);
    await vi.waitFor(() => expect(existsSync(briefOf(second))).toBe(true), { timeout: 20_000, interval: 25 });
    expect(rowAt(0).approvedText).not.toBeNull();
    expect(rowAt(1).approvedText).not.toBeNull();

    await coordinator.control({ action: 'cancel', runId: RUN_ID });

    expect(store.getRun(RUN_ID)?.status).toBe('cancelled');
    expect(itemAt(0).state).toBe('parked');
    expect(itemAt(1)).toMatchObject({ state: 'parked', parkReason: 'cancelled' });
    await fileGone(first);
    await fileGone(second);
    expectOnlyWhatStays(first, ORC12);
    expectOnlyWhatStays(second, ORC13);
  });

  it('takes the open question off a job whose ticket question goes with the text', async () => {
    fake.scripts.worker = recordingBuild(() => new Promise<void>(() => undefined));
    writeTicketsRun([ORC12, ORC13], { repo });
    await flow().park(itemAt(0).id, 'needs-james', 'Set aside for the test.');
    store.upsertItem({ ...itemAt(0), question: ticketAskQuestion('ORC-12', 'changed') });
    expect(itemAt(0).question).not.toBeNull();

    await coordinator.control({ action: 'cancel', runId: RUN_ID });

    expect(rowAt(0).openAsk).toBeNull();
    expect(itemAt(0).question).toBeNull();
  });

  it('does the same when a set-aside job reaches its 30th day', async () => {
    writeTicketsRun([ORC12], { repo });
    await flow().park(itemAt().id, 'needs-james', 'Set aside for the test.');
    store.upsertItem({ ...itemAt(), question: ticketAskQuestion('ORC-12', 'changed') });
    clock = table().retentionRows()[0].setAsideAt + 30 * DAY;

    await retention.sweep();

    expect(rowAt().textClearedAt).not.toBeNull();
    expect(itemAt().question).toBeNull();
  });
});

describe('the sweep', { timeout: 60_000 }, () => {
  const states = ['landed', 'skipped'] as const;

  it.each(states)('finishes a delete and a clear that a stop interrupted after the job was marked %s (the crash window)', async (state) => {
    writeTicketsRun([ORC12], { repo });
    await writeBrief(itemAt().id);
    // The app stopped after the item was marked, before the file was deleted and the text cleared: write the state straight in.
    store.upsertItem({ ...itemAt(), state } as PlanQueueItem);
    expect(existsSync(briefOf(itemAt().id))).toBe(true);
    expect(rowAt().approvedText).not.toBeNull();

    await retention.sweep();

    expect(existsSync(briefOf(itemAt().id))).toBe(false);
    expectOnlyWhatStays(itemAt().id, ORC12);
  });

  it('clears a discarded job and a set-aside job of a cancelled run, and leaves a job that is not final alone', async () => {
    writeTicketsRun([ORC12, ORC13], { repo });
    store.upsertItem({ ...itemAt(0), state: 'parked', parkReason: 'needs-james', discardedAt: clock } as PlanQueueItem);
    await writeBrief(itemAt(0).id);
    await writeBrief(itemAt(1).id);

    await retention.sweep();
    expectOnlyWhatStays(itemAt(0).id, ORC12);
    expect(existsSync(briefOf(itemAt(0).id))).toBe(false);
    // A queued job and its file are not touched.
    expect(rowAt(1).textClearedAt).toBeNull();
    expect(existsSync(briefOf(itemAt(1).id))).toBe(true);

    // The run is cancelled while the job is being resumed (queued, not final): its text stays.
    store.upsertRun({ ...store.getRun(RUN_ID)!, status: 'cancelled', endedAt: clock });
    await retention.sweep();
    expect(rowAt(1).textClearedAt).toBeNull();
    // Once it is set aside again in the cancelled run, it goes.
    store.upsertItem({ ...itemAt(1), state: 'parked', parkReason: 'needs-james' } as PlanQueueItem);
    await retention.sweep();
    expectOnlyWhatStays(itemAt(1).id, ORC13);
    expect(existsSync(briefOf(itemAt(1).id))).toBe(false);
  });

  it('deletes the file of an item that is missing, and a half-written file only after an hour', async () => {
    writeTicketsRun([ORC12], { repo });
    const folder = join(dataDir, 'briefs');
    mkdirSync(folder, { recursive: true });
    const orphan = join(folder, 'item-that-no-longer-exists.md');
    const fresh = join(folder, '.item-orc-12-0000.aaaaaaaaaaaa.tmp');
    const old = join(folder, '.item-orc-12-0000.bbbbbbbbbbbb.tmp');
    for (const file of [orphan, fresh, old]) writeFileSync(file, 'x');
    const longAgo = new Date(clock - 2 * 60 * 60_000);
    utimesSync(old, longAgo, longAgo);
    await writeBrief(itemAt().id);

    await retention.sweep();

    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    // The job is queued, so its own file stays.
    expect(existsSync(briefOf(itemAt().id))).toBe(true);
  });

  it('clears a text once, and a cleared text is not cleared again later', async () => {
    writeTicketsRun([ORC12], { repo });
    store.upsertItem({ ...itemAt(), state: 'skipped' } as PlanQueueItem);
    await retention.sweep();
    const first = rowAt().textClearedAt;
    clock += DAY;
    await retention.sweep();
    expect(rowAt().textClearedAt).toBe(first);
  });
});

describe('Resume of a ticket whose text was cleared', { timeout: 90_000 }, () => {
  /** A set-aside job that has gone 30 days: its text is cleared, and the ticket in Linear says something new. */
  async function clearedAfterThirtyDays(): Promise<void> {
    writeTicketsRun([ORC12], { repo });
    await flow().park(itemAt().id, 'needs-james', 'Set aside for the test.');
    clock = table().retentionRows()[0].setAsideAt + 30 * DAY;
    await retention.sweep();
    expect(rowAt().approvedText).toBeNull();
    linear.change('ORC-12', { description: LIVE });
  }

  it('reads the ticket again, opens the question showing it in full, and starts nothing', async () => {
    await clearedAfterThirtyDays();
    const toSessions = () => fake.inputs.filter((input) => !input.instanceId.startsWith('parent'));
    const before = { sessions: sessionsStarted(), sent: toSessions().length };
    const reads = linear.reads.length;

    await coordinator.control({ action: 'resume-item', itemId: itemAt().id });
    await vi.waitFor(() => expect(itemAt().question).toMatchObject({ jamesOnly: true, question: CLEARED_ASK }), { timeout: 20_000, interval: 25 });
    for (let turn = 0; turn < 4; turn += 1) { coordinator.requestPump(); await new Promise((resolve) => setTimeout(resolve, 25)); }

    expect(linear.reads.length).toBe(reads + 1);
    expect(sessionsStarted()).toBe(before.sessions);
    expect(toSessions()).toHaveLength(before.sent);
    expect(workerTurns).toEqual([]);
    expect(existsSync(briefOf(itemAt().id))).toBe(false);
    expect(itemAt().state).toBe('queued');
    expect(itemAt().parkReason).toBeNull();

    const ask = readTicketAsk(itemAt().id)!;
    expect(ask).toMatchObject({ kind: 'cleared', approved: null, options: [{ id: 'use-now' }, { id: 'stop' }] });
    expect(ask.held?.text).toContain(LIVE);
    expect(ask.held).toMatchObject({ title: ORC12.title, changed: [] });
    expect(JSON.stringify(itemAt())).not.toContain(LIVE);
  });

  it('carries on with the text he read when he approves it, and the next prompt holds only that text', async () => {
    await clearedAfterThirtyDays();
    await coordinator.control({ action: 'resume-item', itemId: itemAt().id });
    await vi.waitFor(() => expect(itemAt().question).toMatchObject({ jamesOnly: true }), { timeout: 20_000, interval: 25 });
    const { askHash } = readTicketAsk(itemAt().id)!;

    await coordinator.answerTicketAsk({ itemId: itemAt().id, optionId: 'use-now', askHash });
    await waitForRun(RUN_ID);

    expect(workerTurns).toHaveLength(1);
    expect(workerTurns[0].message).toContain(LIVE);
    expect(workerTurns[0].briefText).toContain(LIVE);
    expect(itemAt().state).toBe('landed');
  });

  it('stops work on the ticket when he chooses to, and does not start it', async () => {
    await clearedAfterThirtyDays();
    await coordinator.control({ action: 'resume-item', itemId: itemAt().id });
    await vi.waitFor(() => expect(itemAt().question).toMatchObject({ jamesOnly: true }), { timeout: 20_000, interval: 25 });
    const { askHash } = readTicketAsk(itemAt().id)!;

    await coordinator.answerTicketAsk({ itemId: itemAt().id, optionId: 'stop', askHash });

    expect(itemAt().state).toBe('skipped');
    expect(workers()).toHaveLength(0);
  });

  it('refuses the Resume and changes nothing when the ticket cannot be read', async () => {
    await clearedAfterThirtyDays();
    linear.fail('ORC-12', new Error('Linear is not answering'));

    await expect(coordinator.control({ action: 'resume-item', itemId: itemAt().id })).rejects.toThrow('ORC-12 could not be read in Linear, so it was not resumed.');

    expect(itemAt()).toMatchObject({ state: 'parked', question: null });
    expect(rowAt()).toMatchObject({ openAsk: null, approvedText: null });
    expect(sessionsStarted()).toBe(0);
  });

  it('asks the same way for a job of a cancelled run, whose text was cleared when the run was cancelled', async () => {
    // A second job keeps the run open while the first is set aside, so the run can still be cancelled.
    fake.scripts.worker = recordingBuild(() => new Promise<void>(() => undefined));
    writeTicketsRun([ORC12, ORC13], { repo });
    await flow().park(itemAt(0).id, 'needs-james', 'Set aside for the test.');
    await vi.waitFor(() => expect(workers()).toHaveLength(1), { timeout: 20_000, interval: 25 });
    await coordinator.control({ action: 'cancel', runId: RUN_ID });
    expectOnlyWhatStays(itemAt(0).id, ORC12);
    linear.change('ORC-12', { description: LIVE });
    const started = workers().length;

    await coordinator.control({ action: 'resume-item', itemId: itemAt(0).id });
    await vi.waitFor(() => expect(itemAt(0).question).toMatchObject({ jamesOnly: true, question: CLEARED_ASK }), { timeout: 20_000, interval: 25 });
    expect(workers()).toHaveLength(started);
    expect(readTicketAsk(itemAt(0).id)).toMatchObject({ kind: 'cleared' });
  });
});

describe('the sweep and a Resume of the same set-aside job on its 30th day', { timeout: 90_000 }, () => {
  /** A set-aside job on its 30th day, and a retention that says when a Resume has named its job. */
  async function onTheThirtiethDay(): Promise<{ resumeNamedItsJob: Promise<void> }> {
    writeTicketsRun([ORC12], { repo });
    await flow().park(itemAt().id, 'needs-james', 'Set aside for the test.');
    clock = table().retentionRows()[0].setAsideAt + 30 * DAY;
    let named!: () => void;
    const resumeNamedItsJob = new Promise<void>((resolve) => { named = resolve; });
    const base = retention;
    retention = { ...base, holdForResume: (itemId) => { const release = base.holdForResume(itemId); named(); return release; } };
    _setTicketRetentionForTesting(retention);
    return { resumeNamedItsJob };
  }
  const settlePump = async () => { for (let turn = 0; turn < 8; turn += 1) { coordinator.requestPump(); await new Promise((resolve) => setTimeout(resolve, 25)); } };

  it('the Resume names its job first: the sweep leaves the text, and the job carries on with it', async () => {
    const { resumeNamedItsJob } = await onTheThirtiethDay();
    const resuming = coordinator.control({ action: 'resume-item', itemId: itemAt().id });
    await resumeNamedItsJob;

    await retention.sweep();
    await resuming;
    await waitForRun(RUN_ID);

    expect(workerTurns).toHaveLength(1);
    expect(workerTurns[0].briefText).toContain('The button does nothing.');
    expect(workerTurns[0].message).toContain('The button does nothing.');
    expect(itemAt().state).toBe('landed');
  });

  it('the sweep clears first: the Resume reads the ticket again and asks, and nothing starts with an empty brief', async () => {
    await onTheThirtiethDay();
    linear.change('ORC-12', { description: LIVE });

    await retention.sweep();
    expect(rowAt().approvedText).toBeNull();
    await coordinator.control({ action: 'resume-item', itemId: itemAt().id });
    await settlePump();

    await vi.waitFor(() => expect(itemAt().question).toMatchObject({ jamesOnly: true }), { timeout: 20_000, interval: 25 });
    expect(readTicketAsk(itemAt().id)).toMatchObject({ kind: 'cleared' });
    expect(readTicketAsk(itemAt().id)?.held?.text).toContain(LIVE);
    expect(workerTurns).toEqual([]);
    expect(itemAt().parkReason).toBeNull();
  });

  it('both started in the same turn: whichever wins, the job carries on with its text or asks again, never with an empty brief', async () => {
    await onTheThirtiethDay();

    await Promise.all([retention.sweep(), coordinator.control({ action: 'resume-item', itemId: itemAt().id })]);
    await settlePump();

    if (rowAt().approvedText !== null) {
      await waitForRun(RUN_ID);
      expect(workerTurns[0].briefText).toContain('The button does nothing.');
    } else {
      await vi.waitFor(() => expect(itemAt().question).toMatchObject({ jamesOnly: true }), { timeout: 20_000, interval: 25 });
      expect(workerTurns).toEqual([]);
    }
    expect(itemAt().parkReason).not.toBe('missing-document');
    expect(workerTurns.every((turn) => turn.briefText !== null && turn.briefText.length > 0)).toBe(true);
  });

  it('a job named as being resumed keeps its text through the sweep, and loses it the next time once the Resume is over', async () => {
    writeTicketsRun([ORC12], { repo });
    await flow().park(itemAt().id, 'needs-james', 'Set aside for the test.');
    clock = table().retentionRows()[0].setAsideAt + 30 * DAY;

    const release = retention.holdForResume(itemAt().id);
    await retention.sweep();
    expect(rowAt().textClearedAt).toBeNull();

    release();
    release();
    await retention.sweep();
    expectOnlyWhatStays(itemAt().id, ORC12);
  });
});
