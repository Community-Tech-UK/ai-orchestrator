import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISCARDED_REF_PREFIX, DISCARDED_WORK_KEPT_MS, keepDiscardedWork, PlanQueueDiscardedRefs, restoreBeforeResume, restoreDiscardedWork } from './plan-queue-discard';
import { RESCUE_REF_PREFIX } from './plan-queue-landing-leftover';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import { planQueueBranchName } from './plan-queue-worktree';

let repo: string;
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
const write = (file: string, content: string) => fs.writeFileSync(path.join(repo, file), content);
const commit = (message: string) => { git('add', '-A'); git('commit', '-qm', message); };
const run = () => ({ id: 'run', workspaceCwd: repo, config: { baseBranch: 'main' } }) as unknown as PlanQueueRun;
const item = (overrides: Partial<PlanQueueItem> = {}) => ({
  id: 'item-1', runId: 'run', documentPath: path.join(repo, 'docs/alpha_plan.md'), state: 'parked',
  branchName: null, worktreePath: null, checkpointCommit: null, detail: null, ...overrides,
}) as PlanQueueItem;
const ref = (id = 'item-1') => `${DISCARDED_REF_PREFIX}${id}`;
const refExists = (name: string) => git('for-each-ref', '--format=%(refname)', name) === name;

function branchWithWork(): { branchName: string; tip: string } {
  const branchName = planQueueBranchName(item());
  git('checkout', '-qb', branchName, 'main');
  write('work.ts', 'finished work\n');
  commit('work');
  const tip = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  return { branchName, tip };
}

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-discard-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  write('app.ts', 'one\n');
  commit('start');
});

afterEach(() => { fs.rmSync(repo, { recursive: true, force: true }); });

describe('keepDiscardedWork', () => {
  it('keeps a branch that holds work, dated from now', async () => {
    const { branchName, tip } = branchWithWork();
    expect(await keepDiscardedWork(item({ branchName }), run(), 1000)).toBe(1000 + DISCARDED_WORK_KEPT_MS);
    expect(git('rev-parse', ref())).toBe(tip);
  });

  it('keeps a checkpoint when the branch is already gone', async () => {
    const { branchName, tip } = branchWithWork();
    git('branch', '-qD', branchName);
    expect(await keepDiscardedWork(item({ checkpointCommit: tip }), run(), 1000)).not.toBeNull();
    expect(git('rev-parse', ref())).toBe(tip);
  });

  it('keeps nothing for a job proved to hold nothing, so a bulk clear stays cheap', async () => {
    const { branchName } = branchWithWork();
    git('merge', '-q', '--ff-only', branchName);
    expect(await keepDiscardedWork(item({ branchName }), run(), 1000)).toBeNull();
    expect(await keepDiscardedWork(item(), run(), 1000)).toBeNull();
    expect(refExists(ref())).toBe(false);
  });

  it('stops the discard when a branch about to be deleted cannot be kept', async () => {
    const { branchName } = branchWithWork();
    await expect(keepDiscardedWork(item({ id: 'bad..id', branchName }), run(), 1000)).rejects.toThrow('could not be kept');
  });

  it('does not stop for a checkpoint that cannot be kept, because nothing is being deleted', async () => {
    expect(await keepDiscardedWork(item({ checkpointCommit: 'f'.repeat(40) }), run(), 1000)).toBeNull();
  });

  it('does not replace the kept tip with an older checkpoint after a crash mid-discard', async () => {
    const { branchName, tip } = branchWithWork();
    const older = git('rev-parse', 'main');
    await keepDiscardedWork(item({ branchName }), run(), 1000);
    git('branch', '-qD', branchName);
    expect(await keepDiscardedWork(item({ checkpointCommit: older }), run(), 2000)).toBe(2000 + DISCARDED_WORK_KEPT_MS);
    expect(git('rev-parse', ref())).toBe(tip);
  });
});

describe('restoreDiscardedWork', () => {
  const hostFor = (start: PlanQueueItem) => {
    let current = start;
    return {
      host: { getItem: () => current, getRun: run, save: (next: PlanQueueItem) => { current = next; return next; } },
      saved: () => current,
    };
  };

  it('puts the same commit back on its branch and clears the record', async () => {
    const { branchName, tip } = branchWithWork();
    await keepDiscardedWork(item({ branchName }), run(), 1000);
    git('branch', '-qD', branchName);
    const { host, saved } = hostFor(item({ discardedAt: 1000, discardedBy: 'James', discardRefExpiresAt: 2000 }));

    await restoreDiscardedWork(host, 'item-1');

    expect(git('rev-parse', branchName)).toBe(tip);
    expect(saved()).toMatchObject({ branchName, discardedAt: null, discardedBy: null, discardRefExpiresAt: null });
    expect(refExists(ref())).toBe(false);
  });

  it('finishes a restore that stopped after making the branch', async () => {
    const { branchName, tip } = branchWithWork();
    await keepDiscardedWork(item({ branchName }), run(), 1000);
    const { host, saved } = hostFor(item({ discardedAt: 1000 }));

    await restoreDiscardedWork(host, 'item-1');

    expect(git('rev-parse', branchName)).toBe(tip);
    expect(saved().branchName).toBe(branchName);
  });

  it('brings kept work back before a Resume, and does nothing when none was kept', async () => {
    const { host } = hostFor(item({ discardedAt: 1000 }));
    await restoreBeforeResume(host, 'item-1');
    expect(host.getItem().discardedAt).toBe(1000);

    const { branchName, tip } = branchWithWork();
    git('update-ref', ref(), tip);
    git('branch', '-qD', branchName);
    await restoreBeforeResume(host, 'item-1');

    expect(git('rev-parse', branchName)).toBe(tip);
    expect(host.getItem()).toMatchObject({ branchName, discardedAt: null });
  });

  it('refuses when no work was kept anywhere', async () => {
    const { host } = hostFor(item({ discardedAt: 1000 }));
    await expect(restoreDiscardedWork(host, 'item-1')).rejects.toThrow('was not kept');
  });

  it('uses the job\'s branch when it has moved on, and keeps the older copy', async () => {
    const { host } = hostFor(item({ discardedAt: 1000 }));
    const { tip } = branchWithWork();
    const older = git('rev-parse', 'main');
    git('update-ref', ref(), older);

    await restoreDiscardedWork(host, 'item-1');

    expect(git('rev-parse', ref())).toBe(older);
    expect(git('rev-parse', planQueueBranchName(item()))).toBe(tip);
  });

  it('refuses a job that was not discarded', async () => {
    await expect(restoreDiscardedWork(hostFor(item()).host, 'item-1')).rejects.toThrow('Only a discarded job');
  });
});

describe('PlanQueueDiscardedRefs', () => {
  const lock = (_id: string, action: () => Promise<void>) => action();
  const sweeper = (items: PlanQueueItem[]) => {
    const save = vi.fn((next: PlanQueueItem) => {
      items[items.findIndex(candidate => candidate.id === next.id)] = next;
      return next;
    });
    const refs = new PlanQueueDiscardedRefs({
      store: { getItem: (id: string) => items.find(candidate => candidate.id === id) ?? null },
      save,
    } as never, lock);
    return { refs, save };
  };
  const keep = (id: string) => git('update-ref', ref(id), git('rev-parse', 'main'));

  it('removes only references past their date', async () => {
    keep('old');
    keep('new');
    const items = [item({ id: 'old', discardedAt: 1, discardRefExpiresAt: 100 }), item({ id: 'new', discardedAt: 1, discardRefExpiresAt: 500 })];
    const { refs } = sweeper(items);

    await refs.sweep([repo], 200);

    expect(refExists(ref('old'))).toBe(false);
    expect(refExists(ref('new'))).toBe(true);
    expect(items[0].discardRefExpiresAt).toBeNull();
  });

  it('dates a reference that has no date instead of removing it', async () => {
    keep('undated');
    const items = [item({ id: 'undated', discardedAt: 1, discardRefExpiresAt: null })];

    await sweeper(items).refs.sweep([repo], 200);

    expect(refExists(ref('undated'))).toBe(true);
    expect(items[0].discardRefExpiresAt).toBe(200 + DISCARDED_WORK_KEPT_MS);
  });

  it('leaves a reference whose job is unknown, because there is no date to go by', async () => {
    keep('nobody');
    await sweeper([]).refs.sweep([repo], 200);
    expect(refExists(ref('nobody'))).toBe(true);
  });

  it('removes a reference left by a restore that stopped, once the branch holds the same commit', async () => {
    keep('restored');
    const job = item({ id: 'restored', discardedAt: null });
    git('branch', planQueueBranchName(job), 'main');
    await sweeper([job]).refs.sweep([repo], 200);
    expect(refExists(ref('restored'))).toBe(false);
  });

  it('keeps the only copy when a discard stopped after deleting the branch but before recording it', async () => {
    keep('half-discarded');
    await sweeper([item({ id: 'half-discarded', discardedAt: null })]).refs.sweep([repo], 200);
    expect(refExists(ref('half-discarded'))).toBe(true);
  });

  it('keeps a reference whose commit differs from a branch of the same name', async () => {
    const { branchName } = branchWithWork();
    git('update-ref', ref(), git('rev-parse', 'main'));
    await sweeper([item({ discardedAt: null, branchName })]).refs.sweep([repo], 200);
    expect(refExists(ref())).toBe(true);
  });

  it('never touches rescue references, which hold James\'s own files', async () => {
    const rescue = `${RESCUE_REF_PREFIX}item-1-1`;
    git('update-ref', rescue, git('rev-parse', 'main'));
    await sweeper([item({ discardedAt: 1, discardRefExpiresAt: 1 })]).refs.sweep([repo], 200);
    expect(refExists(rescue)).toBe(true);
  });

  it('skips a folder that has gone and sweeps the rest', async () => {
    keep('old');
    await sweeper([item({ id: 'old', discardedAt: 1, discardRefExpiresAt: 100 })]).refs.sweep(['/no/such/folder', repo], 200);
    expect(refExists(ref('old'))).toBe(false);
  });

  it('sweeps once an hour', () => {
    const { refs } = sweeper([]);
    const folders = vi.fn(() => [] as string[]);
    refs.sweepDue(folders, 1000);
    refs.sweepDue(folders, 2000);
    expect(folders).toHaveBeenCalledTimes(1);
    refs.sweepDue(folders, 1000 + 60 * 60_000);
    expect(folders).toHaveBeenCalledTimes(2);
  });
});
