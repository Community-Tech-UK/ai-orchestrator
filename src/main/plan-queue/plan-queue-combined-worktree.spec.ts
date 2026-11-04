import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { WorktreeManager } from '../workspace/git/worktree-manager';
import * as dependencyProvisioning from '../workspace/git/worktree-deps';
import { PlanQueueWorktreeService } from './plan-queue-worktree';
import type { PlanQueueItem } from './plan-queue.types';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

let repo: string;
let service: PlanQueueWorktreeService;
let base: string;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function createService(): PlanQueueWorktreeService {
  return new PlanQueueWorktreeService({ repoRootForItem: () => repo, creator: WorktreeManager.getInstance(),
    saveItem: () => undefined, skipInstall: true });
}

async function member(id: string, file: string, content: string): Promise<{ itemId: string; head: string }> {
  const item: PlanQueueItem = { id, runId: 'run', documentPath: join(repo, `${id}_plan.md`), state: 'preparing',
    round: 0, erroredRounds: 0, landingRefusals: 0, baseConflicts: 0, branchName: null, worktreePath: null,
    baseCommit: null, checkpointCommit: null, verifiedMainCommit: null, landedCommit: null, workerInstanceId: null,
    verifierInstanceId: null, question: null, answer: null, parkReason: null, detail: null, verdict: null,
    createdAt: 1, updatedAt: 1 };
  const prepared = await service.prepare(item, repo);
  writeFileSync(join(prepared.worktreePath!, file), content);
  const checkpoint = await service.checkpoint(prepared, 'finished');
  return { itemId: id, head: checkpoint.checkpointCommit! };
}

function scratchMarkers(): string[] {
  const dir = join(repo, '.git', 'plan-queue-check-copies');
  return existsSync(dir) ? readdirSync(dir).map(name => join(dir, name)) : [];
}

beforeEach(() => {
  WorktreeManager._resetForTesting();
  GitWriteQueue._resetForTesting();
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-combined-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Queue Test']);
  git(['config', 'user.email', 'queue@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base']);
  base = git(['rev-parse', 'HEAD']);
  service = createService();
});

afterEach(() => {
  vi.restoreAllMocks();
  WorktreeManager._resetForTesting();
  GitWriteQueue._resetForTesting();
  rmSync(repo, { recursive: true, force: true });
});

describe('combined queue check copies', () => {
  it.each(['green', 'red', 'abort'] as const)('tests the combined committed tree and removes the copy after %s', async outcome => {
    const members = [await member('one', 'one.txt', 'one\n'), await member('two', 'two.txt', 'two\n')];
    const controller = new AbortController();
    const failure = new Error('The checklist failed');
    let folder = '';
    const result = service.withCombinedCopy(repo, base, members, async copy => {
      folder = copy.cwd;
      expect(copy.members).toEqual(members);
      expect(readFileSync(join(copy.cwd, 'one.txt'), 'utf8')).toBe('one\n');
      expect(readFileSync(join(copy.cwd, 'two.txt'), 'utf8')).toBe('two\n');
      expect(copy.testedTree).toBe(git(['rev-parse', 'HEAD^{tree}'], copy.cwd));
      expect(copy.head).toBe(git(['rev-parse', 'HEAD'], copy.cwd));
      expect(scratchMarkers()).toHaveLength(1);
      if (outcome === 'red') throw failure;
      if (outcome === 'abort') { controller.abort(failure); controller.signal.throwIfAborted(); }
      return 'passed';
    }, controller.signal);
    if (outcome === 'green') await expect(result).resolves.toBe('passed');
    else await expect(result).rejects.toBe(failure);
    expect(folder).not.toBe('');
    expect(existsSync(folder)).toBe(false);
    expect(git(['branch', '--list', 'combined-gate-checks-*'])).toBe('');
    expect(scratchMarkers()).toEqual([]);
    expect(git(['rev-parse', 'main'])).toBe(base);
    expect(existsSync(join(repo, 'one.txt'))).toBe(false);
  });

  it('omits an overlapping member and keeps the remaining independent member', async () => {
    const first = await member('one', 'shared.txt', 'one\n');
    const conflict = await member('two', 'shared.txt', 'two\n');
    const third = await member('three', 'other.txt', 'other\n');
    await service.withCombinedCopy(repo, base, [first, conflict, third], async copy => {
      expect(copy.members).toEqual([first, third]);
      expect(readFileSync(join(copy.cwd, 'shared.txt'), 'utf8')).toBe('one\n');
      expect(readFileSync(join(copy.cwd, 'other.txt'), 'utf8')).toBe('other\n');
      expect(git(['ls-files', '-u'], copy.cwd)).toBe('');
    });
    expect(scratchMarkers()).toEqual([]);
  });

  it('runs no checklist when fewer than two members remain after conflicts', async () => {
    const members = [await member('one', 'shared.txt', 'one\n'), await member('two', 'shared.txt', 'two\n')];
    const action = vi.fn(async () => 'should not run');
    await expect(service.withCombinedCopy(repo, base, members, action)).resolves.toBeUndefined();
    expect(action).not.toHaveBeenCalled();
    expect(git(['branch', '--list', 'combined-gate-checks-*'])).toBe('');
  });

  it('omits a member that conflicts with the frozen base before creating the copy', async () => {
    const conflicting = await member('conflict', 'base.txt', 'member\n');
    writeFileSync(join(repo, 'base.txt'), 'new base\n');
    git(['commit', '-qam', 'main advanced']);
    const tip = git(['rev-parse', 'main']);
    const first = await member('one', 'one.txt', 'one\n');
    const second = await member('two', 'two.txt', 'two\n');
    await service.withCombinedCopy(repo, tip, [first, conflicting, second], async copy => {
      expect(copy.members).toEqual([first, second]);
      expect(readFileSync(join(copy.cwd, 'base.txt'), 'utf8')).toBe('new base\n');
    });
  });

  it('retains ownership after cleanup failure and startup removes only a dead owner copy', async () => {
    const members = [await member('one', 'one.txt', 'one\n'), await member('two', 'two.txt', 'two\n')];
    const manager = WorktreeManager.getInstance();
    const failure = new Error('Cleanup temporarily unavailable');
    vi.spyOn(manager, 'cleanupWorktree').mockRejectedValueOnce(failure);
    let folder = '';
    await expect(service.withCombinedCopy(repo, base, members, async copy => { folder = copy.cwd; })).rejects.toBe(failure);
    expect(existsSync(folder)).toBe(true);
    const marker = scratchMarkers()[0];
    expect(marker).toBeTruthy();
    WorktreeManager._resetForTesting();
    service = createService();
    await service.cleanupScratchCopies([repo]);
    expect(existsSync(folder)).toBe(true);
    const data = JSON.parse(readFileSync(marker, 'utf8')) as { ownerPid: number };
    data.ownerPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
    writeFileSync(marker, JSON.stringify(data));
    await service.cleanupScratchCopies([repo]);
    expect(existsSync(folder)).toBe(false);
    expect(scratchMarkers()).toEqual([]);
    expect(git(['branch', '--list', 'combined-gate-checks-*'])).toBe('');
    expect(git(['branch', '--list', 'queue/*']).split('\n')).toHaveLength(2);
  });

  it('uses the same durable cleanup for base comparison copies', async () => {
    const manager = WorktreeManager.getInstance();
    vi.spyOn(manager, 'cleanupWorktree').mockRejectedValueOnce(new Error('Interrupted cleanup'));
    let folder = '';
    await expect(service.withBaseline(repo, base, async cwd => { folder = cwd; })).rejects.toThrow('Interrupted cleanup');
    const marker = scratchMarkers()[0];
    const data = JSON.parse(readFileSync(marker, 'utf8')) as { ownerPid: number };
    data.ownerPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
    writeFileSync(marker, JSON.stringify(data));
    WorktreeManager._resetForTesting();
    await createService().cleanupScratchCopies([repo]);
    expect(existsSync(folder)).toBe(false);
    expect(scratchMarkers()).toEqual([]);
    expect(git(['branch', '--list', 'base-gate-checks-*'])).toBe('');
  });

  it('refuses a base copy when an install changes its committed HEAD', async () => {
    service = new PlanQueueWorktreeService({ repoRootForItem: () => repo, creator: WorktreeManager.getInstance(),
      saveItem: () => undefined });
    vi.spyOn(dependencyProvisioning, 'provisionWorktreeDependencies').mockImplementation(async (_root, cwd) => {
      git(['commit', '--no-verify', '--allow-empty', '-qm', 'install changed HEAD'], cwd);
      return { method: 'skipped', symlinks: [], nativeAbi: [] };
    });
    const action = vi.fn(async () => undefined);
    await expect(service.withBaseline(repo, base, action)).rejects.toThrow(/changed/);
    expect(action).not.toHaveBeenCalled();
    expect(scratchMarkers()).toEqual([]);
    expect(git(['branch', '--list', 'base-gate-checks-*'])).toBe('');
  });

  it('continues startup cleanup when a saved project folder no longer exists', async () => {
    await expect(service.cleanupScratchCopies([join(repo, 'removed-project'), repo])).resolves.toBeUndefined();
  });

  it('finds a dead check copy through another checkout of the same repository', async () => {
    await member('one', 'one.txt', 'one\n');
    const manager = WorktreeManager.getInstance();
    const anotherCheckout = manager.getAllSessions()[0].worktreePath;
    vi.spyOn(manager, 'cleanupWorktree').mockRejectedValueOnce(new Error('Interrupted cleanup'));
    let folder = '';
    await expect(service.withBaseline(repo, base, async cwd => { folder = cwd; })).rejects.toThrow('Interrupted cleanup');
    const marker = scratchMarkers()[0];
    const data = JSON.parse(readFileSync(marker, 'utf8')) as { ownerPid: number };
    data.ownerPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
    writeFileSync(marker, JSON.stringify(data));
    WorktreeManager._resetForTesting();
    await createService().cleanupScratchCopies([anotherCheckout]);
    expect(existsSync(folder)).toBe(false);
    expect(scratchMarkers()).toEqual([]);
  });

  it('finishes a cleanup interrupted after the folder was removed', async () => {
    const manager = WorktreeManager.getInstance();
    const cleanup = manager.cleanupWorktree.bind(manager);
    vi.spyOn(manager, 'cleanupWorktree').mockImplementationOnce(async id => {
      await cleanup(id, { force: true, retainBranch: true });
      throw new Error('Interrupted after directory removal');
    });
    await expect(service.withBaseline(repo, base, async () => undefined)).rejects.toThrow('Interrupted after directory removal');
    const marker = scratchMarkers()[0];
    const data = JSON.parse(readFileSync(marker, 'utf8')) as { ownerPid: number; branchName: string };
    data.ownerPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
    writeFileSync(marker, JSON.stringify(data));
    WorktreeManager._resetForTesting();
    await createService().cleanupScratchCopies([repo]);
    expect(git(['branch', '--list', data.branchName])).toBe('');
    expect(scratchMarkers()).toEqual([]);
  });

  it('leaves a foreign checkout untouched even when a stale marker names its path', async () => {
    const manager = WorktreeManager.getInstance();
    vi.spyOn(manager, 'cleanupWorktree').mockRejectedValueOnce(new Error('Interrupted cleanup'));
    await expect(service.withBaseline(repo, base, async () => undefined)).rejects.toThrow('Interrupted cleanup');
    const marker = scratchMarkers()[0];
    const data = JSON.parse(readFileSync(marker, 'utf8')) as { ownerPid: number; worktreePath: string };
    const foreign = await member('personal', 'personal.txt', 'keep me\n');
    const owned = manager.getAllSessions().find(session => session.branchName.startsWith('queue/'))!;
    data.ownerPid = Number(execFileSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }));
    data.worktreePath = owned.worktreePath;
    writeFileSync(marker, JSON.stringify(data));
    WorktreeManager._resetForTesting();
    await createService().cleanupScratchCopies([repo]);
    expect(readFileSync(join(owned.worktreePath, 'personal.txt'), 'utf8')).toBe('keep me\n');
    expect(git(['rev-parse', 'HEAD'], owned.worktreePath)).toBe(foreign.head);
    expect(existsSync(marker)).toBe(true);
  });
});
