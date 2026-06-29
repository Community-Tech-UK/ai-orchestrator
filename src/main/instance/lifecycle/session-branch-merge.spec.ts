import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mergeSessionBranchToMain } from './session-branch-merge';

function g(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

describe('mergeSessionBranchToMain', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'sbm-'));
    g(repo, 'init', '-q', '-b', 'main');
    g(repo, 'config', 'user.email', 'test@example.com');
    g(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-qm', 'base');
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('merges a clean session branch into main and deletes it', async () => {
    g(repo, 'switch', '-qc', 'kit-gui-polish');
    writeFileSync(join(repo, 'b.txt'), 'work\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-qm', 'work');

    const res = await mergeSessionBranchToMain(repo);

    expect(res.merged).toBe(true);
    expect(res.reason).toBe('merged');
    expect(g(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
    expect(g(repo, 'ls-files', 'b.txt')).toBe('b.txt'); // work landed on main
    expect(() => g(repo, 'rev-parse', '--verify', 'kit-gui-polish')).toThrow(); // branch gone
  });

  it('aborts safely on conflict and leaves the branch intact', async () => {
    g(repo, 'switch', '-qc', 'feature');
    writeFileSync(join(repo, 'a.txt'), 'feature\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-qm', 'feat');
    g(repo, 'switch', '-q', 'main');
    writeFileSync(join(repo, 'a.txt'), 'mainedit\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-qm', 'mainedit');
    g(repo, 'switch', '-q', 'feature');

    const res = await mergeSessionBranchToMain(repo);

    expect(res.merged).toBe(false);
    expect(res.reason).toBe('conflict');
    expect(g(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('feature'); // back on branch
    expect(g(repo, 'status', '--porcelain')).toBe(''); // no conflict markers left
  });

  it('skips when the branch has no new commits', async () => {
    g(repo, 'switch', '-qc', 'empty');
    const res = await mergeSessionBranchToMain(repo);
    expect(res.merged).toBe(false);
    expect(res.reason).toBe('no-commits');
  });

  it('skips when the working tree is dirty', async () => {
    g(repo, 'switch', '-qc', 'dirty');
    writeFileSync(join(repo, 'b.txt'), 'c\n');
    g(repo, 'add', '-A');
    g(repo, 'commit', '-qm', 'c');
    writeFileSync(join(repo, 'b.txt'), 'uncommitted\n'); // leave dirty
    const res = await mergeSessionBranchToMain(repo);
    expect(res.merged).toBe(false);
    expect(res.reason).toBe('dirty');
  });

  it('skips when already on the base branch', async () => {
    const res = await mergeSessionBranchToMain(repo);
    expect(res.merged).toBe(false);
    expect(res.reason).toBe('on-base');
  });
});
