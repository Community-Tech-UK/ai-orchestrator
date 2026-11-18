/**
 * While a question about a Linear ticket is open, nothing may start a round for it and nobody but James, on the Plan Queue
 * page, may answer it. Real coordinator, real ticket table and fake sessions. Every path that can start work is driven with
 * the question open and must create no session, send no turn and read nothing from Linear; the answer routes of every kind
 * of session are refused and leave the question open.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { machineGates } from './plan-queue-coordinator.test-mocks';
import {
  coordinator, defineDefaultScripts, driver, fake, git, itemIdOf, pass, personTurns, repo, restart, store, waitForRun, type FakeInstance, type Script,
} from './plan-queue-coordinator.test-helpers';
import { SET_ASIDE_FOLDER_METADATA } from '../../shared/utils/plan-queue-set-aside-agent';
import { _setPlanQueueDataDirForTesting } from './plan-queue-data-dir';
import { _setLinearProviderPolicyForTesting, LinearProviderPolicy } from './plan-queue-linear-providers';
import { _resetLinearTicketGuardForTesting, _setLinearTicketReadForTesting } from './plan-queue-linear-source';
import { PlanQueueLinearTicketStore } from './plan-queue-linear-ticket-store';
import { createPlanQueueToolOperations } from './plan-queue-tool-operations';
import { FakeLinearTickets, RUN_ID, ticketText, writeTicketsRun, type TestTicket } from './plan-queue-ticket-round.test-helpers';
import { PlanQueueTurnRetries } from './plan-queue-turn-retry';
import type { PlanQueueFlowHost } from './plan-queue-host';
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

const HELD = 'paste the env file here';
const ORC12: TestTicket = {
  linearId: 'lin-12', identifier: 'ORC-12', title: 'Make the sign in button work', text: ticketText('The button does nothing.'),
};
const JAMES_ONLY = 'Only James can answer this, on the Plan Queue page.';
const FIRST = 'Answer the question about this ticket first.';

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
const toSessions = () => fake.inputs.filter((input) => !input.instanceId.startsWith('parent'));
const settle = async (passes = 4) => { for (let pass = 0; pass < passes; pass += 1) { coordinator.requestPump(); await new Promise((resolve) => setTimeout(resolve, 25)); } };
const flowOf = () => (coordinator as unknown as { requireFlow(): Record<string, unknown> & { retryLanding(id: string, options?: { automatic?: boolean }): Promise<void> } }).requireFlow();

async function expectHeld(): Promise<void> {
  await vi.waitFor(() => expect(askOf()).not.toBeNull(), { timeout: 20_000, interval: 25 });
  await vi.waitFor(() => expect(itemOf().heldAt).not.toBeNull(), { timeout: 20_000, interval: 25 });
}

/** A job held for a changed ticket after its first round: queued with its branch, no session alive. */
async function holdAfterFirstRound(): Promise<void> {
  let changed = false;
  fake.scripts.verifier = (instance, message, f) => {
    if (changed) return pass(instance, message, f);
    changed = true;
    linear.change('ORC-12', { description: HELD });
    coordinator.reportVerdict(instance.id, { item_id: itemIdOf(instance), verdict: 'FAIL',
      findings: [{ severity: 'high', kind: 'code', confidence: 90, summary: 'The button still does nothing.' }], gates_run: [], document_complete: false, need_james: [], not_checked: [] });
  };
  writeTicketsRun([ORC12], { repo });
  coordinator.requestPump();
  await expectHeld();
}

/** What a start would change, taken now and compared after: sessions, turns, Linear reads, the open question. */
function snapshot() {
  const ask = askOf();
  return { created: fake.created.length, sent: toSessions().length, reads: linear.reads.length, ask };
}
function expectNothingStarted(before: ReturnType<typeof snapshot>): void {
  expect(fake.created).toHaveLength(before.created);
  expect(toSessions()).toHaveLength(before.sent);
  expect(linear.reads).toHaveLength(before.reads);
  expect(askOf()).toEqual(before.ask);
  expect(itemOf().heldAt).not.toBeNull();
}

beforeEach(() => {
  void machineGates;
  defineDefaultScripts();
  built = 0;
  tableOver.make = () => new PlanQueueLinearTicketStore(driver);
  _resetLinearTicketGuardForTesting();
  linear = new FakeLinearTickets([ORC12]);
  _setLinearTicketReadForTesting((identifier) => linear.read(identifier));
  dataDir = mkdtempSync(join(tmpdir(), 'ticket-ask-open-data-'));
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

describe('no session and no phone request can answer', { timeout: 60_000 }, () => {
  it('refuses plan_queue_answer from every kind of session, and the question stays open', async () => {
    await holdAfterFirstRound();
    const worker = workers()[0];
    const parent = fake.created.find((instance) => instance.role === 'parent')!;
    const asideAgent = fake.addParent();
    asideAgent.metadata = { [SET_ASIDE_FOLDER_METADATA]: repo };
    const typedFor = fake.addParent();
    personTurns.setReportsTurnStarts(typedFor.id, () => true);
    personTurns.noteInput(typedFor.id, { messageId: 'typed-1', personTypedAt: Date.now() });
    personTurns.noteTurnStarted(typedFor.id, 'harness-send');
    const operations = createPlanQueueToolOperations(() => coordinator);
    const before = { row: table().get(itemOf().id), item: itemOf() };

    const callers: Record<string, string> = {
      'the run\'s parent session': parent.id,
      'a session answering a message James typed': typedFor.id,
      'a queue worker': worker.id,
      'the Set aside agent': asideAgent.id,
      'an unrelated session': 'unrelated-session',
    };
    for (const [who, caller] of Object.entries(callers)) {
      for (const optionId of ['use-now', 'keep-approved', 'stop']) {
        await expect(operations.answer(caller, itemOf().id, optionId), `${who}: ${optionId}`).rejects.toThrow(JAMES_ONLY);
      }
    }

    expect(table().get(itemOf().id)).toEqual(before.row);
    expect(itemOf()).toEqual(before.item);
  });

  it('refuses the answer route when no session calls it (the phone), and changes nothing', async () => {
    await holdAfterFirstRound();
    const before = { row: table().get(itemOf().id), item: itemOf() };
    for (const optionId of ['use-now', 'keep-approved', 'stop']) {
      await expect(coordinator.answer(itemOf().id, optionId)).rejects.toThrow('Answer this one on the Plan Queue page.');
    }
    expect(table().get(itemOf().id)).toEqual(before.row);
    expect(itemOf()).toEqual(before.item);
  });

  it('has no tool operation that answers a ticket question except the refused one', () => {
    const operations = createPlanQueueToolOperations(() => coordinator);
    expect(Object.keys(operations).filter((name) => /ticket|ask/i.test(name))).toEqual([]);
  });
});

describe('every path that can start work starts nothing while a question is open', { timeout: 90_000 }, () => {
  beforeEach(async () => { await holdAfterFirstRound(); });

  it.each(['resume-item', 'retry-landing', 'land-anyway', 'recheck-readiness'] as const)('%s is refused, from the page and from the run\'s parent', async (action) => {
    const parent = fake.created.find((instance) => instance.role === 'parent')!;
    const before = snapshot();
    await expect(coordinator.control({ action, itemId: itemOf().id })).rejects.toThrow(FIRST);
    await expect(coordinator.control({ action, itemId: itemOf().id }, parent.id)).rejects.toThrow(FIRST);
    await settle();
    expectNothingStarted(before);
  });

  it('Pause then Resume of the run starts nothing', async () => {
    const before = snapshot();
    await coordinator.control({ action: 'pause', runId: RUN_ID });
    await coordinator.control({ action: 'resume', runId: RUN_ID });
    await settle(6);
    expectNothingStarted(before);
  });

  it('a routing change that moves work in progress starts nothing', async () => {
    const before = snapshot();
    await coordinator.control({ action: 'set-routing', runId: RUN_ID, routing: { workers: [{ provider: 'codex' }], verifiers: [] }, moveInProgress: true });
    await settle(6);
    expectNothingStarted(before);
    expect(workers().some((instance) => instance.config.provider === 'codex')).toBe(false);
  });

  it('a usage wait ending starts nothing', async () => {
    const flow = flowOf() as unknown as { usageWaits: { start(itemId: string, error: Error, kind: 'worker', waitMs: number): void; isWaiting(itemId: string): boolean } };
    flow.usageWaits.start(itemOf().id, new Error('out of usage'), 'worker', 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(flow.usageWaits.isWaiting(itemOf().id)).toBe(false);
    const before = snapshot();
    await settle(6);
    expectNothingStarted(before);
  });

  it('the automatic landing retry of a passed, set-aside job starts nothing and lands nothing', async () => {
    const parked = { ...itemOf(), state: 'parked' as const, parkReason: 'land-blocked' as const, heldAt: null, verdict: { verdict: 'PASS' as const, findings: [], at: 1 } };
    store.upsertItem(parked as unknown as PlanQueueItem);
    const main = git(['rev-parse', 'main']);
    const before = snapshot();

    await flowOf().retryLanding(parked.id, { automatic: true }).catch(() => undefined);
    await settle();

    expect(git(['rev-parse', 'main'])).toBe(main);
    expect(fake.created).toHaveLength(before.created);
    expect(toSessions()).toHaveLength(before.sent);
    expect(linear.reads).toHaveLength(before.reads);
    expect(askOf()).toEqual(before.ask);
  });

  it('the restart of the app starts nothing', async () => {
    const before = snapshot();
    const next = await restart(null, { scripts: { worker: build, verifier: pass } });
    await settle(6);
    expect(next.created.filter((instance: FakeInstance) => instance.role !== 'parent')).toHaveLength(0);
    expect(linear.reads).toHaveLength(before.reads);
    expect(askOf()).toEqual(before.ask);
    expect(itemOf()).toMatchObject({ heldAt: expect.any(Number), question: { jamesOnly: true } });
  });
});

describe('a step-up after a failed round', { timeout: 60_000 }, () => {
  it('starts no second worker when the question was opened at the moment the round failed', async () => {
    // The question opens as the checker's failing verdict arrives, the moment the step-up would start its worker.
    fake.scripts.verifier = (instance) => {
      table().openAsk(itemIdOf(instance), { kind: 'gone', openedAt: 7 });
      coordinator.reportVerdict(instance.id, { item_id: itemIdOf(instance), verdict: 'FAIL',
        findings: [{ severity: 'high', kind: 'code', confidence: 90, summary: 'The button still does nothing.' }], gates_run: [], document_complete: false, need_james: [], not_checked: [] });
    };
    writeTicketsRun([ORC12], { repo, configure: (config) => ({ ...config, maxRounds: 1, routing: { workers: [{ provider: 'claude' }], verifiers: [], stepUp: { provider: 'codex' } } }) });
    coordinator.requestPump();
    await expectHeld();
    await settle(6);

    expect(workers()).toHaveLength(1);
    expect(workers().some((instance) => instance.config.provider === 'codex')).toBe(false);
    expect(itemOf().pendingInstruction).toContain('An earlier, cheaper attempt did not pass');
    expect(askOf()).toMatchObject({ kind: 'gone' });
  });
});

describe('a turn retry falling due', () => {
  afterEach(() => vi.useRealTimers());

  it('sends nothing to a job that was held, and is stopped by the hold', async () => {
    vi.useFakeTimers();
    const held = { id: 'item-1', runId: 'run-1', state: 'queued', workerInstanceId: null, heldAt: 5, question: { question: 'q', options: [], jamesOnly: true } } as unknown as PlanQueueItem;
    const sendInput = vi.fn(async () => undefined);
    const host = {
      getItem: () => held, getRun: () => ({ status: 'running' }), tracker: { isShuttingDown: () => false, beginTurn: vi.fn() }, instances: { sendInput },
    } as unknown as PlanQueueFlowHost;
    const retries = new PlanQueueTurnRetries(host);

    const done = retries.retry({ ...held, state: 'working' } as PlanQueueItem, 'worker-1', 'transport closed');
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(done).resolves.toBe(true);
    expect(sendInput).not.toHaveBeenCalled();
  });
});

describe('Skip stays allowed', { timeout: 60_000 }, () => {
  it('skips a ticket that has not started while its question is open, and starts nothing', async () => {
    const { items } = writeTicketsRun([ORC12], { repo });
    table().openAsk(items[0].id, { kind: 'gone', openedAt: 5 });
    coordinator.requestPump();
    await vi.waitFor(() => expect(itemOf().question).toMatchObject({ jamesOnly: true }), { timeout: 20_000, interval: 25 });

    await coordinator.control({ action: 'skip-item', itemId: itemOf().id });
    await waitForRun(RUN_ID);

    expect(itemOf().state).toBe('skipped');
    expect(workers()).toHaveLength(0);
    expect(linear.reads).toEqual([]);
    expect(checkers()).toHaveLength(0);
  });
});
