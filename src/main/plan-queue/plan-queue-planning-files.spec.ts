import { execFileSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { WorktreeManager } from '../workspace/git/worktree-manager';
import { landItemBranch } from './plan-queue-landing';
import { _setPlanQueueDataDirForTesting } from './plan-queue-data-dir';
import { restoreItemCheckout } from './plan-queue-squash';
import {
  clearPlanningMoveRecord, describePlanningMoves, planningMoveNote, relocatePlanningFiles,
} from './plan-queue-planning-files';
import { PlanQueueWorktreeService } from './plan-queue-worktree';
import type { PlanQueueItem } from './plan-queue.types';

/** One-shot hooks: `beforeCreate` runs just before the next exclusive create (to swap a folder for a link). */
const hook = vi.hoisted(() => ({
  beforeCreate: null as ((target: string) => void) | null,
  /** Runs before every folder create until the callback clears it: the callback decides which path matters. */
  beforeMkdir: null as ((target: string) => void) | null,
  /** Runs before every rename / hard link until the callback clears it; it gets the destination path. */
  beforeRename: null as ((from: string, to: string) => void) | null,
  beforeLink: null as ((from: string, to: string) => void) | null,
}));
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>();
  return {
    ...actual,
    rename: async (...args: Parameters<typeof actual.rename>) => {
      if (hook.beforeRename) hook.beforeRename(String(args[0]), String(args[1]));
      return actual.rename(...args);
    },
    link: async (...args: Parameters<typeof actual.link>) => {
      if (hook.beforeLink) hook.beforeLink(String(args[0]), String(args[1]));
      return actual.link(...args);
    },
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      if (hook.beforeMkdir) hook.beforeMkdir(String(args[0]));
      return actual.mkdir(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (hook.beforeCreate && args[1] === 'wx') {
        const run = hook.beforeCreate; hook.beforeCreate = null; run(String(args[0]));
      }
      return actual.open(...args);
    },
  };
});

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let root: string;
let outside: string;
/** Stands in for Harness's data folder, where rescue copies are kept. */
let dataDir: string;
let saved: PlanQueueItem[];
let service: PlanQueueWorktreeService;

function git(args: string[], cwd = root): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function write(base: string, rel: string, content: string): void {
  mkdirSync(dirname(join(base, rel)), { recursive: true });
  writeFileSync(join(base, rel), content);
}

function makeItem(id = 'item-abc123'): PlanQueueItem {
  return {
    id, runId: 'run-1', documentPath: join(root, 'docs/plans/2026-01-01-sample_plan.md'),
    state: 'preparing', round: 0, erroredRounds: 0, landingRefusals: 0, baseConflicts: 0, branchName: null, worktreePath: null,
    baseCommit: null, checkpointCommit: null, verifiedMainCommit: null, landedCommit: null,
    workerInstanceId: null, verifierInstanceId: null, question: null, answer: null, parkReason: null,
    detail: null, verdict: null, createdAt: 1, updatedAt: 1,
  };
}

function branchFiles(item: PlanQueueItem): string[] {
  return git(['ls-tree', '-r', '--name-only', item.branchName!]).split('\n');
}

beforeEach(() => {
  WorktreeManager._resetForTesting();
  GitWriteQueue._resetForTesting();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-planning-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-planning-outside-')));
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-planning-data-')));
  _setPlanQueueDataDirForTesting(dataDir);
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Plan Queue Test']);
  git(['config', 'user.email', 'plan-queue@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  git(['config', 'core.hooksPath', '.git/no-hooks']);
  write(root, 'a.txt', 'base\n');
  write(root, 'docs/plans/tracked_plan.md', '# tracked on base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  saved = [];
  service = new PlanQueueWorktreeService({ repoRootForItem: () => root, creator: WorktreeManager.getInstance(),
    saveItem: (item) => saved.push(item), skipInstall: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  hook.beforeMkdir = null;
  hook.beforeRename = null;
  hook.beforeLink = null;
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  chmodSync(dataDir, 0o755);
  rmSync(dataDir, { recursive: true, force: true });
  _setPlanQueueDataDirForTesting(null);
  WorktreeManager._resetForTesting();
  GitWriteQueue._resetForTesting();
});

/** A plain folder standing in for the work folder: the module only needs candidates and a root repository. */
function workFolder(files: Record<string, string> = {}): string {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-planning-wt-')));
  const wt = join(parent, 'wt');
  mkdirSync(wt);
  for (const [rel, content] of Object.entries(files)) write(wt, rel, content);
  return wt;
}

function dropWorkFolder(wt: string): void {
  rmSync(dirname(wt), { recursive: true, force: true });
}

describe('relocatePlanningFiles', () => {
  it('moves a new file to the same path in the root and removes it from the work folder', async () => {
    const wt = workFolder({ 'docs/plans/x_history.md': 'history\n' });
    const report = await relocatePlanningFiles({ itemId: 'item-1', worktreePath: wt, repoRoot: root }, ['docs/plans/x_history.md']);
    expect(report).toEqual({ moved: ['docs/plans/x_history.md'], beside: [], failed: [] });
    expect(readFileSync(join(root, 'docs/plans/x_history.md'), 'utf8')).toBe('history\n');
    expect(existsSync(join(wt, 'docs/plans/x_history.md'))).toBe(false);
    expect(planningMoveNote(report)).toContain('docs/plans/x_history.md');
    dropWorkFolder(wt);
  });

  it('never replaces a root file, even one this same item moved earlier: the newer version goes beside it', async () => {
    const wt = workFolder({ 'docs/plans/x_history.md': 'v1\n' });
    const ctx = { itemId: 'item-abc123', worktreePath: wt, repoRoot: root };
    await relocatePlanningFiles(ctx, ['docs/plans/x_history.md']);
    write(wt, 'docs/plans/x_history.md', 'v2\n');

    const report = await relocatePlanningFiles(ctx, ['docs/plans/x_history.md']);

    expect(report.moved).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.beside).toEqual([{ path: 'docs/plans/x_history.md', copy: 'docs/plans/x_history.from-queue-abc123.md' }]);
    expect(readFileSync(join(root, 'docs/plans/x_history.md'), 'utf8')).toBe('v1\n');
    expect(readFileSync(join(root, 'docs/plans/x_history.from-queue-abc123.md'), 'utf8')).toBe('v2\n');
    expect(existsSync(join(wt, 'docs/plans/x_history.md'))).toBe(false);
    expect(planningMoveNote(report)).toContain('was not overwritten');
    dropWorkFolder(wt);
  });

  it('keeps an edit made at the root after the move: the root file is never touched again', async () => {
    const wt = workFolder({ 'docs/plans/x_history.md': 'v1\n' });
    const ctx = { itemId: 'item-abc123', worktreePath: wt, repoRoot: root };
    await relocatePlanningFiles(ctx, ['docs/plans/x_history.md']);
    write(root, 'docs/plans/x_history.md', 'v1 plus an edit made at the root\n');
    write(wt, 'docs/plans/x_history.md', 'v2\n');

    const report = await relocatePlanningFiles(ctx, ['docs/plans/x_history.md']);

    expect(report.moved).toEqual([]);
    expect(report.beside).toEqual([{ path: 'docs/plans/x_history.md', copy: 'docs/plans/x_history.from-queue-abc123.md' }]);
    expect(readFileSync(join(root, 'docs/plans/x_history.md'), 'utf8')).toBe('v1 plus an edit made at the root\n');
    expect(readFileSync(join(root, 'docs/plans/x_history.from-queue-abc123.md'), 'utf8')).toBe('v2\n');
    dropWorkFolder(wt);
  });

  it('never opens, renames, links or removes the existing root file when the destination exists', async () => {
    const wt = workFolder({ 'docs/plans/x_history.md': 'v1\n' });
    const ctx = { itemId: 'item-abc123', worktreePath: wt, repoRoot: root };
    await relocatePlanningFiles(ctx, ['docs/plans/x_history.md']);
    write(wt, 'docs/plans/x_history.md', 'v2\n');
    const rootFile = join(root, 'docs/plans/x_history.md');
    const touched: string[] = [];
    hook.beforeRename = (from, to) => { touched.push(from, to); };
    hook.beforeLink = (from, to) => { touched.push(from, to); };

    await relocatePlanningFiles(ctx, ['docs/plans/x_history.md']);

    expect(touched).not.toContain(rootFile);
    expect(readdirSync(join(root, 'docs/plans')).filter((name) => name.includes('aio-'))).toEqual([]);
    dropWorkFolder(wt);
  });

  it('keeps a root file that was saved in the instant before the worker file was written: the exclusive create refuses it and the file goes beside', async () => {
    const wt = workFolder({ 'docs/plans/x_history.md': 'worker v1\n' });
    hook.beforeCreate = () => { write(root, 'docs/plans/x_history.md', 'saved at the root in the last instant\n'); };

    const report = await relocatePlanningFiles({ itemId: 'item-abc123', worktreePath: wt, repoRoot: root }, ['docs/plans/x_history.md']);

    expect(report.failed).toEqual([]);
    expect(report.beside).toEqual([{ path: 'docs/plans/x_history.md', copy: 'docs/plans/x_history.from-queue-abc123.md' }]);
    expect(readFileSync(join(root, 'docs/plans/x_history.md'), 'utf8')).toBe('saved at the root in the last instant\n');
    expect(readFileSync(join(root, 'docs/plans/x_history.from-queue-abc123.md'), 'utf8')).toBe('worker v1\n');
    dropWorkFolder(wt);
  });

  it('keeps both copies when the root already has a file this item never moved', async () => {
    write(root, 'docs/plans/shared_plan.md', 'the root version\n');
    const wt = workFolder({ 'docs/plans/shared_plan.md': 'the worker version\n' });
    const report = await relocatePlanningFiles({ itemId: 'item-abc123', worktreePath: wt, repoRoot: root }, ['docs/plans/shared_plan.md']);
    expect(report.beside).toHaveLength(1);
    expect(readFileSync(join(root, 'docs/plans/shared_plan.md'), 'utf8')).toBe('the root version\n');
    expect(readFileSync(join(root, report.beside[0].copy), 'utf8')).toBe('the worker version\n');
    dropWorkFolder(wt);
  });

  it('gives an existing .from-queue file a new number instead of replacing it', async () => {
    write(root, 'docs/plans/shared_plan.md', 'the root version\n');
    write(root, 'docs/plans/shared_plan.from-queue-abc123.md', 'an earlier copy\n');
    write(root, 'docs/plans/shared_plan.from-queue-abc123-2.md', 'another earlier copy\n');
    const wt = workFolder({ 'docs/plans/shared_plan.md': 'the worker version\n' });

    const report = await relocatePlanningFiles({ itemId: 'item-abc123', worktreePath: wt, repoRoot: root }, ['docs/plans/shared_plan.md']);

    expect(report.beside).toEqual([{ path: 'docs/plans/shared_plan.md', copy: 'docs/plans/shared_plan.from-queue-abc123-3.md' }]);
    expect(readFileSync(join(root, 'docs/plans/shared_plan.from-queue-abc123.md'), 'utf8')).toBe('an earlier copy\n');
    expect(readFileSync(join(root, 'docs/plans/shared_plan.from-queue-abc123-2.md'), 'utf8')).toBe('another earlier copy\n');
    expect(readFileSync(join(root, 'docs/plans/shared_plan.from-queue-abc123-3.md'), 'utf8')).toBe('the worker version\n');
    dropWorkFolder(wt);
  });

  it('removes the work-folder copy without adding anything when the root already has the same bytes', async () => {
    write(root, 'docs/plans/same_plan.md', 'identical\n');
    const wt = workFolder({ 'docs/plans/same_plan.md': 'identical\n' });
    const report = await relocatePlanningFiles({ itemId: 'item-1', worktreePath: wt, repoRoot: root }, ['docs/plans/same_plan.md']);
    expect(report).toEqual({ moved: ['docs/plans/same_plan.md'], beside: [], failed: [] });
    expect(readdirSync(join(root, 'docs/plans')).sort()).toEqual(['same_plan.md', 'tracked_plan.md']);
    dropWorkFolder(wt);
  });

  it.each(['../escape_plan.md', 'docs/../../escape_plan.md', '/tmp/escape_plan.md', '.git/hooks/x_plan.md', ''])(
    'refuses the path %j that would leave the project, without reading or writing anything', async (rel) => {
      const wt = workFolder();
      write(dirname(wt), 'escape_plan.md', 'outside the work folder\n');
      const rootSibling = join(dirname(root), 'escape_plan.md');
      const report = await relocatePlanningFiles({ itemId: 'item-1', worktreePath: wt, repoRoot: root }, [rel]);
      expect(report.moved).toEqual([]);
      expect(report.failed).toEqual([expect.objectContaining({ path: rel, rescue: null, unsafeToDelete: false })]);
      expect(existsSync(rootSibling)).toBe(false);
      expect(readFileSync(join(dirname(wt), 'escape_plan.md'), 'utf8')).toBe('outside the work folder\n');
      dropWorkFolder(wt);
    });

  it('refuses a root folder that is a link leading outside the project, and keeps a rescue copy', async () => {
    symlinkSync(outside, join(root, 'docs-link'));
    const wt = workFolder({ 'docs-link/x_plan.md': 'worker plan\n' });

    const report = await relocatePlanningFiles({ itemId: 'item-1', worktreePath: wt, repoRoot: root }, ['docs-link/x_plan.md']);

    expect(report.moved).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].reason).toContain('leads outside the project');
    expect(readdirSync(outside)).toEqual([]);
    expect(report.failed[0].rescue!.startsWith(join(dataDir, 'planning-rescue'))).toBe(true);
    expect(readFileSync(report.failed[0].rescue!, 'utf8')).toBe('worker plan\n');
    expect(existsSync(join(wt, 'docs-link/x_plan.md'))).toBe(true);
    dropWorkFolder(wt);
  });

  it('writes nothing outside the project when a destination folder is swapped for a link just before the file is created', async () => {
    mkdirSync(join(root, 'docs/plans'), { recursive: true });
    const wt = workFolder({ 'docs/plans/x_history.md': 'worker history\n' });
    hook.beforeCreate = () => {
      // The folder passed the inside-the-project check; now it becomes a link leading out.
      renameSync(join(root, 'docs/plans'), join(root, 'docs/plans-moved-away'));
      symlinkSync(outside, join(root, 'docs/plans'));
    };

    const report = await relocatePlanningFiles({ itemId: 'item-1', worktreePath: wt, repoRoot: root }, ['docs/plans/x_history.md']);

    expect(report.moved).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].reason).toContain('changed while the file was being created');
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(join(wt, 'docs/plans/x_history.md'), 'utf8')).toBe('worker history\n');
    expect(readFileSync(report.failed[0].rescue!, 'utf8')).toBe('worker history\n');
    dropWorkFolder(wt);
  });

  it('creates no folder outside the project when a parent folder is swapped for a link just before the next folder is created', async () => {
    mkdirSync(join(root, 'docs'), { recursive: true });
    const wt = workFolder({ 'docs/fresh/sub/x_history.md': 'worker history\n' });
    hook.beforeMkdir = (target) => {
      if (target !== join(root, 'docs', 'fresh')) return;
      hook.beforeMkdir = null;
      // `docs` passed the inside-the-project check; now it becomes a link leading out.
      renameSync(join(root, 'docs'), join(root, 'docs-moved-away'));
      symlinkSync(outside, join(root, 'docs'));
    };

    const report = await relocatePlanningFiles({ itemId: 'item-1', worktreePath: wt, repoRoot: root }, ['docs/fresh/sub/x_history.md']);

    expect(report.moved).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].reason).toContain('changed while it was being created');
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(join(wt, 'docs/fresh/sub/x_history.md'), 'utf8')).toBe('worker history\n');
    expect(readFileSync(report.failed[0].rescue!, 'utf8')).toBe('worker history\n');
    dropWorkFolder(wt);
  });

  it('refuses a work-folder file that is a link, never reading what it points to', async () => {
    const secret = join(outside, 'target.md');
    writeFileSync(secret, 'not a planning file\n');
    const wt = workFolder();
    symlinkSync(secret, join(wt, 'x_plan.md'));

    const report = await relocatePlanningFiles({ itemId: 'item-1', worktreePath: wt, repoRoot: root }, ['x_plan.md']);

    expect(report.failed).toEqual([expect.objectContaining({ path: 'x_plan.md', rescue: null, unsafeToDelete: false })]);
    expect(existsSync(join(root, 'x_plan.md'))).toBe(false);
    dropWorkFolder(wt);
  });

  it('refuses a clash with a folder or a link at the destination and keeps a rescue copy', async () => {
    mkdirSync(join(root, 'docs/plans/dir_plan.md'));
    symlinkSync(join(outside, 'nothing'), join(root, 'docs/plans/link_plan.md'));
    const wt = workFolder({ 'docs/plans/dir_plan.md': 'a\n', 'docs/plans/link_plan.md': 'b\n' });

    const report = await relocatePlanningFiles({ itemId: 'item-1', worktreePath: wt, repoRoot: root },
      ['docs/plans/dir_plan.md', 'docs/plans/link_plan.md']);

    expect(report.failed.map((file) => file.path)).toEqual(['docs/plans/dir_plan.md', 'docs/plans/link_plan.md']);
    expect(report.failed.map((file) => readFileSync(file.rescue!, 'utf8'))).toEqual(['a\n', 'b\n']);
    expect(readdirSync(outside)).toEqual([]);
    dropWorkFolder(wt);
  });

  it('does not overwrite or duplicate anything when it stops between the copy and removing the original, and a rerun finishes', async () => {
    const wt = workFolder({ 'docs/plans/x_history.md': 'once\n' });
    const ctx = { itemId: 'item-1', worktreePath: wt, repoRoot: root };
    // A read-only folder makes removing the original fail after the copy was made.
    chmodSync(join(wt, 'docs/plans'), 0o555);

    const interrupted = await relocatePlanningFiles(ctx, ['docs/plans/x_history.md']);
    expect(interrupted.failed).toHaveLength(1);
    expect(readFileSync(join(root, 'docs/plans/x_history.md'), 'utf8')).toBe('once\n');
    expect(existsSync(join(wt, 'docs/plans/x_history.md'))).toBe(true);
    chmodSync(join(wt, 'docs/plans'), 0o755);

    const rerun = await relocatePlanningFiles(ctx, ['docs/plans/x_history.md']);

    expect(rerun).toEqual({ moved: ['docs/plans/x_history.md'], beside: [], failed: [] });
    expect(existsSync(join(wt, 'docs/plans/x_history.md'))).toBe(false);
    expect(readdirSync(join(root, 'docs/plans')).filter((name) => name.includes('x_history'))).toEqual(['x_history.md']);
    dropWorkFolder(wt);
  });

  it('finishes after a stop before the record is saved, and a later version still goes beside the root file', async () => {
    const wt = workFolder({ 'docs/plans/x_history.md': 'v1\n' });
    const ctx = { itemId: 'item-abc123', worktreePath: wt, repoRoot: root };
    // A read-only record folder makes saving the ownership record fail right after the root copy was made.
    const recordDir = join(root, '.git', 'aio-plan-queue', 'planning-moves');
    mkdirSync(recordDir, { recursive: true });
    chmodSync(recordDir, 0o555);
    try {
      const interrupted = await relocatePlanningFiles(ctx, ['docs/plans/x_history.md']);
      expect(interrupted.failed).toHaveLength(1);
    } finally {
      chmodSync(recordDir, 0o755);
    }
    expect(readFileSync(join(root, 'docs/plans/x_history.md'), 'utf8')).toBe('v1\n');
    expect(existsSync(join(wt, 'docs/plans/x_history.md'))).toBe(true);

    // The rerun finishes (same bytes at the root), then the worker's next version must not replace the root file.
    expect(await relocatePlanningFiles(ctx, ['docs/plans/x_history.md'])).toEqual({ moved: ['docs/plans/x_history.md'], beside: [], failed: [] });
    write(wt, 'docs/plans/x_history.md', 'v2\n');
    const report = await relocatePlanningFiles(ctx, ['docs/plans/x_history.md']);

    expect(report.moved).toEqual([]);
    expect(report.beside).toEqual([{ path: 'docs/plans/x_history.md', copy: 'docs/plans/x_history.from-queue-abc123.md' }]);
    expect(readFileSync(join(root, 'docs/plans/x_history.md'), 'utf8')).toBe('v1\n');
    expect(readFileSync(join(root, 'docs/plans/x_history.from-queue-abc123.md'), 'utf8')).toBe('v2\n');
    dropWorkFolder(wt);
  });

  it('two runs at once for the same path keep both versions and never overwrite either', async () => {
    const wtA = workFolder({ 'docs/plans/shared_plan.md': 'from item A\n' });
    const wtB = workFolder({ 'docs/plans/shared_plan.md': 'from item B\n' });

    const [a, b] = await Promise.all([
      relocatePlanningFiles({ itemId: 'item-aaaaaa', worktreePath: wtA, repoRoot: root }, ['docs/plans/shared_plan.md']),
      relocatePlanningFiles({ itemId: 'item-bbbbbb', worktreePath: wtB, repoRoot: root }, ['docs/plans/shared_plan.md']),
    ]);

    expect(a.failed).toEqual([]);
    expect(b.failed).toEqual([]);
    expect(a.moved).toEqual(['docs/plans/shared_plan.md']);
    expect(b.beside).toEqual([{ path: 'docs/plans/shared_plan.md', copy: 'docs/plans/shared_plan.from-queue-bbbbbb.md' }]);
    expect(readFileSync(join(root, 'docs/plans/shared_plan.md'), 'utf8')).toBe('from item A\n');
    expect(readFileSync(join(root, 'docs/plans/shared_plan.from-queue-bbbbbb.md'), 'utf8')).toBe('from item B\n');
    dropWorkFolder(wtA);
    dropWorkFolder(wtB);
  });

  it('two runs at once for the same item do not lose each other\'s record of what was moved', async () => {
    // Many files per run, so the two runs overlap for long enough that an unserialised record update would be lost.
    const names = Array.from({ length: 30 }, (_, n) => `docs/plans/f${n}_history.md`);
    const wt = workFolder(Object.fromEntries(names.map((name) => [name, `${name} v1\n`])));
    const ctx = { itemId: 'item-abc123', worktreePath: wt, repoRoot: root };

    await Promise.all([relocatePlanningFiles(ctx, names.slice(0, 15)), relocatePlanningFiles(ctx, names.slice(15))]);

    const text = await describePlanningMoves(root, 'item-abc123');
    for (const name of names) expect(text, name).toContain(`${name} is now at`);
    // A newer version of each goes beside the root file; none is replaced.
    for (const name of names) write(wt, name, `${name} v2\n`);
    const report = await relocatePlanningFiles(ctx, names);
    expect(report.moved).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.beside).toHaveLength(30);
    for (const name of names) expect(readFileSync(join(root, name), 'utf8')).toBe(`${name} v1\n`);
    dropWorkFolder(wt);
  });

  it('marks a file unsafe to delete when it can be neither moved nor copied to the rescue folder', async () => {
    write(root, 'blocked', 'a file where the folder should be\n');
    const rescueParent = dataDir;
    chmodSync(rescueParent, 0o555);
    const wt = workFolder({ 'blocked/x_history.md': 'only copy\n' });
    try {
      const report = await relocatePlanningFiles({ itemId: 'item-1', worktreePath: wt, repoRoot: root }, ['blocked/x_history.md']);
      expect(report.failed).toEqual([expect.objectContaining({ path: 'blocked/x_history.md', rescue: null, unsafeToDelete: true })]);
      expect(planningMoveNote(report)).toContain('no copy could be made');
    } finally {
      chmodSync(rescueParent, 0o755);
    }
    dropWorkFolder(wt);
  });

  it('describes where an item moved its files, and forgets them when cleared', async () => {
    write(root, 'docs/plans/shared_plan.md', 'the root version\n');
    const wt = workFolder({ 'docs/plans/x_history.md': 'h\n', 'docs/plans/shared_plan.md': 'w\n' });
    await relocatePlanningFiles({ itemId: 'item-abc123', worktreePath: wt, repoRoot: root },
      ['docs/plans/x_history.md', 'docs/plans/shared_plan.md']);

    const text = await describePlanningMoves(root, 'item-abc123');

    expect(text).toContain(`docs/plans/x_history.md is now at ${join(root, 'docs/plans/x_history.md')}`);
    expect(text).toContain(join(root, 'docs/plans/shared_plan.from-queue-abc123.md'));
    expect(await describePlanningMoves(root, 'another-item')).toBeNull();
    await clearPlanningMoveRecord(root, 'item-abc123');
    expect(await describePlanningMoves(root, 'item-abc123')).toBeNull();
    dropWorkFolder(wt);
  });
});

describe('checkpoints', () => {
  it('move a worker-created _history.md to the root and never commit it', async () => {
    const item = await service.prepare(makeItem(), root);
    const wt = item.worktreePath!;
    write(wt, 'src-work.txt', 'real work\n');
    write(wt, 'docs/plans/new_history.md', 'journal\n');
    write(wt, 'docs/plans/new_plan.md', '# plan\n');
    write(wt, 'docs/plans/new-decisions-for-james.md', '# decisions\n');
    write(wt, 'docs/plans/new_plan_completed.md', '# a closed document is ordinary work\n');

    const after = await service.checkpoint(item, 'work');

    expect(branchFiles(after)).toContain('src-work.txt');
    expect(branchFiles(after)).toContain('docs/plans/new_plan_completed.md');
    expect(branchFiles(after).filter((file) => /_history|_plan\.md|decisions/.test(file) && file !== 'docs/plans/tracked_plan.md')).toEqual([]);
    expect(readFileSync(join(root, 'docs/plans/new_history.md'), 'utf8')).toBe('journal\n');
    expect(readFileSync(join(root, 'docs/plans/new_plan.md'), 'utf8')).toBe('# plan\n');
    expect(readFileSync(join(root, 'docs/plans/new-decisions-for-james.md'), 'utf8')).toBe('# decisions\n');
    expect(existsSync(join(wt, 'docs/plans/new_history.md'))).toBe(false);
    expect(after.detail).toContain('moved to the main project folder');
    expect(git(['status', '--porcelain', '--', 'src-work.txt'], wt)).toBe('');
  });

  it('leave a tracked planning file alone: an edit to it is committed like code, and the root copy is untouched', async () => {
    const item = await service.prepare(makeItem(), root);
    write(item.worktreePath!, 'docs/plans/tracked_plan.md', '# edited in the worktree\n');

    const after = await service.checkpoint(item, 'work');

    expect(git(['show', `${after.branchName}:docs/plans/tracked_plan.md`])).toBe('# edited in the worktree');
    expect(readFileSync(join(root, 'docs/plans/tracked_plan.md'), 'utf8')).toBe('# tracked on base\n');
    expect(after.detail).toBeNull();
  });

  it('keep a file that cannot be moved out of the commit, save a rescue copy, and move it once the clash is gone', async () => {
    write(root, 'blocked', 'a file where the folder should be\n');
    const item = await service.prepare(makeItem(), root);
    const wt = item.worktreePath!;
    write(wt, 'work.txt', 'real work\n');
    write(wt, 'blocked/plans/stuck_history.md', 'journal\n');

    const after = await service.checkpoint(item, 'work');

    expect(branchFiles(after)).toContain('work.txt');
    expect(branchFiles(after).some((file) => file.includes('stuck_history'))).toBe(false);
    expect(existsSync(join(wt, 'blocked/plans/stuck_history.md'))).toBe(true);
    expect(after.detail).toMatch(/stuck_history\.md could not be moved.*a copy is kept at /);
    const rescue = /a copy is kept at ([^ ]+stuck_history\.md)/.exec(after.detail!)?.[1];
    expect(readFileSync(rescue!, 'utf8')).toBe('journal\n');

    rmSync(join(root, 'blocked'));
    const preflight = await service.preflightPlanningFiles(after);
    expect(preflight.failed).toEqual([]);
    expect(readFileSync(join(root, 'blocked/plans/stuck_history.md'), 'utf8')).toBe('journal\n');
    expect(existsSync(join(wt, 'blocked/plans/stuck_history.md'))).toBe(false);
  });

  it('are not fooled by a failed move: the same checkpoint still commits the item\'s other work', async () => {
    write(root, 'blocked', 'a file where the folder should be\n');
    const item = await service.prepare(makeItem(), root);
    write(item.worktreePath!, 'blocked/plans/stuck_history.md', 'journal\n');
    write(item.worktreePath!, 'other.txt', 'other\n');
    const after = await service.checkpoint(item, 'work');
    expect(git(['show', `${after.branchName}:other.txt`])).toBe('other');
  });
});

describe('landing', () => {
  function installHook(script: string): void {
    const hooks = join(root, 'test-hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\n${script}\n`);
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    git(['config', 'core.hooksPath', hooks]);
    writeFileSync(join(root, '.git', 'info', 'exclude'), 'test-hooks/\n');
  }

  async function itemWithWork(): Promise<PlanQueueItem> {
    const item = await service.prepare(makeItem(), root);
    write(item.worktreePath!, 'one.txt', 'one\n');
    return service.checkpoint(item, 'work');
  }

  it('keeps a planning file made after the last checkpoint when the landing succeeds', async () => {
    const item = await itemWithWork();
    write(item.worktreePath!, 'docs/plans/late_history.md', 'written during landing\n');

    const result = await landItemBranch(item, root, 'main', 'Plan: x', []);

    expect(result.status).toBe('landed');
    expect(readFileSync(join(root, 'docs/plans/late_history.md'), 'utf8')).toBe('written during landing\n');
    expect(git(['ls-tree', '-r', '--name-only', 'main']).split('\n').some((file) => file.includes('late_history'))).toBe(false);
    expect(existsSync(join(item.worktreePath!, 'docs/plans/late_history.md'))).toBe(false);
  });

  it('keeps a planning file made after the last checkpoint when the landing fails', async () => {
    installHook('echo refused >&2; exit 1');
    const item = await itemWithWork();
    write(item.worktreePath!, 'docs/plans/late_history.md', 'written during landing\n');
    const mainBefore = git(['rev-parse', 'main']);

    const result = await landItemBranch(item, root, 'main', 'Plan: x', []);

    expect(result.status).toBe('hook-failed');
    expect(git(['rev-parse', 'main'])).toBe(mainBefore);
    expect(readFileSync(join(root, 'docs/plans/late_history.md'), 'utf8')).toBe('written during landing\n');
    expect(git(['branch', '--show-current'], item.worktreePath!)).toBe(item.branchName);
  });

  it('copies a planning file that cannot be moved to the rescue folder before landing cleanup removes it', async () => {
    const item = await itemWithWork();
    write(root, 'blocked', 'a file where the folder should be\n');
    write(item.worktreePath!, 'blocked/plans/late_history.md', 'written during landing\n');

    const result = await landItemBranch(item, root, 'main', 'Plan: x', []);

    expect(result.status).toBe('landed');
    expect(existsSync(join(item.worktreePath!, 'blocked/plans/late_history.md'))).toBe(false);
    const rescueRoot = join(dataDir, 'planning-rescue', 'item-abc123');
    const copies = readdirSync(rescueRoot).map((stamp) => join(rescueRoot, stamp, 'blocked/plans/late_history.md'));
    expect(copies.map((copy) => readFileSync(copy, 'utf8'))).toEqual(['written during landing\n']);
  });

  it('cleans nothing, and says why, when a planning file can be neither moved nor copied to safety', async () => {
    const item = await itemWithWork();
    write(root, 'blocked', 'a file where the folder should be\n');
    write(item.worktreePath!, 'blocked/plans/late_history.md', 'only copy\n');
    write(item.worktreePath!, 'scratch.txt', 'scratch\n');
    const rescueParent = dataDir;
    chmodSync(rescueParent, 0o555);
    try {
      await expect(restoreItemCheckout(item.worktreePath!, item.branchName!, root, item.id)).rejects.toThrow('nothing was cleaned');
    } finally {
      chmodSync(rescueParent, 0o755);
    }
    expect(readFileSync(join(item.worktreePath!, 'blocked/plans/late_history.md'), 'utf8')).toBe('only copy\n');
    expect(existsSync(join(item.worktreePath!, 'scratch.txt'))).toBe(true);
  });

  it('moves a planning file an interrupted landing left behind, instead of removing it, when neither tree has it', async () => {
    const item = await itemWithWork();
    const wt = item.worktreePath!;
    git(['checkout', '-q', '--detach', git(['rev-parse', 'main'])], wt);
    write(wt, 'docs/plans/stranded_history.md', 'written while detached\n');
    write(wt, 'stranded.txt', 'not a planning file\n');

    const after = await service.checkpoint(item, 'paused');

    expect(readFileSync(join(root, 'docs/plans/stranded_history.md'), 'utf8')).toBe('written while detached\n');
    expect(existsSync(join(wt, 'stranded.txt'))).toBe(false);
    expect(existsSync(join(wt, 'docs/plans/stranded_history.md'))).toBe(false);
    expect(branchFiles(after).some((file) => file.includes('stranded'))).toBe(false);
    expect(git(['for-each-ref', 'refs/plan-queue/rescue/'])).not.toBe('');
  });
});

describe('modules', () => {
  it('lists only untracked, non-provisioned planning files in a real work folder', async () => {
    const { listUntrackedPlanningFiles } = await import('./plan-queue-planning-files');
    const item = await service.prepare(makeItem(), root);
    const wt = item.worktreePath!;
    write(wt, 'docs/plans/a_plan.md', 'x');
    write(wt, 'docs/plans/b.md', 'x');
    write(wt, 'tools/c_spec_planned.md', 'x');
    write(wt, 'docs/plans/tracked_plan.md', '# edited, but tracked\n');
    expect((await listUntrackedPlanningFiles(wt)).sort()).toEqual(['docs/plans/a_plan.md', 'tools/c_spec_planned.md']);
    expect(await listUntrackedPlanningFiles(wt, ['tools'])).toEqual(['docs/plans/a_plan.md']);
  });
});
