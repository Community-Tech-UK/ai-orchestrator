import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as gitCommands from '../workspace/git/git-exec';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { WorktreeManager } from '../workspace/git/worktree-manager';
import { LANDING_MARKER_FILE, RESCUE_REF_PREFIX } from './plan-queue-landing-leftover';
import { landItemBranch } from './plan-queue-landing';
import { buildLandingCommit, returnToItemCheckout } from './plan-queue-squash';
import { PlanQueueCheckoutOwnershipError, PlanQueueWorktreeService } from './plan-queue-worktree';
import type { PlanQueueItem } from './plan-queue.types';

// Real git through many child processes, like the other real-git specs.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let repo: string;
let saved: PlanQueueItem[];
let service: PlanQueueWorktreeService;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function makeItem(): PlanQueueItem {
  return {
    id: 'item-abc123', runId: 'run-1', documentPath: join(repo, 'docs/plans/2026-01-01-sample_plan.md'),
    state: 'preparing', round: 0, erroredRounds: 0, landingRefusals: 0, branchName: null, worktreePath: null,
    baseCommit: null, checkpointCommit: null, verifiedMainCommit: null, landedCommit: null,
    workerInstanceId: null, verifierInstanceId: null, question: null, answer: null, parkReason: null,
    detail: null, verdict: null, createdAt: 1, updatedAt: 1,
  };
}

/** An item whose branch adds two files and changes a.txt, checkpointed. */
async function itemWithWork(): Promise<PlanQueueItem> {
  const item = await service.prepare(makeItem(), repo);
  const wt = item.worktreePath!;
  writeFileSync(join(wt, 'a.txt'), 'item\n');
  writeFileSync(join(wt, 'one.txt'), 'one\n');
  writeFileSync(join(wt, 'two.txt'), 'two\n');
  return service.checkpoint(item, 'work');
}

/**
 * What a killed squash or restore leaves: HEAD detached at main by the queue's
 * own `checkout --detach <hash>`, and the files half-way between the two trees.
 */
function strandAsLanding(item: PlanQueueItem): void {
  const wt = item.worktreePath!;
  git(['checkout', '-q', '--detach', git(['rev-parse', 'main'])], wt);
  writeFileSync(join(wt, 'one.txt'), 'one\n');
}

beforeEach(() => {
  WorktreeManager._resetForTesting();
  GitWriteQueue._resetForTesting();
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-leftover-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Plan Queue Test']);
  git(['config', 'user.email', 'plan-queue@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  writeFileSync(join(repo, 'b.txt'), 'shared\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  saved = [];
  service = new PlanQueueWorktreeService({ creator: WorktreeManager.getInstance(), saveItem: (item) => saved.push(item), skipInstall: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(repo, { recursive: true, force: true });
  WorktreeManager._resetForTesting();
  GitWriteQueue._resetForTesting();
});

describe('a checkout an interrupted landing left detached', () => {
  it('is put back on its branch by the next checkpoint, with nothing new committed', async () => {
    const item = await itemWithWork();
    strandAsLanding(item);

    const after = await service.checkpoint(item, 'paused');

    const wt = item.worktreePath!;
    expect(git(['symbolic-ref', '--short', 'HEAD'], wt)).toBe(item.branchName);
    expect(after.checkpointCommit).toBe(item.checkpointCommit);
    expect(git(['status', '--porcelain'], wt)).toBe('?? .mise.local.toml');
    expect(readFileSync(join(wt, 'two.txt'), 'utf8')).toBe('two\n');
    expect(after.detail).toBeNull();
    expect(git(['for-each-ref', RESCUE_REF_PREFIX])).toBe('');
  });

  it('sets aside files matching neither side, so cut-short and edited files never reach the branch', async () => {
    const item = await itemWithWork();
    strandAsLanding(item);
    const wt = item.worktreePath!;
    writeFileSync(join(wt, 'two.txt'), 'tw'); // a branch file a killed checkout left cut short
    writeFileSync(join(wt, 'late.txt'), 'written while detached\n');
    unlinkSync(join(wt, 'b.txt'));

    const after = await service.checkpoint(item, 'paused');

    const [rescueRef] = git(['for-each-ref', '--format=%(refname)', RESCUE_REF_PREFIX]).split('\n');
    expect(rescueRef).toMatch(new RegExp(`^${RESCUE_REF_PREFIX}item-abc123-\\d+$`));
    expect(git(['show', `${rescueRef}:late.txt`])).toBe('written while detached');
    expect(git(['show', `${rescueRef}:two.txt`])).toBe('tw');
    expect(git(['symbolic-ref', '--short', 'HEAD'], wt)).toBe(item.branchName);
    expect(after.checkpointCommit).toBe(item.checkpointCommit);
    expect(readFileSync(join(wt, 'two.txt'), 'utf8')).toBe('two\n');
    expect(readFileSync(join(wt, 'b.txt'), 'utf8')).toBe('shared\n');
    expect(existsSync(join(wt, 'late.txt'))).toBe(false);
    expect(git(['status', '--porcelain'], wt)).toBe('?? .mise.local.toml');
    expect(after.detail).toContain(rescueRef);
  });

  it('never commits the conflict markers of a squash interrupted mid-conflict', async () => {
    const item = await itemWithWork();
    const wt = item.worktreePath!;
    writeFileSync(join(repo, 'a.txt'), 'main\n');
    git(['commit', '-q', '-am', 'main moved']);
    git(['checkout', '-q', '--detach', git(['rev-parse', 'main'])], wt);
    expect(() => git(['merge', '--squash', '-q', item.branchName!], wt)).toThrow();
    expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toContain('<<<<<<<');

    const after = await service.checkpoint(item, 'before resume');

    expect(git(['symbolic-ref', '--short', 'HEAD'], wt)).toBe(item.branchName);
    expect(git(['show', `${after.checkpointCommit}:a.txt`])).toBe('item');
    expect(git(['status', '--porcelain'], wt)).toBe('?? .mise.local.toml');
  });

  it('removes base files a restore killed after writing the index left untracked', async () => {
    let item = await itemWithWork();
    const wt = item.worktreePath!;
    git(['rm', '-q', 'b.txt'], wt);
    item = await service.checkpoint(item, 'drop b');
    strandAsLanding(item);
    git(['read-tree', item.branchName!], wt); // the index already the branch's; HEAD and disk still the base's

    const after = await service.checkpoint(item, 'paused');

    expect(git(['symbolic-ref', '--short', 'HEAD'], wt)).toBe(item.branchName);
    expect(after.checkpointCommit).toBe(item.checkpointCommit);
    expect(existsSync(join(wt, 'b.txt'))).toBe(false);
    expect(git(['status', '--porcelain'], wt)).toBe('?? .mise.local.toml');
  });

  it('puts back a folder a detach stopped before it moved HEAD, using the landing marker', async () => {
    const item = await itemWithWork();
    const wt = item.worktreePath!;
    writeFileSync(join(repo, 'main-only.txt'), 'main\n');
    git(['add', 'main-only.txt']);
    git(['commit', '-q', '-m', 'main moved']);
    writeFileSync(join(git(['rev-parse', '--absolute-git-dir'], wt), LANDING_MARKER_FILE), git(['rev-parse', 'main']));
    writeFileSync(join(wt, 'a.txt'), 'base\n');
    writeFileSync(join(wt, 'main-only.txt'), 'main\n');

    const after = await service.checkpoint(item, 'paused');

    expect(after.checkpointCommit).toBe(item.checkpointCommit);
    expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toBe('item\n');
    expect(existsSync(join(wt, 'main-only.txt'))).toBe(false);
    expect(existsSync(join(git(['rev-parse', '--absolute-git-dir'], wt), LANDING_MARKER_FILE))).toBe(false);
    expect(git(['for-each-ref', RESCUE_REF_PREFIX])).toBe('');
  });

  it('changes nothing and says why when the folder holds a separate Git repository', async () => {
    const item = await itemWithWork();
    strandAsLanding(item);
    const wt = item.worktreePath!;
    mkdirSync(join(wt, 'nested'));
    git(['init', '-q'], join(wt, 'nested'));
    writeFileSync(join(wt, 'late.txt'), 'edit\n');

    await expect(service.checkpoint(item, 'paused')).rejects.toThrow(/separate Git repository at nested\//);

    expect(() => git(['symbolic-ref', '-q', 'HEAD'], wt)).toThrow();
    expect(readFileSync(join(wt, 'late.txt'), 'utf8')).toBe('edit\n');
    expect(git(['for-each-ref', RESCUE_REF_PREFIX])).toBe('');
  });

  it('is put back by reattach when the folder was kept', async () => {
    const item = await itemWithWork();
    strandAsLanding(item);

    const reattached = await service.reattach({ ...item, state: 'preparing' }, repo);

    expect(git(['symbolic-ref', '--short', 'HEAD'], item.worktreePath!)).toBe(item.branchName);
    expect(reattached.checkpointCommit).toBe(item.checkpointCommit);
  });

  it('is refused untouched when something was committed after the detach', async () => {
    const item = await itemWithWork();
    strandAsLanding(item);
    const wt = item.worktreePath!;
    git(['add', '-A'], wt);
    git(['commit', '-q', '-m', 'made while detached'], wt);
    const head = git(['rev-parse', 'HEAD'], wt);

    await expect(service.checkpoint(item, 'paused')).rejects.toBeInstanceOf(PlanQueueCheckoutOwnershipError);

    expect(git(['rev-parse', 'HEAD'], wt)).toBe(head);
    expect(() => git(['symbolic-ref', '-q', 'HEAD'], wt)).toThrow();
  });

  it('is refused untouched when the detach was not the queue leaving this branch', async () => {
    const item = await itemWithWork();
    const wt = item.worktreePath!;
    git(['checkout', '-q', '--detach', 'main'], wt);

    await expect(service.checkpoint(item, 'paused')).rejects.toBeInstanceOf(PlanQueueCheckoutOwnershipError);

    expect(git(['rev-parse', 'HEAD'], wt)).toBe(git(['rev-parse', 'main']));
  });

  it('is refused untouched at the start of a landing too, instead of being forced back', async () => {
    const item = await itemWithWork();
    const wt = item.worktreePath!;
    git(['checkout', '-q', '--detach', 'main'], wt);
    writeFileSync(join(wt, 'edit.txt'), 'edit\n');

    await expect(returnToItemCheckout(wt, item.branchName!, item.id)).rejects.toBeInstanceOf(PlanQueueCheckoutOwnershipError);

    expect(git(['rev-parse', 'HEAD'], wt)).toBe(git(['rev-parse', 'main']));
    expect(readFileSync(join(wt, 'edit.txt'), 'utf8')).toBe('edit\n');
  });
});

describe('landing', () => {
  it('says the work is safe when the restore fails, and the next checkpoint puts the folder back', async () => {
    const item = await itemWithWork();
    const wt = item.worktreePath!;
    const runGit = gitCommands.gitExec;
    vi.spyOn(gitCommands, 'gitExec').mockImplementation((args, cwd, deadline) =>
      args[0] === 'checkout' && args[1] === '-f'
        ? Promise.reject(new Error('checkout timed out'))
        : runGit(args, cwd, deadline));

    await expect(buildLandingCommit({
      worktreePath: wt, branchName: item.branchName!, itemId: item.id, baseTip: git(['rev-parse', 'main']),
      message: `Plan: sample\n\nLanded by Plan Queue after 1 verification round(s).\nItem: ${item.id}`,
      documents: [{ relativePath: 'docs/plans/sample_plan_completed.md', content: '# done\n' }],
    })).rejects.toThrow(/Its work is safe on the branch/);
    vi.restoreAllMocks();
    expect(existsSync(join(wt, 'docs/plans/sample_plan_completed.md'))).toBe(false);

    const after = await service.checkpoint(item, 'parked: land-blocked');

    expect(git(['symbolic-ref', '--short', 'HEAD'], wt)).toBe(item.branchName);
    expect(after.checkpointCommit).toBe(item.checkpointCommit);
  });

  it('refuses a branch started from a commit the base branch has since dropped', async () => {
    const base = git(['rev-parse', 'main']);
    writeFileSync(join(repo, 'stray.txt'), 'committed to main by mistake\n');
    git(['add', 'stray.txt']);
    git(['commit', '-q', '-m', 'stray']);
    const item = await itemWithWork();
    git(['reset', '-q', '--hard', base]);

    const result = await landItemBranch(item, repo, 'main', 'Plan: sample');

    expect(result).toEqual({ status: 'blocked', reason: expect.stringContaining('("stray"), which is not on main') });
    expect(git(['rev-parse', 'main'])).toBe(base);
    expect(git(['symbolic-ref', '--short', 'HEAD'], item.worktreePath!)).toBe(item.branchName);
  });

  it('refuses a branch that merged in a commit the base branch has since dropped', async () => {
    const item = await itemWithWork();
    const base = git(['rev-parse', 'main']);
    writeFileSync(join(repo, 'stray.txt'), 'committed to main by mistake\n');
    git(['add', 'stray.txt']);
    git(['commit', '-q', '-m', 'stray']);
    git(['merge', '-q', '--no-edit', 'main'], item.worktreePath!);
    git(['reset', '-q', '--hard', base]);

    const result = await landItemBranch(item, repo, 'main', 'Plan: sample');

    expect(result).toEqual({ status: 'blocked', reason: expect.stringContaining('("stray"), which is not on main') });
    expect(git(['rev-parse', 'main'])).toBe(base);
  });

  it('still lands a branch whose merges of the base are all on it', async () => {
    const item = await itemWithWork();
    writeFileSync(join(repo, 'b.txt'), 'main moved\n');
    git(['commit', '-q', '-am', 'main moved']);
    git(['merge', '-q', '--no-edit', 'main'], item.worktreePath!);

    const result = await landItemBranch(item, repo, 'main', `Plan: sample\n\nItem: ${item.id}`);

    expect(result.status).toBe('landed');
    expect(git(['show', 'main:one.txt'])).toBe('one');
  });
});
