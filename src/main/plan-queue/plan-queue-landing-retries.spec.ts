import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { mergeCheckStillOwed, recordMergeCheckOwed } from './plan-queue-check-timeouts';
import { LANDING_RETRY_GIVE_UP_MS, MAX_AUTOMATIC_LANDINGS, mergesWithBase, PlanQueueLandingRetries } from './plan-queue-landing-retries';
import { newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import type { PlanQueueRun } from './plan-queue.types';

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;
const REGISTER = 'docs/plans/livetest-remediation-register.md';
let repo: string;
let db: SqliteDriver;
let clock: number;
let store: PlanQueueStore;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (file: string, text: string, message: string) => { writeFileSync(join(repo, file), text); git('add', '-A'); git('commit', '-qm', message); };
beforeAll(() => initSqliteWasm());
beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'queue-landing-retries-')));
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'Queue Test'); git('config', 'user.email', 'queue@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, 'docs/plans'), { recursive: true });
  commit('a.txt', 'one\ntwo\n', 'base');
  commit(REGISTER, '| LT-1 | open |\n', 'register');
  db = createSqliteWasmDatabase(':memory:'); runLoopMigrations(db);
  clock = 100 * DAY;
  store = new PlanQueueStore(db, () => clock);
});
afterEach(() => { db.close(); rmSync(repo, { recursive: true, force: true }); });

const run = (id: string, status: PlanQueueRun['status'] = 'completed'): PlanQueueRun => ({ id, parentInstanceId: 'parent', parentHistoryThreadId: null,
  kind: 'plans', workspaceCwd: repo, status, config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, baseBranch: 'main' }, relaxation: null,
  workerProvider: null, workerModel: null, startedAt: 1, endedAt: null });

/** A passed job set aside at landing, whose branch changes `file`. */
function passedPark(id: string, file = `${id}.txt`, text = `${id}\n`) {
  git('checkout', '-qb', `queue/${id}`); commit(file, text, id); git('checkout', '-q', 'main');
  const created = newPlanQueueItem(id, 'run', join(repo, `${id}_plan.md`), clock, { state: 'queued', branchName: `queue/${id}`,
    verdict: { verdict: 'PASS', findings: [], gatesRun: [], documentComplete: true, needJames: [] } });
  store.upsertItem(created);
  store.history.recordVerdict({ itemId: id, runId: 'run', round: 1, verdict: 'PASS', findings: [], gatesRun: [], notChecked: [], worktreeHead: null, documentSha256: null });
  store.upsertItem({ ...created, state: 'parked', parkReason: 'land-blocked' });
}

function retries(retry = vi.fn(async (_id: string) => undefined)) {
  const host = { store, history: store.history, getRun: (id: string) => store.getRun(id)! };
  return { retry, retries: new PlanQueueLandingRetries(host as never, retry, () => clock) };
}

describe('mergesWithBase', () => {
  it('says yes to a clean merge and to a clash only in the register, and no to any other clash', async () => {
    git('checkout', '-qb', 'queue/clean'); commit('b.txt', 'b\n', 'clean'); git('checkout', '-q', 'main');
    git('checkout', '-qb', 'queue/register'); commit(REGISTER, '| LT-1 | fixed by the job |\n', 'job'); git('checkout', '-q', 'main');
    git('checkout', '-qb', 'queue/clash'); commit('a.txt', 'one\njob\n', 'job'); git('checkout', '-q', 'main');
    commit(REGISTER, '| LT-1 | fixed on main |\n', 'main register'); commit('a.txt', 'one\nmain\n', 'main a');
    expect(await mergesWithBase(repo, 'main', 'queue/clean')).toBe(true);
    expect(await mergesWithBase(repo, 'main', 'queue/register')).toBe(true);
    expect(await mergesWithBase(repo, 'main', 'queue/clash')).toBe(false);
    expect(await mergesWithBase(repo, 'main', 'queue/missing')).toBe(false);
  });
});

describe('PlanQueueLandingRetries', () => {
  beforeEach(() => store.upsertRun(run('run')));

  it('tries a passed landing a day after it stopped, not before', async () => {
    passedPark('a');
    const { retry, retries: due } = retries();
    clock += DAY - HOUR;
    await due.retryDue();
    expect(retry).not.toHaveBeenCalled();
    clock += 2 * HOUR;
    await due.retryDue();
    expect(retry).toHaveBeenCalledWith('a');
  });

  it('leaves a branch that clashes with the base for a person', async () => {
    passedPark('a', 'a.txt', 'one\njob\n');
    commit('a.txt', 'one\nmain\n', 'main moved');
    const { retry, retries: due } = retries();
    clock += 2 * DAY;
    await due.retryDue();
    expect(retry).not.toHaveBeenCalled();
  });

  it('stops trying two weeks after the pass', async () => {
    passedPark('a');
    const { retry, retries: due } = retries();
    clock += LANDING_RETRY_GIVE_UP_MS + HOUR;
    await due.retryDue();
    expect(retry).not.toHaveBeenCalled();
  });

  it(`runs at most ${MAX_AUTOMATIC_LANDINGS} at once, counting those still landing`, async () => {
    for (const id of ['a', 'b', 'c']) passedPark(id);
    const landing = newPlanQueueItem('busy', 'run', join(repo, 'busy_plan.md'), clock, { state: 'landing', landingAutomatic: true });
    store.upsertItem(landing);
    const { retry, retries: due } = retries();
    clock += 2 * DAY;
    await due.retryDue();
    expect(retry.mock.calls.map(([id]) => id)).toEqual(['a']);
  });

  it('leaves a job alone while its folder holds an unfinished merge, which a retry would abort', async () => {
    passedPark('a', 'a.txt', 'one\njob\n');
    const folder = join(repo, '.worktrees', 'a');
    git('worktree', 'add', '-q', folder, 'queue/a');
    commit('a.txt', 'one\nmain\n', 'main moved');
    try { execFileSync('git', ['merge', 'main'], { cwd: folder, stdio: 'ignore' }); } catch { /* the clash is the point */ }
    store.upsertItem({ ...store.getItem('a')!, worktreePath: folder });
    git('checkout', '-q', 'main'); git('reset', '-q', '--hard', 'HEAD~1');
    const { retry, retries: due } = retries();
    clock += 2 * DAY;
    await due.retryDue();
    expect(retry).not.toHaveBeenCalled();
  });

  it('leaves the work of a run James cancelled alone', async () => {
    passedPark('a');
    store.upsertRun(run('run', 'cancelled'));
    const { retry, retries: due } = retries();
    clock += 2 * DAY;
    await due.retryDue();
    expect(retry).not.toHaveBeenCalled();
  });

  it('does nothing while any run is paused, as Pause all pauses every run', async () => {
    passedPark('a');
    store.upsertRun(run('other', 'paused'));
    const { retry, retries: due } = retries();
    clock += 2 * DAY;
    await due.retryDue();
    expect(retry).not.toHaveBeenCalled();
  });

  it('looks at a job at most once an hour, so a failed try is not repeated on every pass', async () => {
    passedPark('a');
    const retry = vi.fn(async () => { throw new Error('no free work folder'); });
    const { retries: due } = retries(retry);
    clock += 2 * DAY;
    await due.retryDue(); await due.retryDue();
    expect(retry).toHaveBeenCalledTimes(1);
    clock += HOUR + 1;
    await due.retryDue();
    expect(retry).toHaveBeenCalledTimes(2);
  });
});

describe('a check owed after merging', () => {
  it('stays owed through new commits until the work is checked again', () => {
    store.upsertRun(run('run'));
    passedPark('a');
    const item = store.getItem('a')!;
    clock += HOUR;
    recordMergeCheckOwed(store, { ...item, checkpointCommit: 'first' });
    expect(mergeCheckStillOwed(store, { ...item, checkpointCommit: 'saved-leftovers' })).toBe(true);
    clock += HOUR;
    store.history.recordVerdict({ itemId: 'a', runId: 'run', round: 2, verdict: 'FAIL', findings: [], gatesRun: [], notChecked: [], worktreeHead: null, documentSha256: null });
    expect(mergeCheckStillOwed(store, item)).toBe(false);
  });
});

describe('restart recovery', () => {
  it('finds an automatic landing in an ended run, which its pass over open runs misses', () => {
    store.upsertRun(run('ended')); store.upsertRun(run('open', 'running'));
    store.upsertItem(newPlanQueueItem('ended-job', 'ended', join(repo, 'e_plan.md'), clock, { state: 'landing', landingAutomatic: true }));
    store.upsertItem(newPlanQueueItem('open-job', 'open', join(repo, 'o_plan.md'), clock, { state: 'landing', landingAutomatic: true }));
    store.upsertItem(newPlanQueueItem('person', 'ended', join(repo, 'p_plan.md'), clock, { state: 'landing' }));
    expect(store.listAutomaticLandingsInEndedRuns().map(item => item.id)).toEqual(['ended-job']);
  });
});

describe('the automatic marker', () => {
  it('survives a restart while landing and goes when the job leaves landing', () => {
    store.upsertRun(run('run', 'running'));
    const item = newPlanQueueItem('a', 'run', join(repo, 'a_plan.md'), clock, { state: 'landing', landingAutomatic: true });
    store.upsertItem(item);
    expect(new PlanQueueStore(db).getItem('a')?.landingAutomatic).toBe(true);
    store.upsertItem({ ...item, state: 'parked', parkReason: 'land-blocked' });
    expect(store.getItem('a')?.landingAutomatic).toBeUndefined();
  });
});
