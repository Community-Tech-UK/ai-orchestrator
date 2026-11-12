import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { WorkAdmission } from '../work-admission/work-admission';
import { workSourceFor } from './plan-queue-work-sources';
import { roundsKey, stepPlanProblem } from './plan-queue-sections';
import { runToDto } from './plan-queue-messages';
import { extractPlan, planSteps } from './plan-queue-plan-extract';
import { buildVerifierPrompt, buildWorkerPrompt } from './plan-queue-prompts';
import { pumpPlanQueue } from './plan-queue-pump';
import { applyTriageRecords, reconcileWaitingDocuments } from './plan-queue-readiness';
import { PlanQueueWorkerSessions } from './plan-queue-worker-sessions';
import { claimDocumentsAndCreateItems } from './plan-queue-run-start';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

// Work admission reads the real load average on the light levels; keep this Mac's load out of the result.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, loadavg: () => [0, 0, 0] }, loadavg: () => [0, 0, 0] };
});

const STEPPED = ['# Big plan', '', '## Status', '', 'Under way.', '', '## Step 1. Base', '', '- [ ] one', '- [x] done', '',
  '## Step 2. Middle', '', '- [ ] two', '', '## Step 3. End', '', '- [ ] three', '', '## Final verification', '', '- [ ] run it', ''];
// Over the 20-item limit for one job, so the plan counts as too big.
const filler = Array.from({ length: 21 }, (_, n) => `- [ ] filler ${n}`);
const bigStepped = [...STEPPED.slice(0, 4), ...filler, ...STEPPED.slice(4)].join('\n');

let folder: string;
let db: ReturnType<typeof createSqliteWasmDatabase>;
let store: PlanQueueStore;
let run: PlanQueueRun;
beforeAll(() => initSqliteWasm());
beforeEach(() => {
  folder = realpathSync(mkdtempSync(join(tmpdir(), 'queue-step-jobs-')));
  db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db);
  store = new PlanQueueStore(db);
  run = { id: 'run', parentInstanceId: 'chat', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: folder, status: 'running',
    config: DEFAULT_PLAN_QUEUE_CONFIG.plans, relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null };
  store.upsertRun(run);
});
afterEach(() => { db.close(); rmSync(folder, { recursive: true, force: true }); WorkAdmission._resetForTesting(); });

function plan(name: string, content: string): string {
  mkdirSync(join(folder, 'docs', 'plans'), { recursive: true });
  const file = join(folder, 'docs', 'plans', name);
  writeFileSync(file, content);
  return file;
}

async function start(options: { queueDirectly?: boolean } = {}) {
  let id = 0;
  const documents = await workSourceFor('markdown').discover(folder, { kind: 'plans' });
  claimDocumentsAndCreateItems({ store, now: () => 100, newId: () => `job-${++id}` }, run, documents, options);
  return store.listItems('run');
}

describe('finding and starting a big plan', () => {
  it('makes one job per step for a big plan with step headings, the first one waiting for triage', async () => {
    const file = plan('big_plan.md', bigStepped);
    const items = await start();
    expect(items.map(item => [item.sourceRef, item.section, item.state])).toEqual([
      [file, 1, 'discovered'], [file, 2, 'queued'], [file, 3, 'queued'],
    ]);
    expect(items.map(item => item.createdAt)).toEqual([100, 101, 102]);
  });

  it('does the same when the plan is picked by name', async () => {
    plan('big_plan.md', bigStepped);
    expect((await start({ queueDirectly: true })).map(item => [item.section, item.state])).toEqual([[1, 'queued'], [2, 'queued'], [3, 'queued']]);
  });

  it('still leaves out a big plan that has no step headings', async () => {
    plan('flat_plan.md', ['# Flat', ...filler].join('\n'));
    const items = await start();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ state: 'skipped', detail: expect.stringContaining('21 unticked items') });
    expect(items[0].section ?? null).toBeNull();
  });

  it('keeps leaving out a big plan whose step numbers repeat, because its jobs could not be told apart', async () => {
    plan('repeat_plan.md', ['# Repeat', ...filler, '## Step 1. A', '## Step 1. B'].join('\n'));
    expect((await start()).map(item => [item.section ?? null, item.state])).toEqual([[null, 'skipped']]);
  });

  describe('a part-done plan', () => {
    const partDone = ['# Part done', ...filler, '## Step 1. Landed', '- [x] a', '- [x] b', '## Step 2. Open', '- [x] c', '- [ ] d', '## Step 3. Prose only', 'Do it.', '## Step 4. Also landed', '- [x] e'].join('\n');

    it('makes jobs only for the steps that still have something to do, keeping a step with no checklist', async () => {
      const file = plan('part_plan.md', partDone);
      const items = await start();
      expect(items.map(item => [item.sourceRef, item.section, item.state])).toEqual([[file, 2, 'discovered'], [file, 3, 'queued']]);
    });

    it('does the same when picked by name', async () => {
      plan('part_plan.md', partDone);
      expect((await start({ queueDirectly: true })).map(item => [item.section, item.state])).toEqual([[2, 'queued'], [3, 'queued']]);
    });

    it('leaves the plan out, saying why, when every step is ticked off', async () => {
      plan('done_plan.md', ['# Done', ...filler, '## Step 1. A', '- [x] a', '## Step 2. B', '- [x] b'].join('\n'));
      for (const queueDirectly of [false, true]) {
        store.upsertRun({ ...run, id: `again-${queueDirectly}`, status: 'completed' });
        const items = await start({ queueDirectly });
        expect(items.at(-1)).toMatchObject({ state: 'skipped', detail: expect.stringContaining('every step in this plan is already ticked off') });
        expect(items.at(-1)!.section ?? null).toBeNull();
        for (const item of items) store.upsertItem({ ...item, state: 'landed' });
      }
    });
  });

  it('runs a small plan with step headings as one job', async () => {
    plan('small_plan.md', STEPPED.join('\n'));
    expect((await start()).map(item => [item.section ?? null, item.state])).toEqual([[null, 'discovered']]);
  });

  it('shares the document: a second run cannot take it while any step is still to do, and may once all are done', async () => {
    const file = plan('big_plan.md', bigStepped);
    await start({ queueDirectly: true });
    const rival: PlanQueueRun = { ...run, id: 'rival' };
    store.upsertRun(rival);
    const claim = () => claimDocumentsAndCreateItems({ store, now: () => 200, newId: () => `rival-${Math.random()}` }, rival,
      [{ ref: file, readiness: 'candidate' }], { queueDirectly: true });
    expect(claim()).toEqual([file]);
    for (const item of store.listItems('run')) store.upsertItem({ ...item, state: 'landed' });
    expect(claim()).toEqual([]);
    expect(store.listItems('rival')).toHaveLength(3);
  });

  it('skips the later steps with the first when its last two attempts stopped the same way', async () => {
    const file = plan('big_plan.md', bigStepped);
    utimesSync(file, new Date(Date.now() - 3 * 86_400_000), new Date(Date.now() - 3 * 86_400_000));
    for (const [id, at] of [['a', 1], ['b', 2]] as const) {
      store.upsertRun({ ...run, id: `older-${id}`, status: 'completed' });
      const attempt = newPlanQueueItem(`stop-${id}`, `older-${id}`, file, at, { state: 'queued', section: 1 });
      store.upsertItem(attempt);
      store.upsertItem({ ...attempt, state: 'parked', parkReason: 'worktree-error', detail: 'The checks could not start.' });
    }
    const items = await start();
    expect(items.map(item => item.state)).toEqual(['skipped', 'skipped', 'skipped']);
  });
});

describe('running the steps in order', () => {
  function pumpOf(items: PlanQueueItem[]) {
    const starts: string[] = [];
    const host: Parameters<typeof pumpPlanQueue>[0] = {
      store: { listActiveRuns: () => [run], listAutomaticLandingsInEndedRuns: () => [], listItems: () => items, listItemsWithKeptFolders: () => [], listFoldersWithDiscardedItems: () => [],
        waits: { blocked: () => undefined, explain: () => false, started: () => undefined, prune: () => undefined, paused: () => undefined, waitingSince: () => undefined } } as unknown as PlanQueueStore,
      flow: { startItem: async item => { starts.push(item.id); }, startVerification: async () => undefined, isWaitingForUsage: () => false, isClaimed: () => false,
        recheckLandingWait: async () => undefined, keptFolders: { retryDue: () => undefined }, breaker: { canStart: () => true, started: () => undefined } as never,
        discardedRefs: { sweepDue: () => undefined }, recoveryCopies: { sweepDue: () => undefined }, landingRetries: { retryDue: async () => undefined }, checklistTurns: new Set<string>(), finishLandingCleanup: async () => undefined },
      triage: null, getRun: () => run, getItem: id => items.find(item => item.id === id)!,
      transition: (item, state, patch) => Object.assign(item, patch, { state }),
      notifyParent: () => undefined, resolveRunParent: () => 'chat', loadAverage: () => [0, 0, 0], queueFolderLimit: () => 0, followParent: value => value,
      isShuttingDown: () => false, isControlling: () => false, finishRun: () => undefined,
      logItemError: (_item, error) => { throw error; }, announceRun: () => undefined,
    };
    return { host, starts };
  }
  const stepsFrom = (first: number, ...states: PlanQueueItem['state'][]) => states.map((state, index) =>
    newPlanQueueItem(`step-${first + index}`, 'run', join(folder, 'big_plan.md'), index + 1, { state, section: first + index }));
  const steps = (...states: PlanQueueItem['state'][]) => stepsFrom(1, ...states);

  it('does not start step 2 before step 1 has landed, then starts it', async () => {
    writeFileSync(join(folder, 'big_plan.md'), '# Big');
    const items = steps('queued', 'queued', 'queued');
    const { host, starts } = pumpOf(items);
    await pumpPlanQueue(host);
    expect(starts).toEqual(['step-1']);
    items[0].state = 'landed';
    await pumpPlanQueue(host);
    expect(starts).toEqual(['step-1', 'step-2']);
  });

  it('starts the first step that has a job straight away when the steps before it are already ticked off', async () => {
    writeFileSync(join(folder, 'big_plan.md'), '# Big');
    const items = stepsFrom(4, 'queued', 'queued');
    const { host, starts } = pumpOf(items);
    await pumpPlanQueue(host);
    expect(starts).toEqual(['step-4']);
    items[0].state = 'landed';
    await pumpPlanQueue(host);
    expect(starts).toEqual(['step-4', 'step-5']);
  });

  it.each(['parked', 'working', 'verifying', 'landing'] as const)('holds the later steps while step 1 is %s', async (state) => {
    writeFileSync(join(folder, 'big_plan.md'), '# Big');
    const items = steps(state, 'queued', 'queued');
    const { host, starts } = pumpOf(items);
    await pumpPlanQueue(host);
    expect(starts).toEqual([]);
    expect(items.map(item => item.state)).toEqual([state, 'queued', 'queued']);
  });

  it('leaves out the steps behind a skipped step, one after another', async () => {
    writeFileSync(join(folder, 'big_plan.md'), '# Big');
    const items = steps('skipped', 'queued', 'queued');
    const { host, starts } = pumpOf(items);
    await pumpPlanQueue(host);
    expect(items[1]).toMatchObject({ state: 'skipped', detail: 'Left out because Step 1 was skipped.' });
    await pumpPlanQueue(host);
    expect(items[2]).toMatchObject({ state: 'skipped', detail: 'Left out because Step 2 was skipped.' });
    expect(starts).toEqual([]);
  });

  it('does not hold a whole-document job', async () => {
    writeFileSync(join(folder, 'big_plan.md'), '# Big');
    const { host, starts } = pumpOf([newPlanQueueItem('whole', 'run', join(folder, 'big_plan.md'), 1, { state: 'queued' })]);
    await pumpPlanQueue(host);
    expect(starts).toEqual(['whole']);
  });
});

describe('what a step job is told', () => {
  const item = (section: number) => ({ ...newPlanQueueItem('i', 'run', '/repo/docs/plans/big_plan.md', 1, { section }), branchName: 'queue/big-1' });
  const ctx = (section: number) => ({ item: item(section), kind: 'plans' as const, repoRoot: '/repo', worktreePath: '/repo/.wt',
    brief: extractPlan(bigStepped, section) });

  it('names the step and its line range, and the Status block', () => {
    const steps = planSteps(bigStepped)!;
    const prompt = buildWorkerPrompt(ctx(2));
    expect(prompt).toContain(`Implement Step 2, lines ${steps[1].startLine}-${steps[1].endLine}; read the Status block and that step only.`);
    expect(prompt).toContain('Under way.');
  });

  it('shows only its own step\'s open items', () => {
    const brief = extractPlan(bigStepped, 2);
    expect(brief.acceptance).toContain('- [ ] two');
    expect(brief.acceptance).not.toContain('three');
    expect(brief.acceptance).not.toContain('filler');
  });

  it('has the later steps leave the as-built summary to the last step, and no step close the plan', () => {
    expect(buildWorkerPrompt(ctx(2))).toContain('Do not write the plan\'s as-built summary');
    expect(buildWorkerPrompt(ctx(3))).toContain('also write the plan\'s as-built summary');
    for (const section of [1, 3]) {
      const prompt = buildWorkerPrompt(ctx(section));
      expect(prompt).toContain('Tick only the checklist items inside your step');
      expect(prompt).toContain('A step job never closes the plan');
    }
  });

  it('keeps the whole-document prompt as it was', () => {
    const prompt = buildWorkerPrompt({ ...ctx(2), item: { ...item(2), section: null }, brief: extractPlan(bigStepped) });
    expect(prompt).toContain('implement every unchecked item in the plan');
    expect(prompt).not.toContain('Implement Step');
    expect(prompt).toContain('The coordinator does that after an independent verifier passes the work.');
  });

  it('tells the worker when its step has gone from the plan', () => {
    expect(buildWorkerPrompt({ ...ctx(9), brief: extractPlan(bigStepped, 9) })).toContain('Step 9 (its heading could not be found');
  });

  it('tells the checker which step it judges', () => {
    const prompt = buildVerifierPrompt({ ...ctx(2), baseBranch: 'main', gates: [] });
    expect(prompt).toContain('This job covers Step 2, lines');
    expect(prompt).toContain('expect the plan to stay open');
    expect(prompt).toContain('never closes the plan');
    expect(prompt).not.toContain('is refused. If something still fails');
    expect(buildVerifierPrompt({ ...ctx(2), item: { ...item(2), section: null }, brief: extractPlan(bigStepped), baseBranch: 'main', gates: [] })).toContain('PASS with `document_complete: false` is refused');
  });
});

describe('finding a plan\'s steps', () => {
  it('ignores headings inside code fences and anything that is not a step heading', () => {
    const content = ['## Step 1. A', '```', '## Step 2. Fake', '```', '## Step 3. B', '## Stepping stones', 'text'].join('\n');
    expect(planSteps(content)).toEqual([
      { number: 1, startLine: 1, endLine: 4, last: false, boxes: 0, open: 0 },
      { number: 3, startLine: 5, endLine: 5, last: true, boxes: 0, open: 0 },
    ]);
  });

  it('counts each step\'s checklist, ticked and unticked', () => {
    expect(planSteps('## Step 1. A\n- [x] a\n* [X] b\n## Step 2. B\n- [ ] c\n- [x] d\n## Step 3. C\nprose')?.map(step => [step.boxes, step.open])).toEqual([[2, 0], [2, 1], [0, 0]]);
  });

  it('is null for one step, or repeated numbers', () => {
    expect(planSteps('## Step 1. Only')).toBeNull();
    expect(planSteps('## Step 1. A\n## Step 1. B')).toBeNull();
  });
});

describe('showing step jobs', () => {
  it('says which step of how many a job is, and which step it waits for', () => {
    const file = join(folder, 'big_plan.md');
    const items = [1, 2, 3].map(n => newPlanQueueItem(`s${n}`, 'run', file, n, { state: n === 1 ? 'working' : 'queued', section: n }));
    const dto = runToDto(run, items, undefined, new Map(), new Map([[roundsKey(file, 2), 4], [roundsKey(file, null), 9]]));
    expect(dto.items.map(entry => entry.step)).toEqual([{ number: 1, position: 1, of: 3, waitingFor: null }, { number: 2, position: 2, of: 3, waitingFor: 1 }, { number: 3, position: 3, of: 3, waitingFor: 2 }]);
    // Rounds are each step's own, never the document's total across steps.
    expect(dto.items.map(entry => entry.totalRounds)).toEqual([undefined, 4, undefined]);
  });

  it('gives a step its place among the run\'s jobs when earlier steps are ticked off', () => {
    const file = join(folder, 'big_plan.md');
    const items = [4, 8].map(n => newPlanQueueItem(`s${n}`, 'run', file, n, { state: 'queued', section: n }));
    expect(runToDto(run, items, undefined, new Map(), new Map()).items.map(entry => entry.step)).toEqual([
      { number: 4, position: 1, of: 2, waitingFor: null }, { number: 8, position: 2, of: 2, waitingFor: 4 }]);
  });

  it('shows no step for a whole-document job', () => {
    const whole = newPlanQueueItem('w', 'run', join(folder, 'x_plan.md'), 1, { state: 'queued' });
    expect(runToDto(run, [whole], undefined, new Map(), new Map()).items[0].step).toBeUndefined();
  });
});

describe('telling step jobs of one plan apart', () => {
  const file = '/repo/docs/plans/big_plan.md';
  // A later attempt at the same step is in a later run, as it is in real use.
  const job = (id: string, section: number | null, state: PlanQueueItem['state'], createdAt: number, patch: Partial<PlanQueueItem> = {}) => {
    const runId = `run-${createdAt}`;
    store.upsertRun({ ...run, id: runId, status: 'completed' });
    store.upsertItem(newPlanQueueItem(id, runId, file, createdAt, { state, ...(section === null ? {} : { section }), ...patch }));
  };

  it('does not call another step "in play" against a step set aside, so it can be resumed', () => {
    job('s1', 1, 'parked', 1, { branchName: 'queue/s1' }); job('s2', 2, 'queued', 1);
    expect(store.documentInPlay(store.getItem('s1')!)).toBe(false);
    job('s1b', 1, 'working', 3);
    expect(store.documentInPlay(store.getItem('s1')!)).toBe(true);
  });

  it('does not treat a later step landing as a newer attempt at an earlier step', () => {
    job('s1', 1, 'parked', 1, { branchName: 'queue/s1' }); job('s2', 2, 'landed', 2);
    expect(store.newerAttemptLanded(store.getItem('s1')!)).toBe(false);
    expect(store.newerAttemptCommits({ ...store.getItem('s1')!, createdAt: 0 })).toEqual([]);
    expect(store.listParkedInFolder(folder).every(entry => !entry.landedLater)).toBe(true);
    job('s1b', 1, 'landed', 3);
    expect(store.newerAttemptLanded(store.getItem('s1')!)).toBe(true);
  });

  it('offers only whole-document jobs as the earlier attempt at a document', () => {
    job('s1', 1, 'parked', 1, { branchName: 'queue/s1' });
    expect(store.findLatestParkedItem(file, 'chat')).toBeNull();
    job('whole', null, 'parked', 2, { branchName: 'queue/whole' });
    expect(store.findLatestParkedItem(file, 'chat')?.id).toBe('whole');
  });
});

describe('triage of a stepped plan', () => {
  it('applies the document\'s decision to its first step, not to the later steps that share the path', () => {
    const file = join(folder, 'big_plan.md');
    for (const [id, state, section, at] of [['s1', 'discovered', 1, 1], ['s2', 'queued', 2, 2], ['s3', 'queued', 3, 3]] as const) {
      store.upsertItem(newPlanQueueItem(id, 'run', file, at, { state, section }));
    }
    const host = { store, getRun: () => run, getItem: (id: string) => store.getItem(id)!, notifyParent: () => undefined,
      transition: (item: PlanQueueItem, state: PlanQueueItem['state'], patch: Partial<PlanQueueItem> = {}) => { const next = { ...item, ...patch, state }; store.upsertItem(next); return next; } };
    const outcome = applyTriageRecords(host, run, { run_id: 'run', records: [{ documentPath: file, disposition: 'ready' }] });
    expect(outcome).toEqual({ applied: 1, unmatched: [] });
    expect(store.listItems('run').map(item => item.state)).toEqual(['queued', 'queued', 'queued']);
  });
});

describe('the answer given for a stepped plan', () => {
  it('reaches every step\'s worker, and the last job of the run is the one that writes the as-built summary', async () => {
    const file = plan('big_plan.md', bigStepped);
    for (const [id, section, answer] of [['s1', 1, 'Which runner? → The quiet one'], ['s2', 2, null], ['s3', 3, null]] as const) {
      store.upsertItem(newPlanQueueItem(id, 'run', file, section, { state: 'queued', section, answer }));
    }
    const sessions = new PlanQueueWorkerSessions({ host: { store } as never, lock: async () => undefined, stop: async () => undefined, spawn: async () => undefined, failed: async () => undefined });
    const context = (id: string) => sessions.promptContext(run, store.getItem(id)!);
    expect((await context('s2')).answer).toBe('Which runner? → The quiet one');
    expect(buildWorkerPrompt(await context('s3'))).toContain('The quiet one');
    expect([(await context('s2')).brief?.step?.last, (await context('s3')).brief?.step?.last]).toEqual([false, true]);
  });

  it('makes the run\'s last job write the summary when the plan\'s last step was ticked off and has no job', async () => {
    const file = plan('big_plan.md', bigStepped);
    for (const section of [1, 2]) store.upsertItem(newPlanQueueItem(`s${section}`, 'run', file, section, { state: 'queued', section }));
    const sessions = new PlanQueueWorkerSessions({ host: { store } as never, lock: async () => undefined, stop: async () => undefined, spawn: async () => undefined, failed: async () => undefined });
    expect((await sessions.promptContext(run, store.getItem('s2')!)).brief?.step?.last).toBe(true);
  });

  it('gives a job its own answer in preference to the first step\'s', async () => {
    const file = plan('big_plan.md', bigStepped);
    store.upsertItem(newPlanQueueItem('s1', 'run', file, 1, { state: 'queued', section: 1, answer: 'first' }));
    store.upsertItem(newPlanQueueItem('s2', 'run', file, 2, { state: 'queued', section: 2, answer: 'own' }));
    const sessions = new PlanQueueWorkerSessions({ host: { store } as never, lock: async () => undefined, stop: async () => undefined, spawn: async () => undefined, failed: async () => undefined });
    expect(sessions.continueContext(run, store.getItem('s2')!).answer).toBe('own');
  });
});

describe('a step job whose plan was renamed', () => {
  const hostOf = () => ({ store, getRun: () => run, getItem: (id: string) => store.getItem(id)!,
    transition: (item: PlanQueueItem, state: PlanQueueItem['state'], patch: Partial<PlanQueueItem> = {}) => { const next = { ...item, ...patch, state }; store.upsertItem(next); return next; }, notifyParent: () => undefined });

  it('is set aside with a plain reason before it starts, instead of being retired as superseded', async () => {
    const file = join(folder, 'big_plan.md');
    writeFileSync(join(folder, 'big_plan_completed.md'), '# closed');
    store.upsertItem(newPlanQueueItem('s2', 'run', file, 2, { state: 'queued', section: 2 }));
    store.upsertItem(newPlanQueueItem('whole', 'run', join(folder, 'other_plan.md'), 3, { state: 'queued' }));
    writeFileSync(join(folder, 'other_plan_completed.md'), '# closed');
    await reconcileWaitingDocuments(hostOf(), run);
    expect(store.getItem('s2')).toMatchObject({ state: 'parked', parkReason: 'missing-document', detail: expect.stringContaining('a step job never closes its plan') });
    // A whole-document job is still retired as before.
    expect(store.getItem('whole')?.state).toBe('skipped');
  });

  it('says so whether the plan was renamed or has just gone', async () => {
    const file = join(folder, 'big_plan.md');
    expect(await stepPlanProblem(file)).toContain('no longer where this step expects it');
    writeFileSync(file, '# open');
    expect(await stepPlanProblem(file)).toBeNull();
    writeFileSync(join(folder, 'big_plan_completed.md'), '# closed');
    expect(await stepPlanProblem(file)).toContain('Rename it back to big_plan.md');
  });
});

describe('a step\'s earlier attempts and rounds', () => {
  it('feeds the repeated-stop rule and the round counts from its own step only', () => {
    const file = '/repo/docs/plans/big_plan.md';
    for (const [id, section] of [['s1', 1], ['s2', 2]] as const) {
      store.upsertRun({ ...run, id: `r-${id}`, status: 'completed' });
      store.upsertItem(newPlanQueueItem(id, `r-${id}`, file, 1, { state: 'parked', section }));
      db.prepare(`INSERT INTO plan_queue_verdicts (id, item_id, run_id, round, at, verdict, findings_json, gates_json, not_checked_json) VALUES (?, ?, ?, 1, 1, 'FAIL', '[]', '[]', '[]')`)
        .run(`v-${id}`, id, `r-${id}`);
    }
    expect(store.latestAttempts(file, 5, 1).map(item => item.id)).toEqual(['s1']);
    expect(store.latestAttempts(file, 5).map(item => item.id)).toEqual([]);
    const rounds = store.history.totalRoundsByDocument();
    expect([rounds.get(roundsKey(file, 1)), rounds.get(roundsKey(file, 2)), rounds.get(roundsKey(file, null))]).toEqual([1, 1, undefined]);
  });
});
