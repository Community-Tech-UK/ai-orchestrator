import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { WorktreeManager } from '../workspace/git/worktree-manager';
import { UnresolvedMergeError } from './plan-queue-git';
import { PlanQueueWorktreeService, planQueueBranchName } from './plan-queue-worktree';
import type { PlanQueueItem } from './plan-queue.types';

let repo: string;
let saved: PlanQueueItem[];
let service: PlanQueueWorktreeService;

function git(args: string[], cwd = repo): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    // `rev-parse -q --verify` exits 1 with no output when the ref is absent.
    if (args.includes('--verify')) return '';
    throw error;
  }
}

function makeItem(overrides: Partial<PlanQueueItem> = {}): PlanQueueItem {
  return {
    id: 'item-abc123',
    runId: 'run-1',
    documentPath: join(repo, 'docs/plans/2026-01-01-sample_plan.md'),
    state: 'preparing',
    round: 0,
    erroredRounds: 0,
    landingRefusals: 0,
    branchName: null,
    worktreePath: null,
    baseCommit: null,
    checkpointCommit: null,
    verifiedMainCommit: null,
    landedCommit: null,
    workerInstanceId: null,
    verifierInstanceId: null,
    question: null,
    answer: null,
    parkReason: null,
    detail: null,
    verdict: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** A pre-commit hook that refuses every commit, like the guard that stranded loop work. */
function installRefusingHook(): void {
  const hooks = join(repo, 'test-hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho refused >&2\nexit 1\n');
  chmodSync(join(hooks, 'pre-commit'), 0o755);
  git(['config', 'core.hooksPath', hooks]);
}

beforeEach(() => {
  WorktreeManager._resetForTesting();
  GitWriteQueue._resetForTesting();
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-wt-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Plan Queue Test']);
  git(['config', 'user.email', 'plan-queue@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, '.gitignore'), 'test-hooks/\n');
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);

  saved = [];
  service = new PlanQueueWorktreeService({
    creator: WorktreeManager.getInstance(),
    saveItem: (item) => saved.push(item),
    skipInstall: true,
  });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  WorktreeManager._resetForTesting();
  GitWriteQueue._resetForTesting();
});

describe('planQueueBranchName', () => {
  it('derives a queue/ branch from the document stem and item id', () => {
    expect(planQueueBranchName(makeItem())).toBe('queue/2026-01-01-sample-abc123');
    expect(
      planQueueBranchName(makeItem({ documentPath: '/r/docs/x-feature_livetest.md', id: 'ZZ-99' })),
    ).toBe('queue/x-feature-zz99');
  });
});

describe('PlanQueueWorktreeService', () => {
  it('saves branch and path before the worktree directory exists', async () => {
    let existedAtSave: boolean | undefined;
    service = new PlanQueueWorktreeService({
      creator: WorktreeManager.getInstance(),
      saveItem: (item) => {
        existedAtSave ??= existsSync(item.worktreePath ?? '');
        saved.push(item);
      },
      skipInstall: true,
    });

    const prepared = await service.prepare(makeItem(), repo);

    expect(existedAtSave).toBe(false);
    expect(prepared.branchName).toBe('queue/2026-01-01-sample-abc123');
    expect(prepared.worktreePath).toBe(join(repo, '.worktrees', 'queue/2026-01-01-sample-abc123'));
    expect(prepared.baseCommit).toBe(git(['rev-parse', 'main']));
    expect(existsSync(prepared.worktreePath ?? '')).toBe(true);
  });

  it('creates no worktree when the ownership row cannot be written', async () => {
    service = new PlanQueueWorktreeService({
      creator: WorktreeManager.getInstance(),
      saveItem: () => {
        throw new Error('db down');
      },
      skipInstall: true,
    });

    await expect(service.prepare(makeItem(), repo)).rejects.toThrow('db down');

    expect(existsSync(join(repo, '.worktrees', 'queue'))).toBe(false);
    expect(git(['branch', '--list', 'queue/*'])).toBe('');
  });

  it('checkpoints tracked and untracked work even when a hook refuses every commit', async () => {
    let item = await service.prepare(makeItem(), repo);
    const wt = item.worktreePath ?? '';
    installRefusingHook();
    writeFileSync(join(wt, 'a.txt'), 'changed\n');
    writeFileSync(join(wt, 'new.txt'), 'new\n');
    mkdirSync(join(wt, 'docs'), { recursive: true });
    writeFileSync(join(wt, 'docs/x_plan.md'), '# guarded name\n');

    expect(() => git(['commit', '-q', '--allow-empty', '-m', 'probe'], wt)).toThrow();

    item = await service.checkpoint(item, 'worker idle');

    // Only the manager's provisioned port file is left uncommitted.
    expect(git(['status', '--porcelain'], wt)).toBe('?? .mise.local.toml');
    expect(item.checkpointCommit).toBe(git(['rev-parse', 'HEAD'], wt));
    expect(git(['show', '--name-only', '--format=', 'HEAD'], wt).split('\n').sort()).toEqual([
      'a.txt',
      'docs/x_plan.md',
      'new.txt',
    ]);
    expect(git(['rev-parse', 'main'])).toBe(item.baseCommit);
  });

  it('keeps provisioned env and port files out of checkpoints', async () => {
    writeFileSync(join(repo, '.env.local'), 'PLACEHOLDER=not-a-secret\n');
    let item = await service.prepare(makeItem(), repo);
    const wt = item.worktreePath ?? '';
    expect(existsSync(join(wt, '.env.local'))).toBe(true);
    writeFileSync(join(wt, 'work.txt'), 'work\n');

    item = await service.checkpoint(item, 'worker idle');

    expect(git(['show', '--name-only', '--format=', 'HEAD'], wt)).toBe('work.txt');
    expect(git(['ls-files', '.env.local', '.mise.local.toml'], wt)).toBe('');
    expect(await service.removeWithProof(item, repo)).toEqual({ removed: true });
  });

  it('records HEAD without committing when the tree is clean', async () => {
    const prepared = await service.prepare(makeItem(), repo);

    const item = await service.checkpoint(prepared, 'nothing to do');

    expect(item.checkpointCommit).toBe(prepared.baseCommit);
  });

  it('refuses to remove a dirty worktree and leaves the work intact', async () => {
    let item = await service.prepare(makeItem(), repo);
    item = await service.checkpoint(item, 'first');
    writeFileSync(join(item.worktreePath ?? '', 'late.txt'), 'late\n');

    const result = await service.removeWithProof(item, repo);

    expect(result).toMatchObject({ removed: false, reason: 'dirty-tree' });
    expect(existsSync(join(item.worktreePath ?? '', 'late.txt'))).toBe(true);
  });

  it('refuses to remove when HEAD is not the recorded checkpoint', async () => {
    let item = await service.prepare(makeItem(), repo);
    item = await service.checkpoint(item, 'first');
    const wt = item.worktreePath ?? '';
    writeFileSync(join(wt, 'agent.txt'), 'agent committed this itself\n');
    git(['add', '-A'], wt);
    git(['commit', '-q', '-m', 'agent commit'], wt);

    const result = await service.removeWithProof(item, repo);

    expect(result).toMatchObject({ removed: false, reason: 'head-not-checkpoint' });
    expect(existsSync(wt)).toBe(true);
  });

  it('removes a checkpointed worktree, keeps the branch, and frees the manager slot', async () => {
    let item = await service.prepare(makeItem(), repo);
    const wt = item.worktreePath ?? '';
    writeFileSync(join(wt, 'work.txt'), 'work\n');
    item = await service.checkpoint(item, 'done');

    const result = await service.removeWithProof(item, repo);

    expect(result).toEqual({ removed: true });
    expect(existsSync(wt)).toBe(false);
    expect(git(['rev-parse', 'queue/2026-01-01-sample-abc123'])).toBe(item.checkpointCommit);
    expect(saved.at(-1)?.worktreePath).toBeNull();
    expect(WorktreeManager.getInstance().getAllSessions()).toEqual([]);
  });

  it('removes from the row alone after a restart has emptied the manager', async () => {
    let item = await service.prepare(makeItem(), repo);
    item = await service.checkpoint(item, 'before restart');
    WorktreeManager._resetForTesting();
    service = new PlanQueueWorktreeService({
      creator: WorktreeManager.getInstance(),
      saveItem: (i) => saved.push(i),
      skipInstall: true,
    });

    const result = await service.removeWithProof(item, repo);

    expect(result).toEqual({ removed: true });
    expect(existsSync(item.worktreePath ?? '')).toBe(false);
  });

  it('deletes the branch only after landing or an explicit discard', async () => {
    let item = await service.prepare(makeItem(), repo);
    writeFileSync(join(item.worktreePath ?? '', 'work.txt'), 'work\n');
    item = await service.checkpoint(item, 'done');

    await expect(service.deleteBranchWithProof(item, repo)).rejects.toThrow('has not landed');
    await expect(
      service.deleteBranchWithProof(item, repo, { discardRequested: true }),
    ).rejects.toThrow('worktree still exists');

    await service.removeWithProof(item, repo);
    const parked: PlanQueueItem = { ...item, worktreePath: null, state: 'parked' };
    await expect(service.deleteBranchWithProof(parked, repo)).rejects.toThrow('has not landed');
    expect(git(['branch', '--list', 'queue/*'])).not.toBe('');

    await service.deleteBranchWithProof({ ...parked, state: 'landed' }, repo);

    expect(git(['branch', '--list', 'queue/*'])).toBe('');
    expect(saved.at(-1)?.branchName).toBeNull();
  });

  it('reattaches a parked branch without recreating or deleting it, and keeps its work', async () => {
    let item = await service.prepare(makeItem(), repo);
    writeFileSync(join(item.worktreePath ?? '', 'work.txt'), 'parked work\n');
    item = await service.checkpoint(item, 'park');
    const tip = item.checkpointCommit;
    expect(await service.removeWithProof(item, repo)).toEqual({ removed: true });
    item = { ...saved.at(-1)!, state: 'preparing' };
    expect(item.worktreePath).toBeNull();

    // A fresh manager, as after a restart: WorktreeManager.createWorktree would
    // run `worktree add -b` and, failing on the existing branch, delete it.
    WorktreeManager._resetForTesting();
    const reattached = await service.reattach(item, repo);

    expect(reattached.worktreePath).toBe(join(repo, '.worktrees', item.branchName ?? ''));
    expect(saved.some((s) => s.worktreePath === reattached.worktreePath && s.checkpointCommit === tip)).toBe(true);
    expect(reattached.checkpointCommit).toBe(tip);
    expect(readFileSync(join(reattached.worktreePath ?? '', 'work.txt'), 'utf8')).toBe('parked work\n');
    expect(git(['rev-parse', item.branchName ?? ''])).toBe(tip);
    // Idempotent: a second call finds the checkout and changes nothing.
    expect((await service.reattach(reattached, repo)).checkpointCommit).toBe(tip);
  });

  describe('with a merge of main in progress', () => {
    /** Item and main both change a.txt; merging main into the item conflicts. */
    async function conflictedItem(): Promise<PlanQueueItem> {
      let item = await service.prepare(makeItem(), repo);
      const wt = item.worktreePath ?? '';
      writeFileSync(join(wt, 'a.txt'), 'item\n');
      item = await service.checkpoint(item, 'work');
      writeFileSync(join(repo, 'a.txt'), 'main\n');
      git(['commit', '-q', '-am', 'main moved']);
      try {
        git(['merge', '--no-edit', 'main'], wt);
      } catch {
        // Expected conflict.
      }
      return item;
    }

    it('refuses to checkpoint while it is unresolved, committing nothing', async () => {
      const item = await conflictedItem();
      const wt = item.worktreePath ?? '';
      await expect(service.checkpoint(item, 'park')).rejects.toBeInstanceOf(UnresolvedMergeError);
      expect(git(['rev-parse', 'HEAD'], wt)).toBe(item.checkpointCommit);
      expect(git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], wt)).not.toBe('');
      expect(git(['show', `${item.branchName}:a.txt`])).toBe('item');
    });

    it('completes the merge once the worker has resolved and staged it', async () => {
      const item = await conflictedItem();
      const wt = item.worktreePath ?? '';
      writeFileSync(join(wt, 'a.txt'), 'item+main\n');
      git(['add', 'a.txt'], wt);

      const done = await service.checkpoint(item, 'resolved');

      expect(git(['rev-list', '--parents', '-n', '1', 'HEAD'], wt).split(' ')).toHaveLength(3);
      expect(git(['show', `${done.checkpointCommit}:a.txt`])).toBe('item+main');
    });

    it('reattach leaves an existing checkout and its unfinished merge untouched', async () => {
      const item = await conflictedItem();
      const wt = item.worktreePath ?? '';

      const reattached = await service.reattach(item, repo);

      expect(reattached.worktreePath).toBe(wt);
      expect(reattached.checkpointCommit).toBe(item.checkpointCommit);
      expect(git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], wt)).not.toBe('');
      expect(readFileSync(join(wt, 'a.txt'), 'utf8')).toContain('<<<<<<<');
    });
  });
});
