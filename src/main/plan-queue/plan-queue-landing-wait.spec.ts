/**
 * A landing the root checkout's uncommitted code is blocking waits instead of parking (programme steps 4.1 and 4.2).
 * Real git, a real queue store and the real item flow; only the work-folder service and sessions are stand-ins.
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { useGitRepoTemplate } from '../workspace/git/git-repo-template.test-helpers';
import { landItemBranch } from './plan-queue-landing';
import { landingBlockers, LANDING_WAIT_LIMIT_MS, MAX_LANDING_WAITERS } from './plan-queue-landing-wait';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import { pumpPlanQueue } from './plan-queue-pump';
import { recoverPlanQueue, type PlanQueueRecoveryHost } from './plan-queue-recovery';
import { assertItemTransition, newPlanQueueItem } from './plan-queue-state';
import { PlanQueueStore } from './plan-queue-store';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

// Work admission reads the real load average on the light levels; keep this Mac's load out of the result.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, default: { ...actual, loadavg: () => [0, 0, 0] }, loadavg: () => [0, 0, 0] };
});
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const HOUR = 60 * 60_000;
const SOURCE = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'].join('\n') + '\n';

let parent: string;
let repo: string;
let driver: SqliteDriver;
let store: PlanQueueStore;
let run: PlanQueueRun;
let flow: PlanQueueItemFlow;
let host: PlanQueueFlowHost;
let notices: string[];
const git = (args: string[], cwd = repo): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hookLog = (): string => (existsSync(join(parent, 'hook.log')) ? readFileSync(join(parent, 'hook.log'), 'utf8') : '');
const gateLog = (): string => (existsSync(join(parent, 'gate.log')) ? readFileSync(join(parent, 'gate.log'), 'utf8') : '');
const rootEdit = (file: string, text = 'edited by hand\n'): void => writeFileSync(join(repo, file), text);
/** Promotion can't merge a staged file, so this is an edit that stops a landing before its commit is built. */
const stagedEdit = (file: string): void => { rootEdit(file); git(['add', '--', file]); };
const item = (id: string): PlanQueueItem => store.getItem(id)!;

function makeHost(): PlanQueueFlowHost {
  const save = (next: PlanQueueItem): PlanQueueItem => { store.upsertItem(next); return next; };
  return {
    store, history: {}, getRun: () => run, getItem: item, save,
    transition: (next: PlanQueueItem, state: PlanQueueItem['state'], patch: Partial<PlanQueueItem> = {}) => {
      assertItemTransition(next.state, state); return save({ ...next, ...patch, state });
    },
    notifyParent: (_run: PlanQueueRun, message: string) => { notices.push(message); },
    requestPump: () => undefined,
    worktrees: {
      checkpoint: async (next: PlanQueueItem) => save({ ...next, checkpointCommit: git(['rev-parse', 'HEAD'], next.worktreePath!) }),
      preflightPlanningFiles: async () => ({ moved: [], beside: [], failed: [] }),
      removeWithProof: async () => ({ removed: false, reason: 'retained', detail: 'test keeps the work folder' }),
    },
    tracker: { untrack: () => undefined, isTracked: () => false }, unregisterRole: () => undefined, registerRole: () => undefined,
    roleOf: () => undefined, instances: { getInstance: () => undefined, terminateInstance: async () => undefined },
  } as unknown as PlanQueueFlowHost;
}

/** Every test starts from its own copy of this repository, built once for the file. */
const baseRepository = useGitRepoTemplate((dir) => {
  repo = dir;
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Queue Test']); git(['config', 'user.email', 'queue@example.invalid']); git(['config', 'commit.gpgsign', 'false']);
  mkdirSync(join(repo, 'src')); mkdirSync(join(repo, 'gen')); mkdirSync(join(repo, 'scripts')); mkdirSync(join(repo, 'docs'));
  for (const file of ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/shared.ts']) writeFileSync(join(repo, file), SOURCE);
  writeFileSync(join(repo, 'gen/out.json'), '{}\n');
  writeFileSync(join(repo, 'docs/notes.md'), '# Notes\n');
  writeFileSync(join(repo, 'docs/register.md'), 'alpha\nbeta\ngamma\n');
  writeFileSync(join(repo, 'scripts/generated-artifacts.json'), JSON.stringify({ artifacts: ['gen/out.json'], generators: ['generate:out'] }));
  git(['add', '-A']); git(['commit', '-q', '-m', 'base']);
});

beforeEach(() => {
  GitWriteQueue._resetForTesting();
  parent = realpathSync(mkdtempSync(join(tmpdir(), 'queue-landing-wait-')));
  repo = join(parent, 'root');
  mkdirSync(repo);
  baseRepository.copyTo(repo);
  mkdirSync(join(parent, 'hooks'));
  writeFileSync(join(parent, 'hooks', 'pre-commit'), `#!/bin/sh\necho ran >> "${join(parent, 'hook.log')}"\n`);
  chmodSync(join(parent, 'hooks', 'pre-commit'), 0o755);
  // From here the hook runs only for a landing commit (the tests' own commits skip it), so its log shows exactly those.
  git(['config', 'core.hooksPath', join(parent, 'hooks')]);

  driver = new Database(':memory:') as unknown as SqliteDriver;
  driver.exec('PRAGMA foreign_keys = ON');
  runLoopMigrations(driver);
  store = new PlanQueueStore(driver);
  run = { id: 'run', parentInstanceId: 'parent', parentHistoryThreadId: null, kind: 'plans', workspaceCwd: repo, status: 'running',
    config: { ...DEFAULT_PLAN_QUEUE_CONFIG.plans, baseBranch: 'main', postMergeGate: [`echo ran >> "${join(parent, 'gate.log')}"`] },
    relaxation: null, workerProvider: null, workerModel: null, startedAt: 1, endedAt: null };
  store.upsertRun(run);
  notices = [];
  host = makeHost();
  flow = new PlanQueueItemFlow(host);
});

afterEach(async () => {
  try { await flow.whenSettled(); } finally {
    WorkAdmission._resetForTesting();
    driver.close();
    rmSync(parent, { recursive: true, force: true });
    GitWriteQueue._resetForTesting();
  }
});

/** A passed item in `landing`, whose branch has changed `files` in its own work folder. */
function landingItem(id: string, files: Record<string, string>, patch: Partial<PlanQueueItem> = {}): PlanQueueItem {
  const worktreePath = join(parent, `wt-${id}`);
  const branchName = `queue/${id}`;
  git(['worktree', 'add', '-qb', branchName, worktreePath, 'main']);
  for (const [file, text] of Object.entries(files)) writeFileSync(join(worktreePath, file), text);
  git(['add', '-A'], worktreePath); git(['commit', '--no-verify', '-qm', `work ${id}`], worktreePath);
  const base = git(['rev-parse', 'main']);
  const created = newPlanQueueItem(id, 'run', join(repo, `docs/${id}_plan.md`), 1, {
    state: 'landing', worktreePath, branchName, baseCommit: base, checkpointCommit: git(['rev-parse', 'HEAD'], worktreePath),
    verifiedMainCommit: base, round: 1,
    verdict: { verdict: 'PASS', findings: [], gatesRun: [], documentComplete: false, needJames: [] }, ...patch,
  });
  store.upsertItem(created);
  return created;
}

const LAST_LINE = SOURCE.trimEnd().split('\n').length - 1;
const withLine = (n: number, text: string): string => SOURCE.split('\n').map((line, index) => (index === n ? text : line)).join('\n');
const land = async (id: string): Promise<void> => { await flow.enqueueLanding(id); await flow.whenSettled(); };
const recheck = async (id: string): Promise<void> => { await flow.recheckLandingWait(id); await flow.whenSettled(); };

describe('4.1: where overlapping uncommitted changes come from (reproduction)', () => {
  // Recorded since 18 October (path names only, from the queue database and the commits that later took them in):
  // hand edits made in the root checkout by sessions working there and committed in bulk by James, plus the
  // Codex protocol snapshot the build rewrites whenever the installed Codex CLI changes, which the hook's own list
  // of generated files (scripts/generated-artifacts.json) does not cover.
  it.each([
    ['a source file edited by hand in the root checkout', 'src/a.ts', ' M'],
    ['the Codex protocol snapshot the build refreshes', 'src/main/cli/adapters/codex/generated/app-server-protocol.gen.ts', ' M'],
    ['a document edited and staged in the root checkout', 'docs/notes.md', 'M '],
  ])('promotion refuses %s, and the landing reports it as dirty-overlap', async (_label, file, status) => {
    if (file.includes('generated/')) {
      mkdirSync(join(repo, 'src/main/cli/adapters/codex/generated'), { recursive: true });
      writeFileSync(join(repo, file), 'snapshot v1\n'); git(['add', '-A']); git(['commit', '--no-verify', '-qm', 'snapshot']);
    }
    const branchWork = landingItem('repro', { [file]: file.endsWith('.md') ? '# Notes\n\nitem\n' : 'item version\n' });
    writeFileSync(join(repo, file), file.endsWith('.md') ? '# Notes\n\nmine\n' : 'rewritten by the build\n');
    if (status === 'M ') git(['add', file]);
    const before = git(['rev-parse', 'main']);

    const result = await landItemBranch(branchWork, repo, 'main', 'Plan: repro', []);

    expect(result).toMatchObject({ status: 'dirty-overlap', paths: [file] });
    expect(git(['rev-parse', 'main'])).toBe(before);
    expect(git(['status', '--porcelain', '--', file])).toBe(`${status} ${file}`.trim());
  });

  it('is found before the commit is built: only unstaged or untracked files and the hook\'s generated files are left to promotion', async () => {
    const blocked = landingItem('blocked', { 'src/a.ts': 'item\n', 'docs/notes.md': '# Notes\n\nitem\n', 'gen/out.json': '{"item":1}\n' });
    stagedEdit('src/a.ts'); rootEdit('docs/notes.md', '# Notes\n\nmine\n'); rootEdit('gen/out.json', '{"mine":1}\n');
    expect(await landingBlockers(blocked, run)).toEqual(['src/a.ts']);
    git(['reset', '-q', '--', 'src/a.ts']);
    expect(await landingBlockers(blocked, run)).toEqual(['src/a.ts']);
    git(['checkout', '--', 'src/a.ts']);
    expect(await landingBlockers(blocked, run)).toEqual([]);
    git(['add', 'docs/notes.md']);
    expect(await landingBlockers(blocked, run)).toEqual(['docs/notes.md']);
  });
});

describe('4.2: a blocked landing waits instead of parking', () => {
  it('waits without building the commit or running the hook, and holds nothing', async () => {
    landingItem('a', { 'src/a.ts': withLine(0, 'item') });
    stagedEdit('src/a.ts');
    const before = git(['rev-parse', 'main']);

    await land('a');

    expect(item('a')).toMatchObject({ state: 'landing', parkReason: null, landingWaitPaths: ['src/a.ts'], landedCommit: null });
    expect(item('a').landingWaitSince).toBeGreaterThan(0);
    expect(item('a').detail).toContain('src/a.ts');
    expect(hookLog()).toBe('');
    expect(git(['rev-parse', 'main'])).toBe(before);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('src/a.ts');
    // No item lock and no landing chain: the flow has nothing running, and another item lands straight away.
    expect(flow.hasActiveWork('a')).toBe(false);
    landingItem('b', { 'src/b.ts': withLine(0, 'item b') });
    await land('b');
    expect(item('b').state).toBe('landed');
    expect(item('a').state).toBe('landing');
  });

  it('lands alongside an unstaged code edit that merges cleanly, leaving the edit uncommitted', async () => {
    landingItem('a', { 'src/a.ts': withLine(0, 'item') });
    rootEdit('src/a.ts', withLine(LAST_LINE, 'mine'));

    await land('a');

    expect(item('a').state).toBe('landed');
    expect(git(['show', 'main:src/a.ts'])).toBe(withLine(0, 'item').trim());
    expect(readFileSync(join(repo, 'src/a.ts'), 'utf8')).toContain('mine');
    expect(git(['status', '--porcelain', '--', 'src/a.ts'])).toBe('M src/a.ts');
  });

  it('waits on an unstaged code edit that clashes, without spending the hook, until it clears', async () => {
    landingItem('a', { 'src/a.ts': withLine(0, 'item') });
    rootEdit('src/a.ts', withLine(0, 'mine'));

    await land('a');

    expect(item('a')).toMatchObject({ state: 'landing', parkReason: null, landingWaitPaths: ['src/a.ts'] });
    await recheck('a');
    expect(hookLog()).toBe('');
    expect(item('a').state).toBe('landing');
    git(['checkout', '--', 'src/a.ts']);
    await recheck('a');
    expect(item('a').state).toBe('landed');
  });

  it('keeps waiting without telling James again while the paths stay changed', async () => {
    landingItem('a', { 'src/a.ts': withLine(0, 'item') });
    stagedEdit('src/a.ts');
    await land('a');
    const since = item('a').landingWaitSince;
    await recheck('a'); await recheck('a');
    expect(item('a')).toMatchObject({ state: 'landing', landingWaitSince: since, landingWaitPaths: ['src/a.ts'] });
    expect(notices).toHaveLength(1);
    expect(hookLog()).toBe('');
  });

  it('wait, clear, lands', async () => {
    landingItem('a', { 'src/a.ts': withLine(0, 'item') });
    stagedEdit('src/a.ts');
    await land('a');
    git(['checkout', 'HEAD', '--', 'src/a.ts']);

    await recheck('a');

    expect(item('a')).toMatchObject({ state: 'landed' });
    expect(item('a').landingWaitSince).toBeUndefined();
    expect(item('a').landingWaitPaths).toBeUndefined();
    expect(git(['show', 'main:src/a.ts'])).toBe(withLine(0, 'item').trim());
    expect(hookLog()).toBe('ran\n');
    expect(notices).toHaveLength(1);
  });

  it('wait, main moves, resync: the base is brought in and the post-merge check runs before it lands', async () => {
    landingItem('a', { 'src/a.ts': withLine(0, 'item') });
    stagedEdit('src/a.ts');
    await land('a');
    git(['checkout', 'HEAD', '--', 'src/a.ts']);
    writeFileSync(join(repo, 'unrelated.txt'), 'another item landed\n'); git(['add', 'unrelated.txt']); git(['commit', '--no-verify', '-qm', 'main moved']);
    expect(gateLog()).toBe('');

    await recheck('a');

    expect(item('a').state).toBe('landed');
    expect(gateLog()).toBe('ran\n');
    expect(git(['show', 'main:unrelated.txt'])).toBe('another item landed');
    expect(git(['show', 'main:src/a.ts'])).toBe(withLine(0, 'item').trim());
  });

  it('wait, timeout, park: after 24 hours the item parks land-blocked and the wait is gone', async () => {
    landingItem('a', { 'src/a.ts': withLine(0, 'item') });
    stagedEdit('src/a.ts');
    await land('a');
    store.upsertItem({ ...item('a'), landingWaitSince: Date.now() - LANDING_WAIT_LIMIT_MS - HOUR });

    await recheck('a');

    expect(item('a')).toMatchObject({ state: 'parked', parkReason: 'land-blocked' });
    expect(item('a').detail).toContain('24 hours');
    expect(item('a').detail).toContain('Try merging again');
    expect(item('a').landingWaitPaths).toBeUndefined();
    expect(item('a').landingWaitSince).toBeUndefined();
    expect(hookLog()).toBe('');
  });

  it('counts the 24 hours from the first wait, not from the latest attempt', async () => {
    // A crash or an attempt after the paths cleared leaves the time but no paths; the paths are in the way again.
    landingItem('a', { 'src/a.ts': withLine(0, 'item') }, { landingWaitSince: Date.now() - LANDING_WAIT_LIMIT_MS - HOUR, landingWaitPaths: [] });
    stagedEdit('src/a.ts');

    await land('a');

    expect(item('a')).toMatchObject({ state: 'parked', parkReason: 'land-blocked' });
    expect(item('a').detail).toContain('24 hours');
  });

  it('a wait that clears and is blocked again keeps its first time and does not tell James twice', async () => {
    const since = Date.now() - 3 * HOUR;
    landingItem('a', { 'src/a.ts': withLine(0, 'item') }, { landingWaitSince: since, landingWaitPaths: [] });
    stagedEdit('src/a.ts');

    await land('a');

    expect(item('a')).toMatchObject({ state: 'landing', landingWaitSince: since, landingWaitPaths: ['src/a.ts'] });
    expect(notices).toEqual([]);
  });

  it('a fourth waiter parks land-blocked instead of waiting', async () => {
    const files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
    files.forEach((file, index) => { landingItem(`w${index}`, { [file]: withLine(0, `item ${index}`) }); rootEdit(file); });
    for (let index = 0; index < MAX_LANDING_WAITERS; index += 1) await land(`w${index}`);
    expect([0, 1, 2].map((index) => item(`w${index}`).state)).toEqual(['landing', 'landing', 'landing']);

    await land('w3');

    expect(item('w3')).toMatchObject({ state: 'parked', parkReason: 'land-blocked' });
    expect(item('w3').detail).toContain('already waiting');
    expect(item('w3').landingWaitPaths).toBeUndefined();
    expect(notices).toHaveLength(MAX_LANDING_WAITERS);
  });

  it('waits on a same-line Markdown conflict the merge helper refuses, and is not retried while the file stays changed', async () => {
    landingItem('doc', { 'docs/register.md': 'alpha\nitem beta\ngamma\n' });
    writeFileSync(join(repo, 'docs/register.md'), 'alpha\nmy beta\ngamma\n');

    await land('doc');

    expect(item('doc')).toMatchObject({ state: 'landing', landingWaitPaths: ['docs/register.md'] });
    await recheck('doc'); await recheck('doc');
    expect(item('doc')).toMatchObject({ state: 'landing', landingWaitPaths: ['docs/register.md'] });
    expect(hookLog()).toBe('');

    git(['checkout', '--', 'docs/register.md']);
    await recheck('doc');
    expect(item('doc').state).toBe('landed');
    expect(git(['show', 'main:docs/register.md'])).toContain('item beta');
  });

  it('Land anyway never waits, because the pump\'s later attempt would not know it was an override', async () => {
    landingItem('a', { 'src/a.ts': withLine(0, 'item') });
    stagedEdit('src/a.ts');

    await flow.enqueueLanding('a', { landAnywayBy: 'on a test' }); await flow.whenSettled();

    expect(item('a')).toMatchObject({ state: 'parked', parkReason: 'land-blocked' });
    expect(item('a').detail).toContain('src/a.ts');
  });

  it('keeps the wait through Pause, and the 24-hour clock keeps running while paused', async () => {
    landingItem('a', { 'src/a.ts': withLine(0, 'item') });
    stagedEdit('src/a.ts');
    await land('a');

    run.status = 'paused';
    await flow.hold('a');
    expect(item('a')).toMatchObject({ state: 'landing', landingWaitPaths: ['src/a.ts'] });
    git(['checkout', 'HEAD', '--', 'src/a.ts']);
    await recheck('a');
    expect(item('a')).toMatchObject({ state: 'landing', landingWaitPaths: ['src/a.ts'] });
    expect(hookLog()).toBe('');

    store.upsertItem({ ...item('a'), landingWaitSince: Date.now() - LANDING_WAIT_LIMIT_MS - HOUR });
    stagedEdit('src/a.ts');
    run.status = 'running';
    await recheck('a');
    expect(item('a')).toMatchObject({ state: 'parked', parkReason: 'land-blocked' });
  });

  it('hands a wait it can no longer compare to the landing, which parks it with the real reason', async () => {
    landingItem('a', { 'src/a.ts': withLine(0, 'item') });
    stagedEdit('src/a.ts');
    await land('a');
    const before = { ...run };
    run.config = { ...run.config, baseBranch: 'renamed-away' };

    await recheck('a');

    expect(item('a').state).toBe('parked');
    run.config = before.config;
  });

  it('lands a job whose paths cleared even when the 24 hours ran out while paused, rather than saying they are still changed', async () => {
    landingItem('a', { 'src/a.ts': withLine(0, 'item') });
    stagedEdit('src/a.ts');
    await land('a');
    git(['checkout', 'HEAD', '--', 'src/a.ts']);
    store.upsertItem({ ...item('a'), landingWaitSince: Date.now() - LANDING_WAIT_LIMIT_MS - HOUR });

    await recheck('a');

    expect(item('a').state).toBe('landed');
  });

  it('lands once the run resumes and the paths are clear', async () => {
    landingItem('a', { 'src/a.ts': withLine(0, 'item') });
    stagedEdit('src/a.ts');
    await land('a');
    run.status = 'paused';
    await flow.hold('a');
    git(['checkout', 'HEAD', '--', 'src/a.ts']);
    run.status = 'running';

    await recheck('a');

    expect(item('a').state).toBe('landed');
  });

  describe('restart', () => {
    const recovery = (): PlanQueueRecoveryHost => ({
      ...host, store, applyRelaxation: () => undefined, restoreRelaxation: (value: PlanQueueRun) => value, refreshAlerts: async () => [],
      worktrees: { ...host.worktrees, cleanupScratchCopies: async () => undefined },
    } as unknown as PlanQueueRecoveryHost);

    it('re-checks a waiting landing first: still blocked stays waiting, then clear lands', async () => {
      landingItem('a', { 'src/a.ts': withLine(0, 'item') });
      stagedEdit('src/a.ts');
      await land('a');
      const since = item('a').landingWaitSince;
      await flow.whenSettled();

      flow = new PlanQueueItemFlow(host);
      await recoverPlanQueue(recovery(), flow); await flow.whenSettled();
      expect(item('a')).toMatchObject({ state: 'landing', landingWaitSince: since, landingWaitPaths: ['src/a.ts'] });
      expect(hookLog()).toBe('');
      expect(notices).toHaveLength(1);

      git(['checkout', 'HEAD', '--', 'src/a.ts']);
      flow = new PlanQueueItemFlow(host);
      await recoverPlanQueue(recovery(), flow); await flow.whenSettled();
      expect(item('a').state).toBe('landed');
    });

    it('crash window: the wait was cleared but the landing never ran, so recovery lands it', async () => {
      landingItem('a', { 'src/a.ts': withLine(0, 'item') }, { landingWaitSince: Date.now() - HOUR, landingWaitPaths: [] });

      flow = new PlanQueueItemFlow(host);
      await recoverPlanQueue(recovery(), flow); await flow.whenSettled();

      expect(item('a').state).toBe('landed');
    });

    it('a waiting landing in a paused run stays waiting after a restart', async () => {
      landingItem('a', { 'src/a.ts': withLine(0, 'item') });
      stagedEdit('src/a.ts');
      await land('a');
      run.status = 'paused';
      git(['checkout', 'HEAD', '--', 'src/a.ts']);

      flow = new PlanQueueItemFlow(host);
      await recoverPlanQueue(recovery(), flow); await flow.whenSettled();

      expect(item('a')).toMatchObject({ state: 'landing', landingWaitPaths: ['src/a.ts'] });
    });
  });

  it('two items waiting on the same file both land once it is clear, the second after resyncing with the first', async () => {
    landingItem('first', { 'src/shared.ts': withLine(0, 'first change') });
    landingItem('second', { 'src/shared.ts': withLine(6, 'second change') });
    stagedEdit('src/shared.ts');
    await land('first'); await land('second');
    expect([item('first').state, item('second').state]).toEqual(['landing', 'landing']);
    expect(notices).toHaveLength(2);
    git(['checkout', 'HEAD', '--', 'src/shared.ts']);

    await recheck('first'); await recheck('second');

    expect([item('first').state, item('second').state]).toEqual(['landed', 'landed']);
    const landed = git(['show', 'main:src/shared.ts']).split('\n');
    expect(landed[0]).toBe('first change');
    expect(landed[6]).toBe('second change');
  });

  describe('what a waiting landing counts as', () => {
    it('does not keep the Mac awake, but does again once its landing attempt is running', async () => {
      landingItem('a', { 'src/a.ts': withLine(0, 'item') });
      expect(store.hasActiveWork()).toBe(true);
      stagedEdit('src/a.ts');
      await land('a');
      expect(store.hasActiveWork()).toBe(false);

      landingItem('b', { 'src/b.ts': withLine(0, 'item b') });
      expect(store.hasActiveWork()).toBe(true);
      store.upsertItem({ ...item('b'), state: 'parked', parkReason: 'land-blocked' });
      expect(store.hasActiveWork()).toBe(false);

      store.upsertItem({ ...item('a'), landingWaitPaths: [] });
      expect(store.hasActiveWork()).toBe(true);
    });

    it('is not worker or check work to the flow either', async () => {
      landingItem('a', { 'src/a.ts': withLine(0, 'item') });
      stagedEdit('src/a.ts');
      await land('a');
      expect(flow.hasActiveWork('a')).toBe(false);
    });

    it('frees its worker slot when it starts waiting, and not again when it leaves', () => {
      const freed = vi.spyOn(store.waits, 'freed');
      landingItem('a', { 'src/a.ts': withLine(0, 'item') });
      store.upsertItem({ ...item('a'), landingWaitSince: 5, landingWaitPaths: ['src/a.ts'] });
      expect(freed.mock.calls).toEqual([['worker']]);
      store.upsertItem({ ...item('a'), state: 'landed' });
      expect(freed.mock.calls).toEqual([['worker']]);
      landingItem('b', { 'src/b.ts': withLine(0, 'item b') });
      store.upsertItem({ ...item('b'), state: 'landed' });
      expect(freed.mock.calls).toEqual([['worker'], ['worker']]);
    });

    it('drops the wait from the saved row as soon as the item leaves landing', () => {
      landingItem('a', { 'src/a.ts': withLine(0, 'item') }, { landingWaitSince: 5, landingWaitPaths: ['src/a.ts'] });
      expect(item('a')).toMatchObject({ landingWaitSince: 5, landingWaitPaths: ['src/a.ts'] });
      store.upsertItem({ ...item('a'), state: 'awaiting-slot' });
      expect(item('a').landingWaitPaths).toBeUndefined();
      expect(item('a').landingWaitSince).toBeUndefined();
    });

    describe('in the pump', () => {
      const pump = (starts: string[]) => pumpPlanQueue({
        store,
        flow: { startItem: async (queued: PlanQueueItem) => { starts.push(queued.id); }, startVerification: async () => undefined,
          isWaitingForUsage: () => false, isClaimed: () => false, breaker: { canStart: () => true, started: () => undefined } as never, finishLandingCleanup: async () => undefined, keptFolders: { retryDue: () => undefined }, discardedRefs: { sweepDue: () => undefined }, landingRetries: { retryDue: async () => undefined }, checklistTurns: new Set<string>(),
          recheckLandingWait: (id: string) => flow.recheckLandingWait(id) },
        triage: null, getRun: () => run, getItem: item, transition: (next, state, patch) => host.transition(next, state, patch),
        notifyParent: () => undefined, resolveRunParent: () => 'chat', loadAverage: () => [0, 0, 0], queueFolderLimit: () => 0, followParent: (value) => value,
        isShuttingDown: () => false, isControlling: () => false, finishRun: () => undefined, announceRun: () => undefined,
        logItemError: (_item, error) => { throw error; },
      });
      const queuedDocument = (id: string): void => {
        writeFileSync(join(repo, `docs/${id}_plan.md`), '# Work\n');
        store.upsertItem(newPlanQueueItem(id, 'run', join(repo, `docs/${id}_plan.md`), 9, { state: 'queued' }));
      };

      it('frees the worker slot for the next document', async () => {
        run.config = { ...run.config, workerSlots: 1 };
        landingItem('a', { 'src/a.ts': withLine(0, 'item') });
        stagedEdit('src/a.ts');
        await land('a');
        queuedDocument('next');
        getWorkAdmission().setWorkloadLevel(5);
        const starts: string[] = [];

        await pump(starts);

        expect(starts).toEqual(['next']);
      });

      it('still counts toward the hard work-folder limit, because it keeps its folder', async () => {
        landingItem('a', { 'src/a.ts': withLine(0, 'item') });
        stagedEdit('src/a.ts');
        await land('a');
        queuedDocument('next');
        getWorkAdmission().setWorkloadLevel(1);
        const starts: string[] = [];

        await pump(starts);

        expect(starts).toEqual([]);
      });

      it('checks a waiting landing again each cycle, even while another item still has cleanup to finish', async () => {
        landingItem('a', { 'src/a.ts': withLine(0, 'item') });
        stagedEdit('src/a.ts');
        await land('a');
        // A landed item whose sessions have not been stopped yet makes the pump skip the whole run's scheduling.
        store.upsertItem(newPlanQueueItem('done', 'run', join(repo, 'docs/done_plan.md'), 2, { state: 'landed', workerInstanceId: 'old-session' }));
        git(['checkout', 'HEAD', '--', 'src/a.ts']);

        await pump([]);
        await flow.whenSettled();

        expect(item('a').state).toBe('landed');
      });

      it('does not check a waiting landing while the run is paused', async () => {
        landingItem('a', { 'src/a.ts': withLine(0, 'item') });
        stagedEdit('src/a.ts');
        await land('a');
        git(['checkout', 'HEAD', '--', 'src/a.ts']);
        run.status = 'paused';

        await pump([]);
        await flow.whenSettled();

        expect(item('a')).toMatchObject({ state: 'landing', landingWaitPaths: ['src/a.ts'] });
      });
    });
  });
});
