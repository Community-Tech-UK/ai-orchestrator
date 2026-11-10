import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
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

  describe('files Git ignores', () => {
    function ignore(...patterns: string[]): void {
      writeFileSync(join(repo, '.git', 'info', 'exclude'), `${patterns.join('\n')}\n`);
    }

    function commitOn(branch: string, file: string, content: string): void {
      g(repo, 'switch', '-q', branch);
      writeFileSync(join(repo, file), content);
      g(repo, 'add', '-A');
      g(repo, 'commit', '-qm', file);
    }

    it('does not switch to main over an ignored file that main now tracks', async () => {
      g(repo, 'branch', 'feature');
      commitOn('main', 'late.txt', 'late\n');
      commitOn('feature', 'b.txt', 'work\n');
      ignore('late.txt');
      writeFileSync(join(repo, 'late.txt'), 'mine\n');

      const res = await mergeSessionBranchToMain(repo);

      expect(res).toMatchObject({ merged: false, reason: 'error', detail: 'could not switch to base branch' });
      expect(readFileSync(join(repo, 'late.txt'), 'utf8')).toBe('mine\n');
      expect(g(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('feature');
    });

    it('does not merge when the merge would move a file onto an ignored one', async () => {
      // main renames docs/ after the branch adds a file there, so the merge puts that file in
      // documents/, where an ignored one already sits. Even an aborted merge used to delete it.
      mkdirSync(join(repo, 'docs'));
      commitOn('main', 'docs/old.md', 'old\n');
      g(repo, 'branch', 'feature');
      commitOn('feature', 'docs/new.md', 'new\n');
      g(repo, 'switch', '-q', 'main');
      g(repo, 'mv', 'docs', 'documents');
      g(repo, 'commit', '-qm', 'rename docs');
      g(repo, 'switch', '-q', 'feature');
      ignore('documents/new.md');
      mkdirSync(join(repo, 'documents'));
      writeFileSync(join(repo, 'documents', 'new.md'), 'mine\n');
      const mainBefore = g(repo, 'rev-parse', 'main');

      const res = await mergeSessionBranchToMain(repo);

      expect(res).toEqual({
        merged: false,
        reason: 'ignored-files',
        branch: 'feature',
        base: 'main',
        detail: 'The main folder has a file Git ignores at documents/new.md, which Git would replace without asking'
          + ' if this goes ahead. Move it out of the way.',
      });
      expect(readFileSync(join(repo, 'documents', 'new.md'), 'utf8')).toBe('mine\n');
      expect(g(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('feature');
      expect(g(repo, 'rev-parse', 'main')).toBe(mainBefore);
    });

    it('reports why when it cannot work out the merge, and goes back to the branch', async () => {
      g(repo, 'switch', '-q', '--orphan', 'unrelated');
      writeFileSync(join(repo, 'other.txt'), 'other\n');
      g(repo, 'add', '-A');
      g(repo, 'commit', '-qm', 'unrelated history');

      const res = await mergeSessionBranchToMain(repo);

      expect(res).toMatchObject({
        merged: false,
        reason: 'error',
        detail: expect.stringMatching(/^could not work out what the merge would change: .*unrelated histories/s),
      });
      expect(g(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('unrelated');
    });

    describe('with an upstream', () => {
      let origin: string;

      beforeEach(() => {
        origin = mkdtempSync(join(tmpdir(), 'sbm-origin-'));
        g(tmpdir(), 'clone', '-q', repo, origin);
        g(origin, 'config', 'user.email', 'test@example.com');
        g(origin, 'config', 'user.name', 'Test');
        g(repo, 'remote', 'add', 'origin', origin);
        g(repo, 'fetch', '-q', 'origin');
        g(repo, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
        writeFileSync(join(origin, 'remote.txt'), 'remote\n');
        g(origin, 'add', '-A');
        g(origin, 'commit', '-qm', 'remote work');
        g(repo, 'switch', '-qc', 'feature');
        writeFileSync(join(repo, 'b.txt'), 'work\n');
        g(repo, 'add', '-A');
        g(repo, 'commit', '-qm', 'work');
      });

      afterEach(() => rmSync(origin, { recursive: true, force: true }));

      it('brings main up to date with its upstream before merging', async () => {
        const res = await mergeSessionBranchToMain(repo);

        expect(res).toMatchObject({ merged: true, reason: 'merged' });
        expect(g(repo, 'ls-files', 'remote.txt', 'b.txt').split('\n')).toEqual(['b.txt', 'remote.txt']);
      });

      it('skips that update, as git pull would, when main follows more than one upstream branch', async () => {
        g(origin, 'branch', 'other');
        g(repo, 'config', '--add', 'branch.main.merge', 'refs/heads/other');

        const res = await mergeSessionBranchToMain(repo);

        expect(res).toMatchObject({ merged: true, reason: 'merged' });
        expect(g(repo, 'ls-files', 'remote.txt')).toBe('');
        expect(g(repo, 'ls-files', 'b.txt')).toBe('b.txt');
      });

      it('skips that update rather than replace an ignored file, and still merges', async () => {
        ignore('remote.txt');
        writeFileSync(join(repo, 'remote.txt'), 'mine\n');

        const res = await mergeSessionBranchToMain(repo);

        expect(res).toMatchObject({ merged: true, reason: 'merged' });
        expect(readFileSync(join(repo, 'remote.txt'), 'utf8')).toBe('mine\n');
        expect(g(repo, 'ls-files', 'remote.txt')).toBe('');
        expect(g(repo, 'ls-files', 'b.txt')).toBe('b.txt');
      });
    });
  });
});
