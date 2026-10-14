import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CleanupTicketStore } from '../../storage/cleanup-ticket';
import { LeftoverWorktreeRemoval } from './leftover-worktree-removal';
import type { LeftoverReportDependencies } from './leftover-worktree-report';
import { GitWriteQueue } from './git-write-queue';
import { hermeticGitEnv } from './git-env';
import { reconcileManagedWorktreeLifecycles, type PendingManagedWorktreeLifecycle } from '../../orchestration/loop-worktree-lifecycle-reconcile';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
let root: string;
let path: string;
let now: number;
let service: LeftoverWorktreeRemoval;
let deps: LeftoverReportDependencies;
function git(args: string[], cwd = root): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...hermeticGitEnv(),
    GIT_AUTHOR_DATE: '2026-09-01T12:00:00Z', GIT_COMMITTER_DATE: '2026-09-01T12:00:00Z',
  } }).trim();
}
function request(action: 'remove-folder' | 'remove-folder-and-branch' | 'discard-saved-work' = 'remove-folder') {
  return { repoRoot: root, path, action };
}
beforeEach(() => {
  GitWriteQueue._resetForTesting();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'leftover-remove-')));
  git(['init', '-b', 'main']); git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'user.name', 'Fixture']);
  writeFileSync(join(root, 'base'), 'base'); git(['add', '.']); git(['commit', '-m', 'base']);
  path = join(root, '.worktrees', 'saved'); git(['worktree', 'add', '-b', 'saved', path]);
  writeFileSync(join(path, 'change'), 'saved'); git(['add', '.'], path); git(['commit', '-m', 'rescue'], path);
  now = Date.parse('2026-10-13T12:00:00Z');
  deps = { currentCheckout: root, now: () => now, liveSessions: () => [],
    owners: () => [{ repoRoot: root, path, kind: 'loop', id: 'old-run', status: 'cap-reached', phase: 'blocked', inUse: false }] };
  service = new LeftoverWorktreeRemoval(deps, new CleanupTicketStore(() => now));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe('ask-first leftover removal', () => {
  it('refuses a run without a preview and leaves folder and branch unchanged', async () => {
    const before = git(['worktree', 'list', '--porcelain']);
    await expect(service.runLeftoverRemoval({ ...request(), previewId: 'missing' })).rejects.toThrow();
    expect(git(['worktree', 'list', '--porcelain'])).toBe(before);
    expect(git(['branch', '--list', 'saved'])).toContain('saved');
  });
  it('refuses an expired preview', async () => {
    const preview = await service.previewLeftoverRemoval(request());
    now += 10 * 60_000 + 1;
    await expect(service.runLeftoverRemoval({ ...request(), previewId: preview.previewId })).rejects.toThrow(/expired/i);
    expect(existsSync(path)).toBe(true);
  });
  it('refuses a changed tip or dirty folder', async () => {
    const preview = await service.previewLeftoverRemoval(request());
    writeFileSync(join(path, 'another'), 'new'); git(['add', '.'], path); git(['commit', '-m', 'new'], path);
    await expect(service.runLeftoverRemoval({ ...request(), previewId: preview.previewId })).rejects.toThrow();
    const next = await service.previewLeftoverRemoval(request());
    writeFileSync(join(path, 'another'), 'dirty');
    await expect(service.runLeftoverRemoval({ ...request(), previewId: next.previewId })).rejects.toThrow();
    expect(existsSync(path)).toBe(true);
  });
  it('removes just the folder and keeps its saved branch, with a single-use ticket', async () => {
    const preview = await service.previewLeftoverRemoval(request());
    expect(preview.consequence).toContain('stays on its branch');
    await service.runLeftoverRemoval({ ...request(), previewId: preview.previewId });
    expect(existsSync(path)).toBe(false);
    expect(git(['branch', '--list', 'saved'])).toContain('saved');
    await expect(service.runLeftoverRemoval({ ...request(), previewId: preview.previewId })).rejects.toThrow();
  });
  it('only removes a merged branch with remove-folder-and-branch', async () => {
    await expect(service.previewLeftoverRemoval(request('remove-folder-and-branch'))).rejects.toThrow(/main/i);
    git(['merge', '--ff-only', 'saved']);
    const preview = await service.previewLeftoverRemoval(request('remove-folder-and-branch'));
    await service.runLeftoverRemoval({ ...request('remove-folder-and-branch'), previewId: preview.previewId });
    expect(existsSync(path)).toBe(false);
    expect(git(['branch', '--list', 'saved'])).toBe('');
    expect(git(['branch', '--show-current'])).toBe('main');
  });
  it('requires explicit confirmation before discarding saved work', async () => {
    const preview = await service.previewLeftoverRemoval(request('discard-saved-work'));
    expect(preview.consequence).toContain('1 files');
    await expect(service.runLeftoverRemoval({ ...request('discard-saved-work'), previewId: preview.previewId })).rejects.toThrow(/explicit/i);
    expect(existsSync(path)).toBe(true);
    const accepted = await service.previewLeftoverRemoval(request('discard-saved-work'));
    await service.runLeftoverRemoval({ ...request('discard-saved-work'), previewId: accepted.previewId, discardSavedWork: true });
    expect(git(['branch', '--list', 'saved'])).toBe('');
  });
  it('refuses outside paths and symlink aliases', async () => {
    await expect(service.previewLeftoverRemoval({ ...request(), path: root })).rejects.toThrow();
    const alias = join(root, '.worktrees', 'alias'); symlinkSync(path, alias);
    await expect(service.previewLeftoverRemoval({ ...request(), path: alias })).rejects.toThrow(/symlink/i);
    expect(existsSync(path)).toBe(true);
  });
  it('re-checks ownership inside the queue when a loop resumes after preview', async () => {
    const preview = await service.previewLeftoverRemoval(request());
    deps.owners = () => [{ repoRoot: root, path, kind: 'loop', id: 'old-run', status: 'running', inUse: true }];
    await expect(service.runLeftoverRemoval({ ...request(), previewId: preview.previewId })).rejects.toThrow();
    expect(existsSync(path)).toBe(true);
  });
  it('checks again when an owner resumes during the final Git reads', async () => {
    const preview = await service.previewLeftoverRemoval(request());
    let reads = 0;
    deps.owners = () => [{ repoRoot: root, path, kind: 'loop', id: 'old-run',
      status: ++reads === 1 ? 'cap-reached' : 'running', phase: 'blocked', inUse: reads > 1 }];
    await expect(service.runLeftoverRemoval({ ...request(), previewId: preview.previewId })).rejects.toThrow(/now in use/i);
    expect(existsSync(path)).toBe(true);
  });
  it.each([
    ['completed-needs-review', 'remove-folder', 'blocked', 'Managed session branch identity could not be verified'],
    ['completed-needs-review', 'discard-saved-work', 'blocked', 'Durable session branch is missing'],
    ['cap-reached', 'discard-saved-work', 'cleaned', undefined],
  ] as const)('restart preserves lifecycle safety for %s after %s', async (status, action, phase, error) => {
    const mainTip = git(['rev-parse', 'main']);
    const row: PendingManagedWorktreeLifecycle = { id: 'blocked', status, workspaceCwd: root,
      worktreePath: path, branchName: 'saved', autoIntegrateWorktree: true,
      lifecycle: { managedByAio: true, phase: 'blocked', baseBranch: 'main', sessionBranch: 'saved',
        sessionTip: mainTip, updatedAt: 1 } };
    const preview = await service.previewLeftoverRemoval(request(action));
    await service.runLeftoverRemoval({ ...request(action), previewId: preview.previewId, discardSavedWork: true });
    const clear = vi.fn();
    await reconcileManagedWorktreeLifecycles({ getPendingWorktreeLifecycles: () => [row],
      updateWorktreeLifecycle: (_id, lifecycle) => { row.lifecycle = lifecycle; }, clearWorktreeInfo: clear });
    expect(row.lifecycle.phase).toBe(phase); expect(row.lifecycle.lastError).toBe(error);
    expect(clear).toHaveBeenCalledTimes(phase === 'cleaned' ? 1 : 0);
    expect(git(['rev-parse', 'main'])).toBe(mainTip);
    expect(git(['branch', '--list', 'integration/*'])).toBe('');
  });
});
