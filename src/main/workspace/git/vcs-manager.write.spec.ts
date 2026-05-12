/**
 * VcsManager write-action tests (stage / unstage).
 *
 * Phase 2d of the source-control phase-2 plan. These exercise the real
 * `git` binary against a temporary repo so we catch flag-handling
 * regressions (the plan explicitly mandates `--` before path args to
 * prevent option-injection through filenames).
 *
 * Each test:
 *   1. Spins up a fresh git repo in $TMPDIR.
 *   2. Writes / stages files via the SUT.
 *   3. Reads back `git status --porcelain=v2` to assert the actual
 *      tree/index state the user would see in the panel.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { VcsManager } from './vcs-manager';

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).toString();
}

async function makeRepo(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  run(dir, ['init', '--quiet', '-b', 'main']);
  // Configure deterministically so commits succeed without prompts.
  run(dir, ['config', 'user.email', 'test@example.com']);
  run(dir, ['config', 'user.name', 'Test']);
  run(dir, ['config', 'commit.gpgsign', 'false']);
  return dir;
}

function porcelain(cwd: string): string {
  return run(cwd, ['status', '--porcelain=v2']);
}

describe('VcsManager stageFiles / unstageFiles', () => {
  const tempPaths: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempPaths.map(tempPath => fs.rm(tempPath, { recursive: true, force: true })),
    );
    tempPaths.length = 0;
  });

  it('stages an untracked file', async () => {
    const repo = await makeRepo('vcs-stage-');
    tempPaths.push(repo);

    await fs.writeFile(path.join(repo, 'a.txt'), 'hello\n');

    const vcs = new VcsManager(repo);
    const result = await vcs.stageFiles(['a.txt']);

    expect(result.exitCode).toBe(0);
    // Porcelain v2: `1 A. N... 100644 ... a.txt` = added in index, unchanged worktree
    expect(porcelain(repo)).toMatch(/^1 A\. .* a\.txt$/m);
  });

  it('stages multiple files in one call', async () => {
    const repo = await makeRepo('vcs-stage-multi-');
    tempPaths.push(repo);

    await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');
    await fs.writeFile(path.join(repo, 'b.txt'), 'b\n');

    const vcs = new VcsManager(repo);
    const result = await vcs.stageFiles(['a.txt', 'b.txt']);

    expect(result.exitCode).toBe(0);
    const out = porcelain(repo);
    expect(out).toMatch(/a\.txt$/m);
    expect(out).toMatch(/b\.txt$/m);
  });

  it('unstages a previously-staged file via git restore --staged', async () => {
    const repo = await makeRepo('vcs-unstage-');
    tempPaths.push(repo);

    // Create + commit an initial baseline so `git restore --staged` has a
    // HEAD to compare against (otherwise unstaging "added" rows requires
    // `git rm --cached`, which is different semantics).
    await fs.writeFile(path.join(repo, 'a.txt'), 'v1\n');
    run(repo, ['add', '--', 'a.txt']);
    run(repo, ['commit', '--quiet', '-m', 'init']);

    // Modify + stage
    await fs.writeFile(path.join(repo, 'a.txt'), 'v2\n');
    run(repo, ['add', '--', 'a.txt']);
    // Now status should show 1 M. (staged modify)
    expect(porcelain(repo)).toMatch(/^1 M\. .* a\.txt$/m);

    const vcs = new VcsManager(repo);
    const result = await vcs.unstageFiles(['a.txt']);

    expect(result.exitCode).toBe(0);
    // After unstage, the modification should be on the worktree side only:
    // `1 .M ...` = index unchanged, worktree modified.
    expect(porcelain(repo)).toMatch(/^1 \.M .* a\.txt$/m);
  });

  it('uses the -- separator so a path that looks like a flag is treated as a file', async () => {
    const repo = await makeRepo('vcs-stage-dashfile-');
    tempPaths.push(repo);

    // Create a file whose name LOOKS like a git option. Without the `--`
    // separator, `git add -force.txt` would error or behave oddly.
    const filename = '--force.txt';
    await fs.writeFile(path.join(repo, filename), 'x\n');

    const vcs = new VcsManager(repo);
    const result = await vcs.stageFiles([filename]);

    expect(result.exitCode).toBe(0);
    // Should now be a staged "added" entry, not an error.
    expect(porcelain(repo)).toMatch(/-{2}force\.txt$/m);
  });

  it('stageFiles is a no-op when paths is empty', async () => {
    const repo = await makeRepo('vcs-stage-empty-');
    tempPaths.push(repo);

    const vcs = new VcsManager(repo);
    const result = await vcs.stageFiles([]);

    // No spawn — synthetic result.
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    // Args should reflect the no-op shape ('add --').
    expect(result.args).toEqual(['add', '--']);
  });

  it('unstageFiles is a no-op when paths is empty', async () => {
    const repo = await makeRepo('vcs-unstage-empty-');
    tempPaths.push(repo);

    const vcs = new VcsManager(repo);
    const result = await vcs.unstageFiles([]);

    expect(result.exitCode).toBe(0);
    expect(result.args).toEqual(['restore', '--staged', '--']);
  });

  it('emits audit-hook events with cwd, args, and exit code', async () => {
    const repo = await makeRepo('vcs-audit-');
    tempPaths.push(repo);

    await fs.writeFile(path.join(repo, 'a.txt'), 'a\n');

    const events: { args: string[]; cwd: string; exitCode: number | null }[] = [];
    const vcs = new VcsManager(repo, {
      onCommand: ev => events.push({ args: ev.args, cwd: ev.cwd, exitCode: ev.exitCode }),
    });
    await vcs.stageFiles(['a.txt']);

    expect(events.length).toBe(1);
    expect(events[0].args).toEqual(['add', '--', 'a.txt']);
    expect(events[0].cwd).toBe(repo);
    expect(events[0].exitCode).toBe(0);
  });
});
