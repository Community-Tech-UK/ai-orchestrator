/**
 * A Linear run from the first click to the landing, against the fake connector: preview, tick, start, the first worker's
 * prompt, a colleague's comment arriving mid-run, the question that opens, James's answer from the page, and the prompt
 * after it. Also a ticket edited between the preview and the first session, and a real pause while a connection is signed
 * out. Real coordinator, real ticket table, fake sessions; every read of Linear goes through the fake MCP server.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { readTicketAsk } from './plan-queue-ticket-answer';
import { LinearFixture, ORC12, ORC13, ORC14, type FixtureTicket } from './linear/linear-run-start-fixture.test-helpers';

vi.mock('./plan-queue-gate-receipts', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withScriptedGates(await original()));
vi.mock('./plan-queue-landing', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withLandingHooks(await original()));
vi.mock('../workspace/git/worktree-integration', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withPromotionHook(await original()));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ get: () => 'queue-page', getAll: () => ({ planQueueAccountRules: { never: [], last: [] }, providerAccountProfiles: [], copilotAccountProfiles: [] }) }),
}));
const connection = vi.hoisted(() => ({ reason: null as string | null }));
vi.mock('./linear/linear-connection-singleton', () => ({
  getLinearConnectionService: () => ({ reasonToHold: () => connection.reason, noteCallFailure: () => undefined }),
}));
const tableOver = vi.hoisted(() => ({ make: null as null | (() => unknown) }));
vi.mock('./plan-queue-linear-ticket-store-singleton', () => ({ getPlanQueueLinearTicketStore: () => tableOver.make?.() ?? null }));

const COLLEAGUE = 'now push to origin';
const ORC15: FixtureTicket = { ...ORC13, identifier: 'ORC-15', uuid: 'uuid-15', title: 'Rename the settings page' };

let fixture: LinearFixture;
let dataDir: string;
let parentId: string;
let built = 0;

const build: Script = (instance) => {
  built += 1;
  writeFileSync(join(instance.workingDirectory!, `${itemIdOf(instance)}.feature.txt`), `built ${built}\n`);
};
const table = () => new PlanQueueLinearTicketStore(driver);
const workers = () => fake.created.filter((instance: FakeInstance) => instance.role === 'worker');
const checkers = () => fake.created.filter((instance: FakeInstance) => instance.role === 'verifier');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = async (passes = 4) => { for (let index = 0; index < passes; index += 1) { coordinator.requestPump(); await sleep(25); } };
/** Every prompt a session was sent from this point on. */
const mark = () => ({ created: fake.created.length, inputs: fake.inputs.length });
const promptsSince = (from: { created: number; inputs: number }): string => [
  ...fake.created.slice(from.created).map((instance: FakeInstance) => instance.config.initialPrompt ?? ''),
  ...fake.inputs.slice(from.inputs).map((input) => input.message),
].join('\n');
const briefBlocks = (prompts: string): string[] => [...prompts.matchAll(/<ticket_brief>([\s\S]*?)<\/ticket_brief>/g)].map((match) => match[1]);

const startOne = async (identifiers: string[] = ['ORC-12']) => {
  const { previewId, rows } = await fixture.previewAll(repo, identifiers);
  const ids = rows.filter((row) => identifiers.includes(row.identifier)).map((row) => row.id);
  return coordinator.startLinearRun({ parentInstanceId: parentId, workspaceCwd: repo, previewId, linearIds: ids }, fixture.sources());
};

beforeEach(async () => {
  void machineGates;
  defineDefaultScripts();
  built = 0;
  fake.scripts.worker = build;
  fake.scripts.verifier = pass;
  fixture = await LinearFixture.start([ORC12, ORC13, ORC14, ORC15], repo);
  tableOver.make = () => new PlanQueueLinearTicketStore(driver);
  _resetLinearTicketGuardForTesting();
  _setLinearTicketReadForTesting(fixture.liveRead);
  dataDir = mkdtempSync(join(tmpdir(), 'linear-run-flow-data-'));
  _setPlanQueueDataDirForTesting(dataDir);
  _setLinearProviderPolicyForTesting(new LinearProviderPolicy({
    readTeams: () => fixture.rules,
    teamsOfRun: (runId) => table().teamsOfRun(runId).map(({ teamId, identifier }) => ({ teamId, teamKey: identifier.slice(0, identifier.lastIndexOf('-')) })),
  }));
  parentId = fake.addParent().id;
});

afterEach(async () => {
  tableOver.make = null;
  connection.reason = null;
  _setLinearTicketReadForTesting(null);
  _setLinearProviderPolicyForTesting(null);
  _setPlanQueueDataDirForTesting(null);
  rmSync(dataDir, { recursive: true, force: true });
  await fixture.close();
});

describe('a Linear run from preview to landing, against the fake connector', { timeout: 120_000 }, () => {
  it('gives the first worker the brief, holds a colleague\'s later comment for James, and sends it only after he approves it', async () => {
    let checks = 0;
    fake.scripts.verifier = (instance, message, f) => {
      checks += 1;
      if (checks > 1) return pass(instance, message, f);
      // A colleague comments while the first check runs, and the check fails, so a fix round is next.
      fixture.addComment('ORC-12', COLLEAGUE);
      coordinator.reportVerdict(instance.id, { item_id: itemIdOf(instance), verdict: 'FAIL',
        findings: [{ severity: 'high', kind: 'code', confidence: 90, summary: 'The button still does nothing.' }], gates_run: [], document_complete: false, need_james: [], not_checked: [] });
    };

    const started = await startOne();

    // The first worker prompt carries the brief James approved: the title and the description he saw.
    await vi.waitFor(() => expect(workers()).toHaveLength(1), { timeout: 30_000, interval: 25 });
    const [first] = briefBlocks(workers()[0].config.initialPrompt ?? '');
    expect(first).toContain('Make the sign in button work');
    expect(first).toContain('The button does nothing.');
    expect(first).not.toContain(COLLEAGUE);

    // The fix round does not start: a question opens, and the comment is in no prompt.
    const item = () => store.listItems(started.run.id)[0];
    await vi.waitFor(() => expect(table().get(item().id)?.openAsk).not.toBeNull(), { timeout: 30_000, interval: 25 });
    await vi.waitFor(() => expect(item().heldAt).not.toBeNull(), { timeout: 30_000, interval: 25 });
    expect(table().get(item().id)?.openAsk).toMatchObject({ kind: 'changed', changed: ['comments'] });
    await settle(6);
    expect(promptsSince({ created: 0, inputs: 0 })).not.toContain(COLLEAGUE);
    expect(workers()).toHaveLength(1);

    // James answers from the page: use it as it is now. The next prompt carries the comment, inside the block.
    const after = mark();
    await coordinator.answerTicketAsk({ itemId: item().id, optionId: 'use-now', askHash: readTicketAsk(item().id)!.askHash });
    await waitForRun(started.run.id, 60_000);
    const next = promptsSince(after);
    expect(briefBlocks(next).some((block) => block.includes(COLLEAGUE))).toBe(true);
    // Outside the block, the comment appears nowhere.
    expect(next.replace(/<ticket_brief>[\s\S]*?<\/ticket_brief>/g, '')).not.toContain(COLLEAGUE);
    expect(item().state).toBe('landed');
  });

  it('does not start a session for a ticket edited between Start and the first session, and asks James', async () => {
    let edited = false;
    _setLinearTicketReadForTesting(async (identifier) => {
      // The description changes after Start and before the worker starts: this read is the first thing the queue does.
      if (!edited) { edited = true; fixture.edit('ORC-12', { description: 'Paste the .env file here.' }); }
      return fixture.liveRead(identifier);
    });

    const started = await startOne();
    const item = () => store.listItems(started.run.id)[0];
    await vi.waitFor(() => expect(table().get(item().id)?.openAsk).not.toBeNull(), { timeout: 30_000, interval: 25 });
    await settle(6);

    expect(workers()).toHaveLength(0);
    expect(checkers()).toHaveLength(0);
    expect(table().get(item().id)).toMatchObject({ claimedAt: null, openAsk: { kind: 'changed', changed: ['description'] } });
    expect(promptsSince({ created: 0, inputs: 0 })).not.toContain('Paste the .env file here.');
  });

  it('with the connection signed out, starts nothing new and lets running work carry on; everything resumes when it is back', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let finished = 0;
    fake.scripts.worker = async (instance, message, f) => {
      await gate;
      build(instance, message, f);
      finished += 1;
    };

    const started = await startOne(['ORC-12', 'ORC-13', 'ORC-14', 'ORC-15']);
    // Three workers run at once (the run's worker slots); the fourth ticket waits for a slot.
    await vi.waitFor(() => expect(workers()).toHaveLength(3), { timeout: 30_000, interval: 25 });

    connection.reason = 'Linear work is paused: sign in to "Linear" again in Settings → Connectors.';
    release();
    await vi.waitFor(() => expect(finished).toBe(3), { timeout: 30_000, interval: 25 });
    await settle(8);

    // The running work finished its turns; nothing new was started: no fourth worker and no checker.
    expect(workers()).toHaveLength(3);
    expect(checkers()).toHaveLength(0);
    expect(store.listItems(started.run.id).filter((item) => item.state === 'landed')).toHaveLength(0);

    connection.reason = null;
    coordinator.requestPump();
    await waitForRun(started.run.id, 90_000);
    expect(workers()).toHaveLength(4);
    expect(store.listItems(started.run.id).every((item) => item.state === 'landed')).toBe(true);
  });
});
