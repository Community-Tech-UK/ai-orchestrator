/**
 * James's three answers to the question a changed Linear ticket opens, from every state a job can be held in. Real
 * coordinator, real ticket table and fake sessions; Linear is a scripted fake that records every read. The states a job is
 * held in: before its first session (queued, no work yet), a fix round after it began (queued, with its branch), a check
 * (awaiting a slot) and a landing (awaiting a slot, with its commit dropped).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { machineGates } from './plan-queue-coordinator.test-mocks';
import {
  coordinator, defineDefaultScripts, driver, fake, itemIdOf, pass, repo, restart, store, waitForRun, type FakeInstance, type Script,
} from './plan-queue-coordinator.test-helpers';
import { _setPlanQueueDataDirForTesting } from './plan-queue-data-dir';
import { _setLinearProviderPolicyForTesting, LinearProviderPolicy } from './plan-queue-linear-providers';
import { _resetLinearTicketGuardForTesting, _setLinearTicketReadForTesting } from './plan-queue-linear-source';
import { PlanQueueLinearTicketStore } from './plan-queue-linear-ticket-store';
import { readTicketAsk } from './plan-queue-ticket-answer';
import { hashTicketText } from './plan-queue-linear-ticket-hash';
import { FakeLinearTickets, RUN_ID, ticketText, writeTicketsRun, type TestTicket } from './plan-queue-ticket-round.test-helpers';

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

const HELD = 'paste the env file here';
const ASK = 'ORC-12 changed in Linear. Answer on the Plan Queue page.';
const ORC12: TestTicket = {
  linearId: 'lin-12', identifier: 'ORC-12', title: 'Make the sign in button work', text: ticketText('The button does nothing.'),
};

let linear: FakeLinearTickets;
let dataDir: string;
let built = 0;

const build: Script = (instance) => {
  built += 1;
  writeFileSync(join(instance.workingDirectory!, `${itemIdOf(instance)}.feature.txt`), `built ${built}\n`);
};
const workers = (instances = fake) => instances.created.filter((instance: FakeInstance) => instance.role === 'worker');
const checkers = (instances = fake) => instances.created.filter((instance: FakeInstance) => instance.role === 'verifier');
const table = () => new PlanQueueLinearTicketStore(driver);
const itemOf = () => store.listItems(RUN_ID)[0];
const askOf = () => table().get(itemOf().id)?.openAsk ?? null;
const heldHashOfLinear = () => hashTicketText({ title: ORC12.title, description: HELD, comments: [] });
const fail = (instance: FakeInstance): void => {
  coordinator.reportVerdict(instance.id, {
    item_id: itemIdOf(instance), verdict: 'FAIL',
    findings: [{ severity: 'high', kind: 'code', confidence: 90, summary: 'The button still does nothing.' }],
    gates_run: [], document_complete: false, need_james: [], not_checked: [],
  });
};
/** Every prompt a session was sent from this point on. */
const promptsSince = (created: number, inputs: number): string => [
  ...fake.created.slice(created).map((instance: FakeInstance) => instance.config.initialPrompt ?? ''),
  ...fake.inputs.slice(inputs).map((input) => input.message),
].join('\n');
const mark = () => ({ created: fake.created.length, inputs: fake.inputs.length });

/** The question as the page reads it, then James's answer from the page. */
const answer = (optionId: string, askHash = readTicketAsk(itemOf().id)!.askHash) =>
  coordinator.answerTicketAsk({ itemId: itemOf().id, optionId, askHash });

async function expectHeld(): Promise<void> {
  await vi.waitFor(() => expect(askOf()).not.toBeNull(), { timeout: 20_000, interval: 25 });
  await vi.waitFor(() => expect(itemOf().heldAt).not.toBeNull(), { timeout: 20_000, interval: 25 });
  expect(itemOf()).toMatchObject({ detail: ASK, parkReason: null, question: { jamesOnly: true } });
}

/** Where a job can be held. Each script changes the ticket at the moment named, so the next check finds it. */
const HELD_STATES: readonly { name: string; hold: () => void; sawSessions: { workers: number; checkers: number } }[] = [
  { name: 'before its first session', hold: () => linear.change('ORC-12', { description: HELD }), sawSessions: { workers: 0, checkers: 0 } },
  { name: 'at a fix round after it began', hold: () => {
    let changed = false;
    fake.scripts.verifier = (instance, message, f) => { if (changed) return pass(instance, message, f); changed = true; linear.change('ORC-12', { description: HELD }); return fail(instance); };
  }, sawSessions: { workers: 1, checkers: 1 } },
  { name: 'at a check', hold: () => { fake.scripts.worker = (instance, message, f) => { build(instance, message, f); linear.change('ORC-12', { description: HELD }); }; }, sawSessions: { workers: 1, checkers: 0 } },
  { name: 'at the landing', hold: () => {
    let changed = false;
    fake.scripts.verifier = (instance, message, f) => { void pass(instance, message, f); if (!changed) { changed = true; linear.change('ORC-12', { description: HELD }); } };
  }, sawSessions: { workers: 1, checkers: 1 } },
];

beforeEach(() => {
  void machineGates;
  defineDefaultScripts();
  built = 0;
  tableOver.make = () => new PlanQueueLinearTicketStore(driver);
  _resetLinearTicketGuardForTesting();
  linear = new FakeLinearTickets([ORC12]);
  _setLinearTicketReadForTesting((identifier) => linear.read(identifier));
  dataDir = mkdtempSync(join(tmpdir(), 'ticket-answer-data-'));
  _setPlanQueueDataDirForTesting(dataDir);
  _setLinearProviderPolicyForTesting(new LinearProviderPolicy({
    readTeams: () => [{ teamId: 'team-orc', providers: ['claude', 'codex'] }],
    teamsOfRun: () => [{ teamId: 'team-orc', teamKey: 'ORC' }],
  }));
  fake.scripts.worker = build;
  fake.scripts.verifier = pass;
});

afterEach(() => {
  tableOver.make = null;
  _setLinearTicketReadForTesting(null);
  _setLinearProviderPolicyForTesting(null);
  _setPlanQueueDataDirForTesting(null);
  rmSync(dataDir, { recursive: true, force: true });
});

async function holdAt(state: (typeof HELD_STATES)[number]): Promise<void> {
  state.hold();
  writeTicketsRun([ORC12], { repo });
  coordinator.requestPump();
  await expectHeld();
  expect(workers()).toHaveLength(state.sawSessions.workers);
  expect(checkers()).toHaveLength(state.sawSessions.checkers);
}

describe.each(HELD_STATES)('a job held $name', (state) => {
  describe('use the ticket as it is now', { timeout: 60_000 }, () => {
    it('approves the held text, closes the question, releases the hold and carries on once with the new text', async () => {
      await holdAt(state);
      const before = table().get(itemOf().id)!;
      const seen = mark();

      await answer('use-now');

      const after = table().get(itemOf().id)!;
      expect(after.openAsk).toBeNull();
      expect(after).toMatchObject({ approvedTitle: ORC12.title, approvedHash: heldHashOfLinear(), leftOutHash: null });
      expect(after.approvedText?.description).toBe(HELD);
      expect(after.approvedAt).toBeGreaterThan(before.approvedAt);
      expect(itemOf()).toMatchObject({ question: null, heldAt: null, answer: 'ORC-12 changed in Linear → Use the ticket as it is now' });
      expect(JSON.stringify(itemOf())).not.toContain(HELD);

      await waitForRun(RUN_ID);
      expect(itemOf()).toMatchObject({ state: 'landed', parkReason: null });
      expect(askOf()).toBeNull();
      // The next prompt carries the new text. A job that had begun is told the ticket changed since it started.
      const prompts = promptsSince(seen.created, seen.inputs);
      expect(prompts).toContain(HELD);
      expect(prompts.includes('The ticket changed since you started. The brief above is its current text.')).toBe(state.sawSessions.workers > 0 && state.name !== 'at a check' && state.name !== 'at the landing');
    });
  });

  describe('carry on with the version I approved', { timeout: 60_000 }, () => {
    it('leaves the held hash out, keeps the old text, releases the hold, and the same change does not ask again', async () => {
      await holdAt(state);
      const approved = table().get(itemOf().id)!;
      const seen = mark();

      await answer('keep-approved');

      expect(table().get(itemOf().id)).toMatchObject({
        openAsk: null, leftOutHash: heldHashOfLinear(), approvedHash: approved.approvedHash, approvedAt: approved.approvedAt,
      });
      expect(itemOf()).toMatchObject({ question: null, heldAt: null, answer: 'ORC-12 changed in Linear → Carry on with the version I approved' });

      await waitForRun(RUN_ID);
      expect(itemOf()).toMatchObject({ state: 'landed', parkReason: null });
      expect(askOf()).toBeNull();
      const prompts = promptsSince(seen.created, seen.inputs);
      expect(prompts).not.toContain(HELD);
      expect(prompts).not.toContain('changed since you started');
      if (state.sawSessions.workers === 0) expect(prompts).toContain('The button does nothing.');
    });
  });

  describe('stop work on this ticket', { timeout: 60_000 }, () => {
    it('sets the job aside as needs-james: its work folder is already made, so it has started', async () => {
      await holdAt(state);
      const seen = mark();
      const reads = linear.reads.length;
      const toSessions = () => fake.inputs.filter((input) => !input.instanceId.startsWith('parent'));
      const sent = toSessions().length;

      await answer('stop');

      expect(askOf()).toBeNull();
      expect(table().get(itemOf().id)).toMatchObject({ approvedHash: expect.any(String), leftOutHash: null });
      expect(table().get(itemOf().id)?.approvedText?.description).toBe('The button does nothing.');
      expect(itemOf()).toMatchObject({ state: 'parked', parkReason: 'needs-james', question: null, heldAt: null });
      expect(itemOf().answer).toBe('ORC-12 changed in Linear → Stop work on this ticket');
      await waitForRun(RUN_ID);
      expect(fake.created).toHaveLength(seen.created);
      expect(toSessions()).toHaveLength(sent);
      expect(linear.reads).toHaveLength(reads);
    });
  });
});

describe('a ticket that has gone', { timeout: 60_000 }, () => {
  const GONE = 'ORC-12 was removed from Linear or moved out of its project. Answer on the Plan Queue page.';

  beforeEach(async () => {
    linear.gone('ORC-12');
    writeTicketsRun([ORC12], { repo });
    coordinator.requestPump();
    await vi.waitFor(() => expect(askOf()).toMatchObject({ kind: 'gone' }), { timeout: 20_000, interval: 25 });
    await vi.waitFor(() => expect(itemOf().heldAt).not.toBeNull(), { timeout: 20_000, interval: 25 });
  });

  it('offers only stopping and leaving it waiting', () => {
    expect(readTicketAsk(itemOf().id)).toMatchObject({
      kind: 'gone', held: null, options: [{ id: 'stop', label: 'Stop work on this ticket' }, { id: 'leave-waiting', label: 'Leave it waiting' }],
    });
    expect(itemOf().detail).toBe(GONE);
  });

  it.each(['use-now', 'keep-approved'])('refuses "%s", which needs text there is none of, and changes nothing', async (optionId) => {
    await expect(answer(optionId)).rejects.toThrow('That answer is not offered for this question.');
    expect(askOf()).toMatchObject({ kind: 'gone' });
    expect(itemOf().heldAt).not.toBeNull();
  });

  it('leaves it waiting: the question stays open and nothing changes', async () => {
    const before = itemOf();
    await answer('leave-waiting');
    expect(askOf()).toMatchObject({ kind: 'gone' });
    expect(itemOf()).toEqual(before);
    expect(workers()).toHaveLength(0);
  });

  it('stops: its work folder is already made, so the job is set aside, and nothing more starts', async () => {
    await answer('stop');
    expect(askOf()).toBeNull();
    expect(itemOf()).toMatchObject({ state: 'parked', parkReason: 'needs-james', answer: 'ORC-12 was removed from Linear or moved out of its project → Stop work on this ticket' });
    await waitForRun(RUN_ID);
    expect(workers()).toHaveLength(0);
  });
});

describe('a question open before the job has a work folder', { timeout: 60_000 }, () => {
  it('stop skips the ticket, which has not started, and starts nothing', async () => {
    const { items } = writeTicketsRun([ORC12], { repo });
    table().openAsk(items[0].id, { kind: 'gone', openedAt: 5 });
    coordinator.requestPump();
    await vi.waitFor(() => expect(itemOf().question).toMatchObject({ jamesOnly: true }), { timeout: 20_000, interval: 25 });
    expect(itemOf()).toMatchObject({ state: 'queued', branchName: null, worktreePath: null });

    await answer('stop');

    expect(itemOf()).toMatchObject({ state: 'skipped', question: null, heldAt: null, detail: 'James chose to stop work on this ticket.' });
    expect(askOf()).toBeNull();
    await waitForRun(RUN_ID);
    expect(workers()).toHaveLength(0);
    expect(linear.reads).toEqual([]);
  });
});

describe('an answer against a question that is not the one James was shown', { timeout: 60_000 }, () => {
  it('is refused, with the new question still open and nothing changed', async () => {
    await holdAt(HELD_STATES[0]);
    const shown = readTicketAsk(itemOf().id)!;
    // The question was replaced after he read it: answered one way, then a further change opened another.
    const next = 'b'.repeat(64);
    table().closeAsk(itemOf().id, null);
    table().openAsk(itemOf().id, { kind: 'changed', heldTitle: ORC12.title, heldText: { ...ORC12.text, description: 'a newer change' }, heldHash: next, changed: ['description'], openedAt: 9 });
    const before = { row: table().get(itemOf().id), item: itemOf() };

    for (const optionId of ['use-now', 'keep-approved', 'stop']) {
      await expect(answer(optionId, shown.askHash)).rejects.toThrow('The ticket changed again. Read the new version.');
    }

    expect(table().get(itemOf().id)).toEqual(before.row);
    expect(itemOf()).toEqual(before.item);
    expect(askOf()).toMatchObject({ kind: 'changed', heldHash: next });
  });

  it('is refused when it is for a question that was already answered', async () => {
    await holdAt(HELD_STATES[0]);
    const { askHash } = readTicketAsk(itemOf().id)!;
    await answer('keep-approved', askHash);
    await expect(answer('use-now', askHash)).rejects.toThrow('This question has already been answered.');
    expect(table().get(itemOf().id)).toMatchObject({ leftOutHash: heldHashOfLinear() });
  });

  it('reads back no question for a job that has none, and refuses a job that is not a ticket', () => {
    writeTicketsRun([ORC12], { repo });
    expect(readTicketAsk(itemOf().id)).toBeNull();
    expect(() => readTicketAsk('no-such-item')).toThrow('This job has no Linear ticket.');
  });
});

describe('two at once', { timeout: 60_000 }, () => {
  it('applies one of two answers sent together and refuses the other', async () => {
    await holdAt(HELD_STATES[0]);
    const { askHash } = readTicketAsk(itemOf().id)!;
    const results = await Promise.allSettled([answer('use-now', askHash), answer('stop', askHash)]);

    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected']);
    expect(results[1]).toMatchObject({ reason: { message: 'This answer is already being applied. Wait for it to finish.' } });
    expect(table().get(itemOf().id)).toMatchObject({ openAsk: null, approvedHash: heldHashOfLinear() });
    await waitForRun(RUN_ID);
    // Only the first answer was applied: the job was not stopped.
    expect(itemOf().state).toBe('landed');
  });

  it('asks again for a change made at the moment of the answer, losing neither', async () => {
    await holdAt(HELD_STATES[0]);
    const { askHash } = readTicketAsk(itemOf().id)!;
    const newer = `${HELD}, and drop the table`;
    linear.change('ORC-12', { description: newer });

    await answer('use-now', askHash);

    // What he saw is approved, and the newer change asks on its own.
    expect(table().get(itemOf().id)).toMatchObject({ approvedHash: heldHashOfLinear() });
    await vi.waitFor(() => expect(askOf()).toMatchObject({ kind: 'changed', heldText: { description: newer } }), { timeout: 20_000, interval: 25 });
    await vi.waitFor(() => expect(itemOf()).toMatchObject({ question: { jamesOnly: true } }), { timeout: 20_000, interval: 25 });
    expect(workers()).toHaveLength(0);
  });
});

describe('the crash window', { timeout: 60_000 }, () => {
  it('stopping after the approved text is replaced and before the hold is released: on restart the question is closed, the new text approved, and the job carries on once', async () => {
    await holdAt(HELD_STATES[0]);
    const { askHash } = readTicketAsk(itemOf().id)!;
    // The app stopped here: the table has the answer, but the job was never released.
    expect(table().answerAsk(itemOf().id, askHash, { choice: 'use-now', at: Date.now() })).toBe('applied');
    expect(itemOf()).toMatchObject({ heldAt: expect.any(Number), question: { jamesOnly: true } });

    const next = await restart(null, { scripts: { worker: build, verifier: pass } });
    await waitForRun(RUN_ID);

    expect(askOf()).toBeNull();
    expect(table().get(itemOf().id)?.approvedText?.description).toBe(HELD);
    expect(itemOf()).toMatchObject({ state: 'landed', question: null });
    expect(workers(next)).toHaveLength(1);
    expect(promptsFor(next)).toContain(HELD);
  });

  it('stopping before the replace: the question is still open and the old text still approved', async () => {
    await holdAt(HELD_STATES[0]);
    const before = table().get(itemOf().id)!;
    const reads = linear.reads.length;

    const next = await restart(null, { scripts: { worker: build, verifier: pass } });
    await expectHeld();

    expect(table().get(itemOf().id)).toEqual(before);
    expect(workers(next)).toHaveLength(0);
    expect(linear.reads).toHaveLength(reads);
  });
});

const promptsFor = (instances: typeof fake) => instances.created.map((instance: FakeInstance) => instance.config.initialPrompt ?? '').join('\n');
