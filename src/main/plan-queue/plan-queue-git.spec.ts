import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { commitsAhead, mergeInProgress, revertToSnapshot, sameTree, snapshotTree, unresolvedMergeFiles } from './plan-queue-git';

let repo: string;
const git = (args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

beforeEach(() => {
  GitWriteQueue._resetForTesting();
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-git-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'T']);
  git(['config', 'user.email', 't@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  writeFileSync(join(repo, 'b.txt'), 'b\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
  GitWriteQueue._resetForTesting();
});

describe('verifier tree guard', () => {
  it('sees a first-entry leading-space status (" M") as a change', async () => {
    const before = await snapshotTree(repo);
    writeFileSync(join(repo, 'a.txt'), 'changed\n');
    const after = await snapshotTree(repo);
    expect(after.status).toEqual([' M a.txt']);
    expect(sameTree(before, after)).toBe(false);
  });

  it('reverts only what the verifier changed: a commit, an edit, a staged add and an untracked file', async () => {
    writeFileSync(join(repo, 'provisioned.local'), 'port=1\n');
    const before = await snapshotTree(repo);

    writeFileSync(join(repo, 'a.txt'), 'verifier commit\n');
    git(['commit', '-q', '-am', 'verifier commit']);
    writeFileSync(join(repo, 'b.txt'), 'verifier edit\n');
    writeFileSync(join(repo, 'staged.txt'), 'x\n');
    git(['add', 'staged.txt']);
    writeFileSync(join(repo, 'scratch.txt'), 'x\n');

    await revertToSnapshot(repo, before);

    expect(sameTree(before, await snapshotTree(repo))).toBe(true);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('a\n');
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('b\n');
    expect(existsSync(join(repo, 'staged.txt'))).toBe(false);
    expect(existsSync(join(repo, 'scratch.txt'))).toBe(false);
    expect(readFileSync(join(repo, 'provisioned.local'), 'utf8')).toBe('port=1\n');
  });

  it('counts commits a branch has over its base', async () => {
    git(['checkout', '-q', '-b', 'queue/x']);
    writeFileSync(join(repo, 'c.txt'), 'c\n');
    git(['add', 'c.txt']);
    git(['commit', '-q', '-m', 'c']);
    expect(await commitsAhead(repo, 'main', 'queue/x')).toBe(1);
    expect(await commitsAhead(repo, 'main', 'missing')).toBe(0);
  });

  it('reports an in-progress merge and its unmerged paths', async () => {
    expect(await unresolvedMergeFiles(repo)).toBeNull();
    startConflictedMerge();
    expect(await mergeInProgress(repo)).toBe(true);
    expect(await unresolvedMergeFiles(repo)).toEqual(['a.txt']);
    writeFileSync(join(repo, 'a.txt'), 'resolved\n');
    git(['add', 'a.txt']);
    // Resolved but not yet committed: still a merge, nothing unmerged.
    expect(await unresolvedMergeFiles(repo)).toEqual([]);
  });

  it('abandons a merge started after the snapshot, so a later sync is not blocked by MERGE_HEAD', async () => {
    const before = await snapshotTree(repo);
    startConflictedMerge();

    await revertToSnapshot(repo, before);

    expect(await mergeInProgress(repo)).toBe(false);
    expect(sameTree(before, await snapshotTree(repo))).toBe(true);
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('a\n');
  });
});

/** main gets a.txt="main"; `other` gets a.txt="other"; merging other into main conflicts. */
function startConflictedMerge(): void {
  git(['checkout', '-q', '-b', 'other']);
  writeFileSync(join(repo, 'a.txt'), 'other\n');
  git(['commit', '-q', '-am', 'other']);
  git(['checkout', '-q', 'main']);
  writeFileSync(join(repo, 'a.txt'), 'main\n');
  git(['commit', '-q', '-am', 'main']);
  try {
    git(['merge', '--no-edit', 'other']);
  } catch {
    // Expected: the merge stops with a conflict.
  }
}
