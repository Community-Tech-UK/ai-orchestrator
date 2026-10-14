import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLeftoverWorktreeReport, type LeftoverReportDependencies } from './leftover-worktree-report';
import { gitExec } from './git-exec';
import { hermeticGitEnv } from './git-env';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
let root: string;
let saved: string;
let merged: string;
let external: string | undefined;
let deps: LeftoverReportDependencies;
function git(args: string[], cwd = root): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...hermeticGitEnv(),
    GIT_AUTHOR_DATE: '2026-09-01T12:00:00Z', GIT_COMMITTER_DATE: '2026-09-01T12:00:00Z',
  } }).trim();
}
beforeEach(() => {
  external = undefined;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'leftover-report-')));
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'user.name', 'Fixture']);
  writeFileSync(join(root, 'base.txt'), 'base');
  git(['add', '.']); git(['commit', '-m', 'base']);
  saved = join(root, '.worktrees', 'saved');
  merged = join(root, '.worktrees', 'merged');
  git(['worktree', 'add', '-b', 'saved', saved]);
  writeFileSync(join(saved, 'saved.txt'), 'saved work');
  git(['add', '.'], saved); git(['commit', '-m', 'rescue: saved work'], saved);
  git(['worktree', 'add', '-b', 'merged', merged, 'main']);
  deps = { git: gitExec, now: () => Date.parse('2026-10-13T12:00:00Z'), currentCheckout: root,
    owners: () => [saved, merged].map((path) => ({ path, repoRoot: root, kind: 'loop' as const,
      id: path, status: 'completed-needs-review', phase: 'blocked', inUse: false })),
    liveSessions: () => [],
  };
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); if (external) rmSync(external, { recursive: true, force: true }); });
describe('leftover work folder report', () => {
  it('reports saved patches, changed files and merged branches', async () => {
    const report = await buildLeftoverWorktreeReport(root, deps);
    expect(report.rows.find((r) => r.path === saved)).toMatchObject({ category: 'saved-work',
      patchCount: 1, fileCount: 1, ahead: 1, mergedIntoMain: false, removableByHarness: true });
    expect(report.rows.find((r) => r.path === merged)).toMatchObject({ category: 'nothing-to-save',
      patchCount: 0, mergedIntoMain: true, removableByHarness: true });
    expect(report.rows).toHaveLength(2);
  });
  it('never offers to remove Claude Code or unrecorded folders', async () => {
    const claude = join(root, '.claude', 'worktrees', 'agent');
    git(['worktree', 'add', '-b', 'agent', claude]);
    deps.owners = () => [];
    const report = await buildLeftoverWorktreeReport(root, deps);
    expect(report.rows.find((r) => r.path === claude)).toMatchObject({ createdBy: 'claude-code', removableByHarness: false });
    expect(report.rows.find((r) => r.path === saved)).toMatchObject({ createdBy: 'other', removableByHarness: false });
  });
  it('refuses dirty folders and marks live owners in use', async () => {
    writeFileSync(join(saved, 'untracked.txt'), 'unsaved');
    deps.liveSessions = () => [{ id: 'live', cwd: merged }];
    const report = await buildLeftoverWorktreeReport(root, deps);
    expect(report.rows.find((r) => r.path === saved)).toMatchObject({ dirtyCount: 1, removableByHarness: false });
    expect(report.rows.find((r) => r.path === merged)).toMatchObject({ category: 'in-use', inUse: true, removableByHarness: false });
  });
  it('only executes read-only git commands', async () => {
    const commands: string[][] = [];
    deps.git = (args, cwd) => { commands.push(args); return gitExec(args, cwd); };
    await buildLeftoverWorktreeReport(root, deps);
    expect(commands.length).toBeGreaterThan(5);
    expect(commands.every((args) => args[0] === '--no-optional-locks')).toBe(true);
    expect(commands.flat()).not.toEqual(expect.arrayContaining(['fetch', 'gc', 'prune', 'remove']));
  });
  it('keeps recent and current checkouts visible but disables removal', async () => {
    deps.now = () => Date.parse('2026-09-02T12:00:00Z');
    deps.currentCheckout = saved;
    const report = await buildLeftoverWorktreeReport(root, deps);
    expect(report.rows.find((r) => r.path === saved)).toMatchObject({ inUse: true, removableByHarness: false });
    expect(report.rows.find((r) => r.path === merged)).toMatchObject({ leftover: false, removableByHarness: false });
  });
  it('lists an external detached worktree as other and never removable', async () => {
    external = `${root}-external`;
    git(['worktree', 'add', '--detach', external, 'main']);
    const report = await buildLeftoverWorktreeReport(root, deps);
    expect(report.rows.find((r) => r.path === external)).toMatchObject({ createdBy: 'other', branch: null, removableByHarness: false });
  });
});
