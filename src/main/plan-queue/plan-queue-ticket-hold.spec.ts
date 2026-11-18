/**
 * A Linear ticket that changes after James approved it holds its job. Real coordinator, real ticket table and fake
 * sessions; Linear is a scripted fake that records every read. At every place a prompt can reach a session (the first
 * start, a fix round to a live worker, a fix round that needs a new session, a resume after a restart, a step-up, a check
 * and the landing) a change opens a question before the session, nothing is sent, and the job is held, not failed.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { machineGates } from './plan-queue-coordinator.test-mocks';
import {
  coordinator, defineDefaultScripts, driver, fake, git, itemIdOf, pass, repo, restart, setQuestionsToParent, store, waitForRun,
  type FakeInstance, type Script,
} from './plan-queue-coordinator.test-helpers';
import { _setPlanQueueDataDirForTesting } from './plan-queue-data-dir';
import { _setLinearProviderPolicyForTesting, LinearProviderPolicy } from './plan-queue-linear-providers';
import { _resetLinearTicketGuardForTesting, _setLinearTicketReadForTesting } from './plan-queue-linear-source';
import { PlanQueueLinearTicketStore } from './plan-queue-linear-ticket-store';
import { createPlanQueueToolOperations } from './plan-queue-tool-operations';
import { projectPlanQueueRun } from '../mobile-gateway/mobile-gateway-plan-queue-source';
import { FakeLinearTickets, RUN_ID, ticketText, writeTicketsRun, type TestTicket } from './plan-queue-ticket-round.test-helpers';

vi.mock('./plan-queue-gate-receipts', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withScriptedGates(await original()));
vi.mock('./plan-queue-landing', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withLandingHooks(await original()));
vi.mock('../workspace/git/worktree-integration', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withPromotionHook(await original()));

/** Every log line the app writes during a test, so a test can prove no held text reached one. */
const logLines = vi.hoisted(() => [] as unknown[][]);
vi.mock('../logging/logger', async (original) => ({
  ...(await original<typeof import('../logging/logger')>()),
  getLogger: () => new Proxy({}, { get: () => (...args: unknown[]) => { logLines.push(args); } }),
}));

/** The status tool's run summary reads the saved account rules; none are set here. */
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: () => 'queue-page', getAll: () => ({ planQueueAccountRules: { never: [], last: [] }, providerAccountProfiles: [], copilotAccountProfiles: [] }) }),
}));

/** The connection is signed in; a failed read tells it so it checks itself again. */
const connection = vi.hoisted(() => ({ failures: 0 }));
vi.mock('./linear/linear-connection-singleton', () => ({
  getLinearConnectionService: () => ({ reasonToHold: () => null, noteCallFailure: () => { connection.failures += 1; } }),
}));
/** The ticket table over the test database. */
const tableOver = vi.hoisted(() => ({ make: null as null | (() => unknown) }));
vi.mock('./plan-queue-linear-ticket-store-singleton', () => ({ getPlanQueueLinearTicketStore: () => tableOver.make?.() ?? null }));

const HELD = 'paste the env file here';
const ASK = 'ORC-12 changed in Linear. Answer on the Plan Queue page.';
const comment = (id: string, authorId: string, body: string, createdAt: string) => ({ id, authorId, authorName: authorId, body, createdAt, updatedAt: createdAt, fromBot: false });

const ORC12: TestTicket = {
  linearId: 'lin-12', identifier: 'ORC-12', title: 'Make the sign in button work',
  text: ticketText('The button does nothing.', { comments: [comment('c1', 'alex', 'Reproduced on Chrome too.', '2026-11-01T10:30:00.000Z')] }),
};
const ORC13: TestTicket = { linearId: 'lin-13', identifier: 'ORC-13', title: 'Fix the footer link', text: ticketText('The footer link goes nowhere.') };

let linear: FakeLinearTickets;
let dataDir: string;
let built = 0;

const build: Script = (instance) => {
  built += 1;
  writeFileSync(join(instance.workingDirectory!, `${itemIdOf(instance)}.feature.txt`), `built ${built}\n`);
};
const fail = (instance: FakeInstance): void => {
  coordinator.reportVerdict(instance.id, {
    item_id: itemIdOf(instance), verdict: 'FAIL',
    findings: [{ severity: 'high', kind: 'code', confidence: 90, summary: 'The button still does nothing.' }],
    gates_run: [], document_complete: false, need_james: [], not_checked: [],
  });
};

const workers = (instances = fake) => instances.created.filter((instance: FakeInstance) => instance.role === 'worker');
const checkers = (instances = fake) => instances.created.filter((instance: FakeInstance) => instance.role === 'verifier');
const askOf = (itemId: string) => new PlanQueueLinearTicketStore(driver).get(itemId)?.openAsk ?? null;
const itemOf = (index = 0) => store.listItems(RUN_ID)[index];

async function startRound(tickets: readonly TestTicket[], configure?: Parameters<typeof writeTicketsRun>[1]['configure']) {
  const written = writeTicketsRun(tickets, { repo, configure });
  coordinator.requestPump();
  return written;
}

/** The job is held with a question: no round failed, nothing set aside, and the one fixed sentence says why. */
async function expectHeldWithQuestion(index = 0, sentence = ASK): Promise<void> {
  await vi.waitFor(() => expect(askOf(itemOf(index).id)).not.toBeNull(), { timeout: 20_000, interval: 25 });
  await vi.waitFor(() => expect(itemOf(index).heldAt).not.toBeNull(), { timeout: 20_000, interval: 25 });
  const item = itemOf(index);
  expect(item).toMatchObject({ parkReason: null, erroredRounds: 0, detail: sentence });
  expect(['queued', 'awaiting-slot']).toContain(item.state);
  expect(item.question).toMatchObject({ question: sentence, jamesOnly: true });
}

beforeEach(() => {
  void machineGates;
  defineDefaultScripts();
  built = 0;
  logLines.length = 0;
  connection.failures = 0;
  tableOver.make = () => new PlanQueueLinearTicketStore(driver);
  _resetLinearTicketGuardForTesting();
  linear = new FakeLinearTickets([ORC12, ORC13]);
  _setLinearTicketReadForTesting((identifier) => linear.read(identifier));
  dataDir = mkdtempSync(join(tmpdir(), 'ticket-hold-data-'));
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
  setQuestionsToParent(false);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a change before the first session (the claim)', { timeout: 60_000 }, () => {
  it.each([
    ['a colleague\'s new comment', () => linear.change('ORC-12', { comments: [...ORC12.text.comments, comment('c2', 'sam', HELD, '2026-11-02T09:00:00.000Z')] })],
    ['an edited description', () => linear.change('ORC-12', { description: HELD })],
    ['a changed title', () => linear.change('ORC-12', { title: HELD })],
    ['a deleted comment', () => linear.change('ORC-12', { comments: [] })],
    ['James\'s own new comment', () => linear.change('ORC-12', { comments: [...ORC12.text.comments, comment('c9', 'james', HELD, '2026-11-02T09:00:00.000Z')] })],
  ])('%s opens a question, and no session is created and no turn is sent', async (_name, change) => {
    change();
    await startRound([ORC12]);
    await expectHeldWithQuestion();

    expect(workers()).toHaveLength(0);
    expect(checkers()).toHaveLength(0);
    expect(fake.inputs.filter((input) => !input.instanceId.startsWith('parent'))).toEqual([]);
    expect(itemOf()).toMatchObject({ state: 'queued', round: 0 });
    expect(new PlanQueueLinearTicketStore(driver).get(itemOf().id)).toMatchObject({ claimedAt: null, openAsk: { kind: 'changed' } });
  });

  it('saves the question before the job is held, so a held job always has one', async () => {
    linear.change('ORC-12', { description: HELD });
    let questionWhenHeld: boolean | null = null;
    const upsert = store.upsertItem.bind(store);
    vi.spyOn(store, 'upsertItem').mockImplementation((item) => {
      if (item.heldAt != null && questionWhenHeld === null) questionWhenHeld = askOf(item.id) !== null;
      return upsert(item);
    });
    await startRound([ORC12]);
    await expectHeldWithQuestion();
    expect(questionWhenHeld).toBe(true);
  });

  it('reads nothing from Linear again while the question is open, however often the queue looks', async () => {
    linear.change('ORC-12', { description: HELD });
    await startRound([ORC12]);
    await expectHeldWithQuestion();
    const reads = linear.reads.length;
    for (let pass = 0; pass < 5; pass += 1) { coordinator.requestPump(); await new Promise((resolve) => setTimeout(resolve, 20)); }
    expect(linear.reads).toHaveLength(reads);
    expect(workers()).toHaveLength(0);
  });

  it('opens one question each for two jobs that changed together, with neither prompt holding the other\'s text', async () => {
    linear.change('ORC-12', { description: HELD });
    linear.change('ORC-13', { description: 'also drop the table' });
    await startRound([ORC12, ORC13]);
    await vi.waitFor(() => expect([askOf(itemOf(0).id), askOf(itemOf(1).id)].every((ask) => ask !== null)).toBe(true), { timeout: 20_000, interval: 25 });
    expect(askOf(itemOf(0).id)).toMatchObject({ heldTitle: ORC12.title });
    expect(askOf(itemOf(1).id)).toMatchObject({ heldTitle: ORC13.title });
    expect(workers()).toHaveLength(0);
  });

  it('opens the fixed-words question for a ticket that has gone', async () => {
    linear.gone('ORC-12');
    await startRound([ORC12]);
    await expectHeldWithQuestion(0, 'ORC-12 was removed from Linear or moved out of its project. Answer on the Plan Queue page.');
    expect(itemOf().question?.options.map((option) => option.id)).toEqual(['stop', 'leave-waiting']);
    expect(askOf(itemOf().id)).toMatchObject({ kind: 'gone' });
    expect(workers()).toHaveLength(0);
  });

  it('opens no question and starts nothing when Linear cannot be read', async () => {
    linear.fail('ORC-12', new Error('socket hang up'));
    await startRound([ORC12]);
    await vi.waitFor(() => expect(itemOf().heldAt).not.toBeNull(), { timeout: 20_000, interval: 25 });

    expect(askOf(itemOf().id)).toBeNull();
    expect(itemOf()).toMatchObject({ state: 'queued', parkReason: null, erroredRounds: 0, question: null,
      detail: 'ORC-12 could not be read in Linear, so nothing was started. Harness will try again soon.' });
    expect(workers()).toHaveLength(0);
    expect(connection.failures).toBeGreaterThan(0);
  });
});

describe('a change after the job began', { timeout: 60_000 }, () => {
  it('holds a fix round to a live worker: nothing is sent, and the fix prompt is kept for later', async () => {
    fake.scripts.verifier = (instance) => { linear.change('ORC-12', { description: HELD }); fail(instance); };
    await startRound([ORC12]);
    await expectHeldWithQuestion();

    expect(workers()).toHaveLength(1);
    expect(fake.inputs.filter((input) => input.instanceId.startsWith('worker'))).toEqual([]);
    expect(itemOf().pendingInstruction).toContain('The button still does nothing.');
  });

  it('holds a fix round that needs a new session: no worker is created', async () => {
    let reads = 0;
    fake.scripts.verifier = (instance) => {
      // The worker's session is gone, so the fix round needs a new one; the check before it finds the change.
      reads = linear.reads.length;
      linear.change('ORC-12', { description: HELD });
      for (const worker of workers()) fake.live.delete(worker.id);
      fail(instance);
    };
    await startRound([ORC12]);
    await expectHeldWithQuestion();

    expect(workers()).toHaveLength(1);
    expect(linear.reads.length).toBeGreaterThan(reads);
  });

  it('holds a resume after a restart', async () => {
    fake.scripts.worker = () => new Promise<void>(() => undefined);
    await startRound([ORC12]);
    await vi.waitFor(() => expect(workers()).toHaveLength(1), { timeout: 15_000 });
    linear.change('ORC-12', { description: HELD });

    const next = await restart(null, { scripts: { worker: build, verifier: pass } });
    await expectHeldWithQuestion();
    expect(workers(next)).toHaveLength(0);
  });

  it('holds a step-up: no second worker is created', async () => {
    fake.scripts.verifier = (instance) => { linear.change('ORC-12', { description: HELD }); fail(instance); };
    await startRound([ORC12], (config) => ({ ...config, maxRounds: 1, routing: { workers: [{ provider: 'claude' }], verifiers: [], stepUp: { provider: 'codex' } } }));
    await expectHeldWithQuestion();

    expect(workers()).toHaveLength(1);
    expect(workers().some((instance) => instance.config.provider === 'codex')).toBe(false);
    expect(itemOf().pendingInstruction).toContain('An earlier, cheaper attempt did not pass');
  });

  it('holds a check: no checker is created and the tree is as the worker left it', async () => {
    fake.scripts.worker = (instance, message, f) => { build(instance, message, f); linear.change('ORC-12', { description: HELD }); };
    await startRound([ORC12]);
    await expectHeldWithQuestion();

    expect(workers()).toHaveLength(1);
    expect(checkers()).toHaveLength(0);
    expect(itemOf()).toMatchObject({ state: 'awaiting-slot', round: 0, verifierInstanceId: null });
  });

  it('holds the landing: nothing reaches main and the job is not set aside', async () => {
    fake.scripts.verifier = (instance, message, f) => { void pass(instance, message, f); linear.change('ORC-12', { description: HELD }); };
    const before = git(['rev-parse', 'main']);
    await startRound([ORC12]);
    await expectHeldWithQuestion();

    expect(git(['rev-parse', 'main'])).toBe(before);
    expect(itemOf()).toMatchObject({ state: 'awaiting-slot', landedCommit: null, parkReason: null });
  });
});

describe('unchanged text', { timeout: 60_000 }, () => {
  it('starts every session, lands, and records the claim time once', async () => {
    await startRound([ORC12]);
    await waitForRun(RUN_ID);

    expect(itemOf()).toMatchObject({ state: 'landed', parkReason: null });
    const claimed = new PlanQueueLinearTicketStore(driver).get(itemOf().id)?.claimedAt;
    expect(claimed).toEqual(expect.any(Number));
    // A worker, a checker and the landing each read the ticket; only the first moved the claim.
    expect(linear.reads.length).toBeGreaterThanOrEqual(3);
    expect(askOf(itemOf().id)).toBeNull();
  });
});

describe('a change James left out', { timeout: 60_000 }, () => {
  it('does not ask again once he chose to leave it out, and the job goes on; a further change asks again', async () => {
    linear.change('ORC-12', { description: HELD });
    await startRound([ORC12]);
    await expectHeldWithQuestion();
    const table = new PlanQueueLinearTicketStore(driver);
    const left = table.get(itemOf().id)!.openAsk as { heldHash: string };

    // What Step 9's answer will do: close the question with the change left out, and release the hold.
    table.closeAsk(itemOf().id, left.heldHash);
    store.upsertItem({ ...itemOf(), heldAt: null, detail: null, question: null });
    coordinator.requestPump();
    await waitForRun(RUN_ID);
    expect(itemOf().state).toBe('landed');
    expect(askOf(itemOf().id)).toBeNull();
  });

  it('asks again for a further change after the one left out', async () => {
    linear.change('ORC-12', { description: HELD });
    fake.scripts.verifier = (instance) => { linear.change('ORC-12', { description: `${HELD}, and more` }); fail(instance); };
    await startRound([ORC12]);
    await expectHeldWithQuestion();
    const table = new PlanQueueLinearTicketStore(driver);
    table.closeAsk(itemOf().id, (table.get(itemOf().id)!.openAsk as { heldHash: string }).heldHash);
    store.upsertItem({ ...itemOf(), heldAt: null, detail: null, question: null });
    coordinator.requestPump();
    await vi.waitFor(() => expect(askOf(itemOf().id)).toMatchObject({ kind: 'changed', heldText: { description: `${HELD}, and more` } }), { timeout: 30_000, interval: 25 });
  });
});

describe('a ticket blocked by another ticket in the same run', { timeout: 60_000 }, () => {
  const blocked: TestTicket = { ...ORC12, text: ticketText('Needs the footer first.', { relatedTickets: [{ relation: 'blocked-by', identifier: 'ORC-13', title: null }] }) };

  it('waits, and starts after its blocker lands', async () => {
    linear = new FakeLinearTickets([blocked, ORC13]);
    await startRound([blocked, ORC13]);
    await waitForRun(RUN_ID);

    expect(store.listItems(RUN_ID).map((item) => item.state)).toEqual(['landed', 'landed']);
    const subjects = git(['log', '--format=%s', '-3', 'main']).split('\n');
    // Newest first: the blocked ticket landed last, though it sorts first.
    expect(subjects.slice(0, 2)).toEqual(['Ticket: ORC-12 Make-the-sign-in-button-work', 'Ticket: ORC-13 Fix-the-footer-link']);
  });

  it('is set aside when its blocker was skipped, so the run can finish', async () => {
    linear = new FakeLinearTickets([blocked, ORC13]);
    const { items } = await startRound([blocked, ORC13]);
    store.upsertItem({ ...store.getItem(items[1].id)!, state: 'skipped', detail: 'Skipped by James.' });
    coordinator.requestPump();
    await waitForRun(RUN_ID);

    expect(store.getItem(items[0].id)).toMatchObject({ state: 'parked', parkReason: 'needs-james', detail: 'Blocked by ORC-13, which stopped' });
    expect(workers()).toHaveLength(0);
  });
});

describe('the crash window', { timeout: 60_000 }, () => {
  it('after the question is saved and before the job is held: on restart the question is open, the job is held, and nothing starts', async () => {
    fake.scripts.worker = () => new Promise<void>(() => undefined);
    await startRound([ORC12]);
    await vi.waitFor(() => expect(workers()).toHaveLength(1), { timeout: 15_000 });
    // The app stopped here: the question is in the table, but the running job was never held.
    new PlanQueueLinearTicketStore(driver).openAsk(itemOf().id, { kind: 'changed', heldTitle: ORC12.title,
      heldText: { ...ORC12.text, description: HELD }, heldHash: 'a'.repeat(64), changed: ['description'], openedAt: 5 });
    const reads = linear.reads.length;

    const next = await restart(null, { scripts: { worker: build, verifier: pass } });
    await expectHeldWithQuestion();

    expect(workers(next)).toHaveLength(0);
    expect(askOf(itemOf().id)).toMatchObject({ kind: 'changed', openedAt: 5 });
    // Nothing was read from Linear: the open question refused it.
    expect(linear.reads).toHaveLength(reads);
  });
});

describe('a shutdown after the job is held and before its question is saved', { timeout: 60_000 }, () => {
  it('gets the question back on the next pass, with nothing started and no new read', async () => {
    linear.change('ORC-12', { description: HELD });
    await startRound([ORC12]);
    await expectHeldWithQuestion();
    // The held job as the interrupted save leaves it: held, with the question in the ticket table but not on the item.
    store.upsertItem({ ...itemOf(), question: null });
    expect(itemOf().question ?? null).toBeNull();
    const reads = linear.reads.length;

    const next = await restart(null, { scripts: { worker: build, verifier: pass } });
    await expectHeldWithQuestion();

    expect(itemOf().question).toMatchObject({ question: ASK, jamesOnly: true });
    expect(workers(next)).toHaveLength(0);
    expect(linear.reads).toHaveLength(reads);
  });
});

describe('the held text reaches nothing an agent can read', { timeout: 60_000 }, () => {
  it('is in the ticket table and in no other place', async () => {
    setQuestionsToParent(true);
    linear.change('ORC-12', { comments: [...ORC12.text.comments, comment('c2', 'sam', HELD, '2026-11-02T09:00:00.000Z')] });
    await startRound([ORC12]);
    await expectHeldWithQuestion();
    for (let pass = 0; pass < 3; pass += 1) { coordinator.requestPump(); await new Promise((resolve) => setTimeout(resolve, 20)); }

    // The text is held where only the page reads it.
    expect(JSON.stringify(askOf(itemOf().id))).toContain(HELD);

    const operations = createPlanQueueToolOperations(() => coordinator);
    const parent = fake.created.find((instance) => instance.role === 'parent')!;
    const places: Record<string, unknown> = {
      'the run sent to the page': coordinator.getRunDto(RUN_ID),
      'the item row in the database': driver.prepare('SELECT * FROM plan_queue_items').all(),
      'plan_queue_status': operations.status(parent.id, RUN_ID, false),
      'plan_queue_status with evidence': operations.status(parent.id, RUN_ID, true),
      'the list of runs': operations.status(parent.id, undefined, false),
      'the message to the parent': [fake.inputs.filter((input) => input.instanceId === parent.id), fake.notes],
      'the phone': projectPlanQueueRun(coordinator.getRunDto(RUN_ID)!),
      'the stored events': coordinator.listRunEvents(RUN_ID, 500),
      'every prompt a session was sent': [fake.created.map((instance) => instance.config.initialPrompt), fake.inputs],
      'every log line': logLines,
    };
    for (const [place, value] of Object.entries(places)) expect(JSON.stringify(value), place).not.toContain(HELD);
    // The one sentence is the item's question and detail, and the note the parent got.
    expect(JSON.stringify(places['the run sent to the page'])).toContain(ASK);
    expect(fake.notes.map((note) => note.message)).toContain(ASK);
  });

  it('is not given to the run\'s parent as a question it could answer, even when questions go to the chat', async () => {
    setQuestionsToParent(true);
    linear.change('ORC-12', { description: HELD });
    await startRound([ORC12]);
    await expectHeldWithQuestion();
    const parent = fake.created.find((instance) => instance.role === 'parent')!;
    const toParent = fake.inputs.filter((input) => input.instanceId === parent.id).map((input) => input.message).join('\n');
    expect(toParent).not.toContain('plan_queue_answer');
    expect(toParent).not.toContain('option_id');
  });
});
