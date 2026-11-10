import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { WorktreeCapacityError, WorktreeManager } from '../workspace/git/worktree-manager';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import { machineGates } from './plan-queue-coordinator.test-mocks';
import {
  repo,
  store,
  fake,
  coordinator,
  verifierInputs,
  git,
  defineDefaultScripts,
  writeDoc,
  planDoc,
  implement,
  itemIdOf,
  pass,
  triageAllReady,
  waitForRun,
  startCoordinator,
  never,
  restart,
  poolAccount,
  setCoordinator,
  setSavedRouting,
  setOutOfUsage,
  setInstalledProviders,
  setPoolProfiles,
  setExcludedProviders,
  type Script,
  type FakeInstance,
} from './plan-queue-coordinator.test-helpers';

// The stand-ins every coordinator spec installs, and the shared fixture: see the two modules imported below.
vi.mock('./plan-queue-gate-receipts', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withScriptedGates(await original()));
vi.mock('./plan-queue-landing', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withLandingHooks(await original()));
vi.mock('../workspace/git/worktree-integration', async (original) =>
  (await import('./plan-queue-coordinator.test-mocks')).withPromotionHook(await original()));

describe('PlanQueueCoordinator — providers and accounts', { timeout: 30_000 }, () => {
  it('gives workers the starting session\'s account and routes every queue session as automatic work', async () => {
    planDoc('2026-01-01-alpha');
    setPoolProfiles([poolAccount('max-a', 'claude'), poolAccount('max-b', 'claude')]);
    const parent = fake.addParent();
    parent.accountProfileId = 'max-b';

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    expect(run.config.routing).toEqual({
      workers: [{ provider: 'claude', model: 'claude-sonnet-5', accountProfileIds: ['max-b'] }],
      verifiers: [],
    });
    await waitForRun(run.id);

    const triage = fake.created.find((i) => i.role === 'triage')!;
    expect(triage.config).toMatchObject({ provider: 'claude', accountRouteOrigin: 'automation', allowedAccountProfileIds: ['max-b'] });
    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(worker.config).toMatchObject({ provider: 'claude', accountRouteOrigin: 'automation', allowedAccountProfileIds: ['max-b'] });
    const verifier = fake.created.find((i) => i.role === 'verifier')!;
    expect(verifier.config.accountRouteOrigin).toBe('verification');
    expect(verifier.config.allowedAccountProfileIds).toBeUndefined();
  });

  it('does not inherit an account James kept for manual use', async () => {
    planDoc('2026-01-01-alpha');
    setPoolProfiles([poolAccount('max-a', 'claude', { automationPolicy: 'manual-only' })]);
    const parent = fake.addParent();
    parent.accountProfileId = 'max-a';

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    expect(run.config.routing?.workers).toEqual([{ provider: 'claude', model: 'claude-sonnet-5' }]);
    await waitForRun(run.id);
    expect(fake.created.find((i) => i.role === 'worker')!.config.allowedAccountProfileIds).toBeUndefined();
  });

  it('uses the saved choice over the starting session, and passes the saved checkers to verifier selection', async () => {
    planDoc('2026-01-01-alpha');
    setPoolProfiles([poolAccount('pro-1', 'codex'), poolAccount('pro-2', 'codex')]);
    setSavedRouting({
      workers: [{ provider: 'codex', model: 'gpt-6.1-sol', accountProfileIds: ['pro-2'] }],
      verifiers: [{ provider: 'claude' }],
    });
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    expect(run.workerProvider).toBe('codex');
    expect(run.config.routing?.checkersChosenBy).toBe('saved');
    await waitForRun(run.id);

    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(worker.config).toMatchObject({ provider: 'codex', modelOverride: 'gpt-6.1-sol', allowedAccountProfileIds: ['pro-2'] });
    expect(verifierInputs[0]).toMatchObject({ choices: [{ provider: 'claude' }], choicesOverrideLicence: true });
  });

  it('keeps James\'s saved lists over a run\'s own choices, and says which were set aside', async () => {
    planDoc('2026-01-01-alpha');
    setSavedRouting({ workers: [{ provider: 'codex' }], verifiers: [{ provider: 'claude' }] });
    const parent = fake.addParent();

    const { run, routingSetAside } = await coordinator.startRun({
      parentInstanceId: parent.id,
      kind: 'plans',
      routing: { workers: [{ provider: 'cursor' }], verifiers: [] },
    });
    expect(run.config.routing).toEqual({ workers: [{ provider: 'codex' }], verifiers: [{ provider: 'claude' }], checkersChosenBy: 'saved' });
    expect(routingSetAside).toEqual(['workers', 'checkers']);
    await waitForRun(run.id);
    expect(fake.created.find((i) => i.role === 'worker')!.config.provider).toBe('codex');
    expect(verifierInputs[0]?.choices).toEqual([{ provider: 'claude' }]);
  });

  it('records a worker\'s provider only once it is known, never the "auto" it starts with', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = (instance, message, f) => {
      instance.provider = 'auto';
      return implement(instance, message, f);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);
    expect(store.listItems(run.id)[0]).not.toHaveProperty('workerProvider');
  });

  it('refuses to start a run whose list names a CLI that is not installed, rather than running another provider', async () => {
    planDoc('2026-01-01-alpha');
    setInstalledProviders(['claude']);
    setSavedRouting({ workers: [{ provider: 'claude' }, { provider: 'codex' }], verifiers: [] });
    const parent = fake.addParent();

    await expect(coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' }))
      .rejects.toThrow('Plan Queue: codex is not installed. Install its CLI or choose another provider.');
    expect(coordinator.listRunDtos()).toEqual([]);
  });

  it('uses a run\'s own choices where James saved none', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();

    const { run, routingSetAside } = await coordinator.startRun({
      parentInstanceId: parent.id,
      kind: 'plans',
      routing: { workers: [{ provider: 'cursor' }], verifiers: [{ provider: 'claude' }] },
    });
    expect(run.config.routing).toEqual({ workers: [{ provider: 'cursor' }], verifiers: [{ provider: 'claude' }], checkersChosenBy: 'run' });
    expect(routingSetAside).toEqual([]);
    await waitForRun(run.id);
    expect(fake.created.find((i) => i.role === 'worker')!.config.provider).toBe('cursor');
  });

  it('starts new sessions on the first worker choice with usage left, and records what each worker ran on', async () => {
    planDoc('2026-01-01-alpha');
    setSavedRouting({ workers: [{ provider: 'claude', model: 'claude-opus-5' }, { provider: 'codex', model: 'gpt-6.1-sol' }], verifiers: [] });
    setOutOfUsage(['claude']);
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    expect(fake.created.find((i) => i.role === 'triage')!.config).toMatchObject({ provider: 'codex', modelOverride: 'gpt-6.1-sol' });
    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(worker.config).toMatchObject({ provider: 'codex', modelOverride: 'gpt-6.1-sol' });
    // The checker is chosen against the worker that actually ran, not the run's first choice.
    expect(verifierInputs.at(-1)).toMatchObject({ workerProvider: 'codex', workerModel: 'gpt-6.1-sol' });
    expect(store.listItems(run.id)[0]).toMatchObject({ workerProvider: 'codex', workerModel: 'gpt-6.1-sol' });
  });

  it('never starts a worker on a provider with no usage left: the document waits, then runs once usage is back', async () => {
    planDoc('2026-01-01-alpha');
    setSavedRouting({ workers: [{ provider: 'claude', model: 'claude-opus-5' }], verifiers: [] });
    const parent = fake.addParent();
    // Triage runs; then Claude reaches its limit before the worker starts.
    fake.scripts.triage = (instance, message, f) => {
      setOutOfUsage(['claude']);
      return triageAllReady(instance, message, f);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await vi.waitFor(() => expect(store.listItems(run.id)[0]).toMatchObject({
      state: 'queued', detail: expect.stringContaining('Waiting for usage: claude (claude-opus-5) has no usage left'),
    }), { timeout: 15_000, interval: 25 });
    coordinator.requestPump();
    await coordinator._whenSettledForTesting();
    expect(fake.created.some((i) => i.role === 'worker')).toBe(false);
    expect(store.listItems(run.id)[0]).toMatchObject({ state: 'queued', parkReason: null, round: 0 });

    setOutOfUsage([]);
    const realNow = Date.now.bind(Date);
    const later = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6 * 60_000);
    try {
      coordinator.requestPump();
      await waitForRun(run.id);
    } finally {
      later.mockRestore();
    }
    expect(store.listItems(run.id)[0].state).toBe('landed');
    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(worker.config).toMatchObject({ provider: 'claude', modelOverride: 'claude-opus-5' });
    expect(worker.config.initialPrompt).toContain('it waited for usage to come back on its provider');
  });

  it('never starts a checker on a provider with no usage left: the check waits without counting a round', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = (instance, message, f) => {
      setOutOfUsage(['codex']);
      return implement(instance, message, f);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await vi.waitFor(() => expect(store.listItems(run.id)[0]).toMatchObject({
      state: 'awaiting-slot', detail: expect.stringContaining('Waiting for usage: codex has no usage left'),
    }), { timeout: 15_000, interval: 25 });
    coordinator.requestPump();
    await coordinator._whenSettledForTesting();
    expect(fake.created.some((i) => i.role === 'verifier')).toBe(false);
    expect(store.listItems(run.id)[0]).toMatchObject({ state: 'awaiting-slot', erroredRounds: 0, round: 0 });

    setOutOfUsage([]);
    const realNow = Date.now.bind(Date);
    const later = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6 * 60_000);
    try {
      coordinator.requestPump();
      await waitForRun(run.id);
    } finally {
      later.mockRestore();
    }
    expect(store.listItems(run.id)[0].state).toBe('landed');
  });

  it('refuses a run on a never-auto-pick provider unless the run relaxes that list', async () => {
    planDoc('2026-01-01-alpha');
    setExcludedProviders(['claude']);
    const parent = fake.addParent();

    await expect(coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' }))
      .rejects.toThrow('Plan Queue worker: claude is on the "never auto-pick these providers" list');
    expect(coordinator.listRunDtos()).toEqual([]);

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { relaxSettings: true } });
    expect(run.config.routing?.workers[0]?.provider).toBe('claude');
    await waitForRun(run.id);
  });

  it('parks a worker, with the reason, when its provider joins the never-auto-pick list mid-run', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.triage = (instance, message, f) => {
      setExcludedProviders(['claude']);
      return triageAllReady(instance, message, f);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    expect(fake.created.some((i) => i.role === 'worker')).toBe(false);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({
      state: 'parked',
      parkReason: 'worker-error',
      detail: expect.stringContaining('claude has been added to the "never auto-pick these providers" list since this run started'),
    });
  });

  it('holds the run with the real reason, and sets no document aside, when triage cannot start', async () => {
    planDoc('2026-01-01-alpha');
    // Hold every spawn until the exclusion is in place, so the order is deterministic.
    let openTools!: () => void;
    const listening = new Promise<void>((resolve) => { openTools = resolve; });
    let clock = 1_000_000;
    PlanQueueCoordinator._resetForTesting();
    setCoordinator(startCoordinator(fake, null, { whenOrchestratorToolsListening: () => listening, now: () => clock }));
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    setExcludedProviders(['claude']);
    openTools();
    // Refused starts wait 1, then 5 minutes; the third matching one holds the run.
    await vi.waitFor(() => {
      clock += 60_000;
      coordinator.requestPump();
      expect(coordinator.getRunDto(run.id)!.holdReason).toContain('claude has been added to the "never auto-pick these providers" list');
    }, { timeout: 15_000, interval: 30 });

    expect(fake.created.some((i) => i.role === 'triage')).toBe(false);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'discovered', parkReason: null });
  });

  it('refuses to start a run whose saved choice names an account the queue may not use', async () => {
    planDoc('2026-01-01-alpha');
    setPoolProfiles([poolAccount('max-a', 'claude', { enabled: false })]);
    setSavedRouting({ workers: [{ provider: 'claude', accountProfileIds: ['max-a'] }], verifiers: [] });
    const parent = fake.addParent();

    await expect(coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' }))
      .rejects.toThrow('the claude account "MAX-A" is turned off');
    expect(coordinator.listRunDtos()).toEqual([]);
  });
});


describe('PlanQueueCoordinator — a step job of a big plan', { timeout: 60_000 }, () => {
  it('accepts a step PASS with document_complete false and lands it without closing the plan', async () => {
    const filler = Array.from({ length: 21 }, (_, n) => `- [ ] filler ${n}`).join('\n');
    writeDoc('docs/plans/2026-01-01-big_spec_planned.md', '# Spec\n\n**Plan:** [plan](./2026-01-01-big_plan.md)\n');
    writeDoc('docs/plans/2026-01-01-big_plan.md', `# Big\n\n**Spec:** [spec](./2026-01-01-big_spec_planned.md)\n\n## Step 1. One\n\n${filler}\n\n## Step 2. Two\n\n- [ ] two\n`);
    const parent = fake.addParent();
    const stepPass: Script = (instance) => {
      coordinator.reportVerdict(instance.id, {
        item_id: itemIdOf(instance), verdict: 'PASS', findings: [], gates_run: [], document_complete: false, need_james: [], not_checked: [],
      });
    };
    fake.scripts.verifier = stepPass;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);
    const items = coordinator.getRunDto(run.id)!.items;
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.state)).toEqual(['landed', 'landed']);
    expect(items.every((item) => item.verdict?.documentComplete === false)).toBe(true);
    expect(existsSync(join(repo, 'docs/plans/2026-01-01-big_plan.md'))).toBe(true);
    expect(existsSync(join(repo, 'docs/plans/2026-01-01-big_plan_completed.md'))).toBe(false);
  });
});


describe('PlanQueueCoordinator — handing a stuck document to the step-up worker', { timeout: 30_000 }, () => {
  const haiku = { provider: 'claude', model: 'haiku' };
  const opus = { provider: 'claude', model: 'opus' };
  const fail: Script = (instance) => {
    coordinator.reportVerdict(instance.id, {
      item_id: itemIdOf(instance), verdict: 'FAIL',
      findings: [{ severity: 'high', confidence: 80, summary: 'Retry never resets.' }], gates_run: [], document_complete: false, need_james: [], not_checked: [],
    });
  };
  /** FAIL the first `failures` checks, then PASS. */
  const failThenPass = (failures: number): Script => {
    let checks = 0;
    return (instance, message, f) => { checks += 1; return checks <= failures ? fail(instance, message, f) : pass(instance, message, f); };
  };
  const workers = (instances = fake) => instances.created.filter((i) => i.role === 'worker');
  const steppedUp = (instance: FakeInstance) => instance.config.metadata?.['planQueueSteppedUp'] === true;
  const parentNotes = (parent: FakeInstance) => fake.notes.filter((m) => m.instanceId === parent.id).map((m) => m.message);

  beforeEach(() => {
    setSavedRouting({ workers: [haiku], verifiers: [], stepUp: opus });
  });

  it('hands a document that failed every round to the step-up worker once, which then lands it', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = failThenPass(1);

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await waitForRun(run.id);

    const [first, second] = workers();
    expect(workers()).toHaveLength(2);
    expect(first.config).toMatchObject({ provider: 'claude', modelOverride: 'haiku' });
    expect(steppedUp(first)).toBe(false);
    expect(second.config).toMatchObject({ provider: 'claude', modelOverride: 'opus' });
    expect(steppedUp(second)).toBe(true);
    // The cheap worker was stopped before the step-up worker started; its work stayed on the branch.
    expect(fake.live.has(first.id)).toBe(false);
    expect(second.config.initialPrompt).toContain('An earlier, cheaper attempt did not pass after 1 verification round(s).');
    expect(second.config.initialPrompt).toContain('Retry never resets.');
    // Its checker was chosen against what the step-up worker ran on.
    expect(verifierInputs.map((input) => [input.workerProvider, input.workerModel])).toEqual([['claude', 'haiku'], ['claude', 'haiku'], ['claude', 'opus']]);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'landed', round: 1, erroredRounds: 0 });
    expect(item.steppedUpAt).toEqual(expect.any(Number));
    expect(git(['show', 'main:2026-01-01-alpha_plan.feature.txt'])).toBe('built 2026-01-01-alpha_plan');
    expect(parentNotes(parent).filter((m) => m.includes('handed to the stronger worker'))).toEqual([
      expect.stringContaining('2026-01-01-alpha_plan.md failed its checks in all 1 verification round(s), so it was handed to the stronger worker James chose (claude / opus).'),
    ]);
    expect(fake.inputs.filter((m) => m.instanceId === parent.id && m.message.includes('handed to the stronger worker'))).toEqual([]);
  });

  it('parks a document the step-up worker could not pass either, never handing it over twice, and Resume keeps the step-up worker', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = fail;

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 2 } });
    await waitForRun(run.id);

    const parked = coordinator.getRunDto(run.id)!.items[0];
    expect(parked).toMatchObject({ state: 'parked', parkReason: 'round-limit', round: 2 });
    expect(parked.detail).toMatch(/^Still failing after the step-up worker's 2 verification round\(s\): \[high, confidence 80\] Retry never resets\./);
    expect(workers().map(steppedUp)).toEqual([false, true]);
    expect(parentNotes(parent).filter((m) => m.includes('handed to the stronger worker'))).toHaveLength(1);

    // James resumes it: the next worker is the step-up worker again.
    fake.scripts.verifier = pass;
    await coordinator.control({ action: 'resume-item', itemId: parked.id });
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed', steppedUpAt: parked.steppedUpAt });
    expect(workers()).toHaveLength(3);
    expect(workers()[2].config).toMatchObject({ provider: 'claude', modelOverride: 'opus' });
    expect(steppedUp(workers()[2])).toBe(true);
    expect(parentNotes(parent).filter((m) => m.includes('handed to the stronger worker'))).toHaveLength(1);
    expect(fake.inputs.filter((m) => m.instanceId === parent.id && m.message.includes('handed to the stronger worker'))).toEqual([]);
  });

  it('parks as before when the run has no step-up choice', async () => {
    setSavedRouting({ workers: [haiku], verifiers: [] });
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = fail;

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'round-limit', steppedUpAt: null });
    expect(item.detail).toMatch(/^Still failing after 1 verification round\(s\)/);
    expect(workers()).toHaveLength(1);
  });

  /** FAIL every check with exactly these findings (step 5.4). */
  const failWith = (findings: Parameters<typeof coordinator.reportVerdict>[1]['findings']): Script => (instance) => {
    coordinator.reportVerdict(instance.id, {
      item_id: itemIdOf(instance), verdict: 'FAIL', findings, gates_run: [], document_complete: false, need_james: [], not_checked: [],
    });
  };

  it('does not hand over a document whose last verdict lists no findings: it parks at the round limit (step 5.4)', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = failWith([]);

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'round-limit', steppedUpAt: null });
    expect(item.detail).toContain('no findings listed');
    expect(workers()).toHaveLength(1);
    expect(workers().some(steppedUp)).toBe(false);
    expect(parentNotes(parent).filter((m) => m.includes('handed to the stronger worker'))).toHaveLength(0);
    expect(fake.inputs.filter((m) => m.instanceId === parent.id && m.message.includes('handed to the stronger worker'))).toHaveLength(0);
  });

  it('does not hand over a document whose findings are all environment or needs-human: it parks for setup or James (step 5.4)', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = failWith([
      { severity: 'high', kind: 'environment', confidence: 90, summary: 'No test device.', missing: 'A paired iPhone' },
    ]);

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await waitForRun(run.id);

    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'needs-setup', steppedUpAt: null });
    expect(workers()).toHaveLength(1);
    expect(workers().some(steppedUp)).toBe(false);
  });

  it('hands a document over when a code finding sits among findings of other kinds (step 5.4)', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    let checks = 0;
    fake.scripts.verifier = (instance, message, f) => {
      checks += 1;
      if (checks > 1) { pass(instance, message, f); return; }
      failWith([
        { severity: 'high', kind: 'code', confidence: 90, summary: 'The counter is never reset.' },
        { severity: 'medium', kind: 'environment', confidence: 90, summary: 'The signing gate cannot run.', missing: 'The signing certificate' },
      ])(instance, message, f);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await waitForRun(run.id);

    expect(workers().map(steppedUp)).toEqual([false, true]);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed', steppedUpAt: expect.any(Number) });
  });

  it.each([
    ['verifier-unreliable', { verifier: (() => undefined) as Script }],
    ['worker-error', { worker: ((instance, _message, f) => { f.setStatus(instance, 'error'); }) as Script }],
  ])('never hands over a document parked as %s', async (reason, scripts) => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    Object.assign(fake.scripts, scripts);

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await waitForRun(run.id);

    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: reason, steppedUpAt: null });
    expect(workers().some(steppedUp)).toBe(false);
  });

  it('starts the step-up worker after a restart that came between recording the handover and starting it', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = fail;
    // The step-up worker's session never comes up before the app goes down.
    const create = fake.createInstance.bind(fake);
    fake.createInstance = (config) => (config.metadata?.['planQueueSteppedUp'] === true ? new Promise<never>(() => undefined) : create(config));

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await vi.waitFor(() => {
      const item = store.getItem(run.items[0].id)!;
      if (item.state !== 'fixing' || !item.steppedUpAt) throw new Error(`item is ${item.state}`);
    }, { timeout: 15_000, interval: 25 });
    const recorded = store.getItem(run.items[0].id)!;
    expect(recorded.workerInstanceId).toBeNull();

    const next = await restart(null, { scripts: { verifier: fail } });
    await waitForRun(run.id);

    expect(workers(next)).toHaveLength(1);
    expect(workers(next)[0].config).toMatchObject({ provider: 'claude', modelOverride: 'opus' });
    expect(steppedUp(workers(next)[0])).toBe(true);
    // It failed too, and there was no second handover.
    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'round-limit', steppedUpAt: recorded.steppedUpAt });
    expect(item.detail).toContain('the step-up worker\'s 1 verification round(s)');
  });

  it('holds a document paused while its step-up worker was starting, and Resume carries on with the step-up worker', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = failThenPass(1);
    const create = fake.createInstance.bind(fake);
    let paused = false;
    fake.createInstance = async (config) => {
      if (config.metadata?.['planQueueSteppedUp'] !== true || paused) return create(config);
      paused = true;
      // Pause lands while the new session is still coming up.
      void coordinator.control({ action: 'pause', runId: config.metadata['planQueueRunId'] as string });
      await vi.waitFor(() => { if (store.getRun(config.metadata!['planQueueRunId'] as string)!.status !== 'paused') throw new Error('not paused'); }, { timeout: 15_000, interval: 25 });
      return create(config);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await vi.waitFor(() => {
      const item = store.getItem(run.items[0].id)!;
      if (!item.heldAt || !item.steppedUpAt) throw new Error(`item is ${item.state}`);
    }, { timeout: 15_000, interval: 25 });
    await coordinator._whenSettledForTesting();
    // The session that came up during the pause was not leaked.
    expect(workers().filter((w) => fake.live.has(w.id))).toEqual([]);
    expect(store.getItem(run.items[0].id)!.pendingInstruction).toContain('An earlier, cheaper attempt did not pass');

    await coordinator.control({ action: 'resume', runId: run.id });
    await waitForRun(run.id);

    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed' });
    const resumed = workers().at(-1)!;
    expect(resumed.config).toMatchObject({ provider: 'claude', modelOverride: 'opus' });
    expect(steppedUp(resumed)).toBe(true);
    expect(resumed.config.initialPrompt).toContain('An earlier, cheaper attempt did not pass after 1 verification round(s).');
  });
  it('parks a document whose step-up worker could not start, says so, and Resume tries the step-up worker again', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = failThenPass(1);
    const create = fake.createInstance.bind(fake);
    let refused = false;
    fake.createInstance = async (config) => {
      if (config.metadata?.['planQueueSteppedUp'] === true && !refused) { refused = true; throw new Error('CLI missing'); }
      return create(config);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await waitForRun(run.id);

    const parked = coordinator.getRunDto(run.id)!.items[0];
    expect(parked).toMatchObject({ state: 'parked', parkReason: 'worker-error' });
    expect(parked.steppedUpAt).toEqual(expect.any(Number));
    const handover = parentNotes(parent).filter((m) => m.includes('handed to the stronger worker'));
    expect(handover).toEqual([expect.stringContaining('That worker could not start, so the document is parked; Resume continues with the stronger worker.')]);
    expect(handover[0]).not.toContain('more round(s)');

    await coordinator.control({ action: 'resume-item', itemId: parked.id });
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed', steppedUpAt: parked.steppedUpAt });
    expect(workers().at(-1)!.config).toMatchObject({ provider: 'claude', modelOverride: 'opus' });
    expect(fake.inputs.filter((m) => m.instanceId === parent.id && m.message.includes('handed to the stronger worker'))).toEqual([]);
  });
});


describe('queue spend reductions', { timeout: 30_000 }, () => {
  it('refuses an impossible checker before persisting or spawning any work', async () => {
    planDoc('2026-01-01-no-checker');
    vi.spyOn(coordinator, 'selectVerifier').mockResolvedValue({ ok: false, reason: 'No allowed second model' });
    await expect(coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' })).rejects.toThrow('No allowed second model');
    expect(store.listRuns()).toEqual([]);
    expect(fake.created.filter(instance => instance.role !== 'parent')).toEqual([]);
  });

  it('never spawns a checker or lands work when Harness finds a new red gate', async () => {
    planDoc('2026-01-01-red-checks');
    defineDefaultScripts();
    machineGates.failItem = true;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans',
      config: { maxRounds: 1, verifierGates: DEFAULT_PLAN_QUEUE_CONFIG.plans.verifierGates } });
    await waitForRun(run.id);
    expect(store.listItems(run.id)[0]).toMatchObject({ state: 'parked', parkReason: 'round-limit', verdict: { verdict: 'FAIL' } });
    expect(fake.created.filter(instance => instance.role === 'verifier')).toEqual([]);
    expect(store.history.listVerdicts(run.items[0].id)).toMatchObject([{ verdict: 'FAIL' }]);
    expect(git(['log', '--format=%s', 'main'])).toBe('base');
  });
  it('waits for capacity and starts on a later pump, while real preparation failures still park', async () => {
    planDoc('2026-01-01-capacity');
    fake.scripts.worker = never;
    const prepare = vi.spyOn(coordinator.worktrees, 'prepare').mockRejectedValue(new WorktreeCapacityError('Maximum concurrent worktrees (5) reached'));
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    const waiting = store.listItems(run.id)[0];
    expect(waiting).toMatchObject({ state: 'queued', round: 0, parkReason: null, detail: 'Waiting for a free work folder (0 in use)' });
    prepare.mockRestore();
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    coordinator.requestPump();
    await coordinator._whenSettledForTesting();
    expect(store.getItem(waiting.id)).toMatchObject({ state: 'working', detail: null });
    later.mockRestore();
    prepare.mockRestore();
  });

  it('counts queue work against the same limit on its own: a full shared limit does not stop it, and its checkouts never use that limit up', async () => {
    planDoc('2026-01-01-limit-one');
    planDoc('2026-01-01-limit-two');
    fake.scripts.worker = never;
    const manager = WorktreeManager.getInstance();
    manager.configure({ maxConcurrent: 1 });
    const options = { repoRoot: repo, baseBranch: 'main', skipInstall: true };
    // Something else (a loop, say) already holds the only shared place.
    const holder = await manager.createWorktree('loop-holder', 'loop holder', options);

    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans', config: { workerSlots: 2 } });
    await vi.waitFor(() => expect(store.listItems(run.id).map((item) => item.state)).toEqual(['working', 'queued']), { timeout: 15_000, interval: 50 });

    // The queue checkout in use doesn't count for loops: the place the loop frees is still available to the next loop.
    await expect(manager.createWorktree('loop-blocked', 'loop blocked', options)).rejects.toBeInstanceOf(WorktreeCapacityError);
    await manager.cleanupWorktree(holder.id, { force: true });
    await expect(manager.createWorktree('loop-next', 'loop next', options)).resolves.toBeDefined();

    // The queue's own count keeps its second job waiting until the setting allows two.
    coordinator.requestPump(); await coordinator._whenSettledForTesting();
    expect(store.listItems(run.id).map((item) => item.state)).toEqual(['working', 'queued']);
    manager.configure({ maxConcurrent: 2 });
    coordinator.requestPump();
    await vi.waitFor(() => expect(store.listItems(run.id).map((item) => item.state)).toEqual(['working', 'working']), { timeout: 15_000, interval: 50 });
  });

  it('finishes failed gate comparisons when queue folders exceed the shared worktree limit', async () => {
    defineDefaultScripts();
    planDoc('2026-01-01-gates-one');
    planDoc('2026-01-01-gates-two');
    machineGates.failItem = true;
    WorktreeManager.getInstance().configure({ maxConcurrent: 1 });
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans',
      config: { workerSlots: 2, maxRounds: 1, verifierGates: DEFAULT_PLAN_QUEUE_CONFIG.plans.verifierGates } });
    await waitForRun(run.id);
    expect(store.listItems(run.id)).toHaveLength(2);
    for (const item of store.listItems(run.id)) {
      expect(item).toMatchObject({ state: 'parked', parkReason: 'round-limit', round: 1, verdict: { verdict: 'FAIL' } });
      expect(store.history.listVerdicts(item.id)[0].gatesRun).toEqual(expect.arrayContaining([
        expect.objectContaining({ baseline: 'new', exitCode: 1 }),
      ]));
    }
  });

  it('starts queue work when the shared worktree limit is unlimited', async () => {
    planDoc('2026-01-01-unlimited');
    fake.scripts.worker = never;
    WorktreeManager.getInstance().configure({ maxConcurrent: 0 });
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await vi.waitFor(() => expect(store.listItems(run.id)[0].state).toBe('working'), { timeout: 15_000, interval: 50 });
  });

  it('clears the note older builds saved while waiting for a worktree when the item starts', async () => {
    planDoc('2026-01-01-legacy-note');
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans', config: { workerSlots: 1 } });
    await vi.waitFor(() => expect(store.listItems(run.id)[0].state).toBe('working'), { timeout: 15_000, interval: 50 });
    await coordinator.control({ action: 'pause', runId: run.id });
    await coordinator._whenSettledForTesting();
    const held = store.listItems(run.id)[0];
    store.upsertItem({ ...held, detail: 'Waiting for a free worktree (Harness allows 5 at once).' });

    await coordinator.control({ action: 'resume', runId: run.id });
    await vi.waitFor(() => expect(store.getItem(held.id)).toMatchObject({ state: 'working', detail: null }), { timeout: 15_000, interval: 50 });
  });

  it('keeps genuine preparation errors parked', async () => {
    planDoc('2026-01-01-prepare-failure');
    vi.spyOn(coordinator.worktrees, 'prepare').mockRejectedValueOnce(new Error('disk unavailable'));
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    expect(store.listItems(run.id)[0]).toMatchObject({ state: 'parked', parkReason: 'worktree-error', detail: 'Could not prepare the worktree: disk unavailable' });
  });
});

it('holds a worker that hits a usage limit mid-turn to wait for usage instead of parking it for James', async () => {
  planDoc('2026-01-01-worker-usage-limit');
  fake.scripts.worker = (instance, _message, source) => {
    source.say(instance, 'Claude usage limit reached.');
    source.setStatus(instance, 'idle');
  };
  const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
  const itemId = store.listItems(run.id)[0].id;
  await vi.waitFor(() => expect(store.getItem(itemId)?.detail).toMatch(/^Waiting for usage: /), { timeout: 15_000, interval: 50 });
  expect(store.getItem(itemId)).toMatchObject({ state: 'queued', parkReason: null });
  // The wait is not a round, and the pump leaves the item alone until it ends.
  expect(store.getItem(itemId)!.round).toBe(0);
  expect(fake.created.filter((i) => i.role === 'worker')).toHaveLength(1);
  // The limited session was stopped, and the wait is recorded so it can be counted.
  expect(store.getItem(itemId)!.workerInstanceId).toBeNull();
  expect(store.history.listEvents(itemId).filter((event) => event.reason === 'worker-usage-limit-hold')).toHaveLength(1);
  // Pause clears the wait: Resume tries the item at once, and the worker gets the work again.
  await coordinator.control({ action: 'pause', runId: run.id });
  fake.scripts.worker = implement;
  fake.scripts.verifier = pass;
  await coordinator.control({ action: 'resume', runId: run.id });
  await waitForRun(run.id);
  expect(store.getItem(itemId)).toMatchObject({ state: 'landed' });
  expect(fake.created.filter((i) => i.role === 'worker').length).toBeGreaterThan(1);
}, 30_000);

it('keeps a worker waiting through repeated usage limits, and does not park it within the day', async () => {
  planDoc('2026-01-01-worker-usage-limit-repeats');
  fake.scripts.worker = (instance, _message, source) => {
    source.say(instance, 'Claude usage limit reached.');
    source.setStatus(instance, 'idle');
  };
  const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
  const itemId = store.listItems(run.id)[0].id;
  for (let hold = 1; hold <= 4; hold += 1) {
    await vi.waitFor(() => expect(store.history.listEvents(itemId).filter((e) => e.reason === 'worker-usage-limit-hold')).toHaveLength(hold), { timeout: 15_000, interval: 50 });
    await vi.waitFor(() => expect(store.getItem(itemId)).toMatchObject({ state: 'queued', workerInstanceId: null }), { timeout: 15_000, interval: 50 });
    // Pause then Resume gives the item a fresh try at once, which hits the limit again.
    await coordinator.control({ action: 'pause', runId: run.id });
    await coordinator.control({ action: 'resume', runId: run.id });
  }
  expect(store.getItem(itemId)).toMatchObject({ parkReason: null });
  expect(store.getItem(itemId)!.state).not.toBe('parked');
}, 60_000);

it('counts a verifier asking a question as a failed round with a specific reason', async () => {
  planDoc('2026-01-01-specific-verifier-stop');
  fake.scripts.verifier = (instance, _message, source) => { source.setStatus(instance, 'waiting_for_input'); };
  const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
  await waitForRun(run.id);
  expect(store.listItems(run.id)[0]).toMatchObject({ state: 'parked', parkReason: 'verifier-unreliable', erroredRounds: 2,
    detail: 'the verifier asked a question instead of reporting a verdict' });
}, 30_000);

it('waits when a checker hits its usage limit, which judged nothing and is not a failed round', async () => {
  planDoc('2026-01-01-checker-usage-limit');
  fake.scripts.verifier = (instance, _message, source) => {
    source.say(instance, 'Claude usage limit reached.');
    source.setStatus(instance, 'idle');
  };
  const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
  const itemId = store.listItems(run.id)[0].id;
  await vi.waitFor(() => expect(store.getItem(itemId)?.detail).toMatch(/^Waiting for usage: /), { timeout: 15_000, interval: 50 });
  expect(store.getItem(itemId)).toMatchObject({ state: 'awaiting-slot', parkReason: null, erroredRounds: 0, round: 0 });
  expect(store.history.listEvents(itemId).filter((event) => event.reason === 'worker-usage-limit-hold')).toHaveLength(1);
}, 30_000);

it('holds a run when jobs keep failing the same way, without stopping or setting aside the jobs still waiting', async () => {
  for (const name of ['one', 'two', 'three', 'four']) planDoc(`2026-01-01-${name}`);
  const prepare = vi.spyOn(coordinator.worktrees, 'prepare').mockRejectedValue(new Error('fatal: disk unavailable'));
  const parent = fake.addParent();
  const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { workerSlots: 1 } });
  await vi.waitFor(() => expect(coordinator.getRunDto(run.id)!.holdReason).toContain('disk unavailable'), { timeout: 20_000, interval: 25 });
  await coordinator._whenSettledForTesting();
  const dto = coordinator.getRunDto(run.id)!;
  expect(dto.status).toBe('running');
  expect(dto.items.filter(item => item.state === 'parked')).toHaveLength(3);
  expect(dto.items.filter(item => item.state === 'queued')).toHaveLength(1);
  prepare.mockRestore();
  await coordinator.control({ action: 'resume', runId: run.id });
  expect(coordinator.getRunDto(run.id)!.holdReason).toBeNull();
}, 30_000);

it('clears the former conversation before handing work to the step-up worker', async () => {
  setSavedRouting({ workers: [{ provider: 'claude', model: 'haiku' }], verifiers: [], stepUp: { provider: 'claude', model: 'opus' } });
  planDoc('2026-01-01-session-step-up');
  let sawInitialSession = false;
  let sawClearedSession = false;
  fake.scripts.worker = async (instance, message, source) => {
    const current = store.getItem(itemIdOf(instance))!;
    if (instance.currentModel === 'opus') {
      expect(current.workerSession).toBeUndefined();
      sawClearedSession = true;
    }
    instance.providerSessionId = `conversation-${instance.id}`;
    await implement(instance, message, source);
  };
  let verificationCount = 0;
  const verify: Script = (instance) => {
    verificationCount++;
    coordinator.reportVerdict(instance.id, { item_id: itemIdOf(instance),
      verdict: verificationCount === 1 ? 'FAIL' : 'PASS',
      // A step-up needs a code finding in the failing verdict (step 5.4).
      findings: verificationCount === 1 ? [{ severity: 'high', kind: 'code', confidence: 90, summary: 'The feature is incomplete.' }] : [],
      gates_run: [], document_complete: true, need_james: [], not_checked: [] });
  };
  fake.scripts.verifier = async (instance, message, source) => {
    expect(store.getItem(itemIdOf(instance))?.workerSession?.providerSessionId).toBeTruthy();
    sawInitialSession = true;
    await verify(instance, message, source);
  };
  const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans', config: { maxRounds: 1 } });
  await waitForRun(run.id);
  expect(sawInitialSession).toBe(true);
  expect(sawClearedSession).toBe(true);
  expect(store.listItems(run.id)[0].workerSession).toBeUndefined();
}, 30_000);

it('closes a worker with a saved conversation while its work waits for a check, and reopens it for the fix', async () => {
  planDoc('2026-01-01-close-while-checking');
  fake.scripts.worker = async (instance, message, source) => {
    instance.providerSessionId = `conversation-${instance.id}`;
    await implement(instance, message, source);
  };
  let checks = 0;
  fake.scripts.verifier = (instance) => {
    checks += 1;
    const item = store.getItem(itemIdOf(instance))!;
    // The first worker is gone and no session is left linked to the item while it is checked.
    expect(item.workerInstanceId).toBeNull();
    expect(fake.getAllInstances().filter((i) => i.role === 'worker')).toEqual([]);
    coordinator.reportVerdict(instance.id, {
      item_id: itemIdOf(instance), verdict: checks === 1 ? 'FAIL' : 'PASS',
      findings: checks === 1 ? [{ severity: 'high', confidence: 90, summary: 'Retry guard is missing.' }] : [],
      gates_run: [], document_complete: true, need_james: [], not_checked: [],
    });
  };
  const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans', config: { maxRounds: 3 } });
  await waitForRun(run.id);

  expect(store.listItems(run.id)[0]).toMatchObject({ state: 'landed', round: 2 });
  const workers = fake.created.filter((i) => i.role === 'worker');
  expect(workers).toHaveLength(2);
  // The fix round reopened the first worker's conversation with the findings, rather than starting over.
  expect(workers[1].config).toMatchObject({ sessionId: `conversation-${workers[0].id}`, resume: true });
  expect(workers[1].config.initialPrompt).toContain('Retry guard is missing.');
  expect(fake.inputs.filter((m) => workers.some((w) => w.id === m.instanceId))).toEqual([]);
}, 30_000);

it('parks the item, rather than leaving it stuck, when its worker cannot be closed for the check', async () => {
  planDoc('2026-01-01-close-fails');
  fake.scripts.worker = async (instance, message, source) => {
    instance.providerSessionId = `conversation-${instance.id}`;
    await implement(instance, message, source);
  };
  const terminate = fake.terminateInstance.bind(fake);
  vi.spyOn(fake, 'terminateInstance').mockImplementation(async (id) => {
    if (fake.getInstance(id)?.role === 'worker') throw new Error('archive failed');
    await terminate(id);
  });
  const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
  await vi.waitFor(() => expect(store.listItems(run.id)[0].state).toBe('parked'), { timeout: 15_000, interval: 50 });

  const item = store.listItems(run.id)[0];
  expect(item).toMatchObject({ parkReason: 'worker-error', workerInstanceId: fake.created.find((i) => i.role === 'worker')!.id });
  expect(item.detail).toContain('Could not close the worker while its work waits for a check: archive failed');
  expect(fake.created.filter((i) => i.role === 'verifier')).toEqual([]);
}, 30_000);
