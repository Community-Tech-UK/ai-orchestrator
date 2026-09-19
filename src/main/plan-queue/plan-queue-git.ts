/**
 * Small git reads and the verifier tree guard for the Plan Queue.
 *
 * The verifier must not change tracked files. The coordinator snapshots HEAD
 * and `git status` before verification and compares afterwards. A changed tree
 * discards the verdict, and only the verifier's own changes are reverted: the
 * worker's work was checkpointed before verification began, so the tree was
 * clean (apart from provisioned files) at the snapshot.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { gitExec, gitExecSafe } from '../workspace/git/git-exec';
import { hermeticGitEnv } from '../workspace/git/git-env';
import { getGitWriteQueue } from '../workspace/git/git-write-queue';

const execFileAsync = promisify(execFile);

export interface TreeSnapshot {
  head: string;
  /** `git status --porcelain -z` entries (`XY path`), sorted. Ignored files are not listed. */
  status: string[];
}

/**
 * Untrimmed: a status entry may start with a space (` M file`), which the
 * trimming `gitExec` would eat from the first entry.
 */
async function statusLines(worktreePath: string): Promise<string[]> {
  const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-z', '--untracked-files=all', '--no-renames'], {
    cwd: worktreePath,
    env: hermeticGitEnv(),
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return String(stdout).split('\0').filter(Boolean).sort();
}

export async function snapshotTree(worktreePath: string): Promise<TreeSnapshot> {
  return {
    head: await gitExec(['rev-parse', 'HEAD'], worktreePath),
    status: await statusLines(worktreePath),
  };
}

export function sameTree(a: TreeSnapshot, b: TreeSnapshot): boolean {
  return a.head === b.head && a.status.length === b.status.length && a.status.every((line, i) => line === b.status[i]);
}

/**
 * Put the worktree back to `before`: abandon a merge in progress, drop commits
 * the verifier made, restore
 * tracked files it changed, delete untracked files it created. Paths that were
 * already dirty in `before` are left alone.
 */
export async function revertToSnapshot(worktreePath: string, before: TreeSnapshot): Promise<void> {
  await getGitWriteQueue().enqueue('plan-queue-verifier-revert', async () => {
    // Every snapshot is taken with no merge in progress (verification starts
    // from a checkpoint, which completes or refuses a merge). A merge found now
    // was started by the verifier, or by the coordinator just before a crash:
    // abandon it, or the next sync fails on the leftover MERGE_HEAD.
    if (await mergeInProgress(worktreePath)) await gitExec(['merge', '--abort'], worktreePath);
    const head = await gitExec(['rev-parse', 'HEAD'], worktreePath);
    if (head !== before.head) {
      // --soft keeps the verifier's committed changes in the index so the
      // path-level restore below removes them like any other change.
      await gitExec(['reset', '--soft', before.head], worktreePath);
    }
    const preexisting = new Set(before.status);
    const introduced = (await statusLines(worktreePath)).filter((line) => !preexisting.has(line));
    const tracked: string[] = [];
    const added: string[] = [];
    const untracked: string[] = [];
    for (const line of introduced) {
      const file = line.slice(3);
      if (line.startsWith('??')) untracked.push(file);
      else if (line[0] === 'A') added.push(file); // not in `before.head`, so nothing to restore
      else tracked.push(file);
    }
    if (added.length) {
      await gitExec(['rm', '-f', '-q', '--', ...added], worktreePath);
    }
    if (tracked.length) {
      await gitExec(['restore', '--source', before.head, '--staged', '--worktree', '--', ...tracked], worktreePath);
    }
    if (untracked.length) {
      await gitExec(['clean', '-f', '--', ...untracked], worktreePath);
    }
  });
}

/** Porcelain codes of an unmerged path (`git status` "Unmerged paths"). */
export const CONFLICT_CODES: ReadonlySet<string> = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);

/**
 * Thrown by a checkpoint that finds a merge still conflicted. Committing then
 * would complete the merge with the conflict markers inside it.
 */
export class UnresolvedMergeError extends Error {
  constructor(readonly conflictFiles: string[]) {
    super(`A merge is in progress with unresolved conflicts: ${conflictFiles.join(', ')}`);
    this.name = 'UnresolvedMergeError';
  }
}

export async function mergeInProgress(worktreePath: string): Promise<boolean> {
  return gitExec(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], worktreePath).then(() => true, () => false);
}

/**
 * The conflicted paths of an in-progress merge, or null when no merge is in
 * progress. An empty list means the merge is resolved and only needs committing.
 */
export async function unresolvedMergeFiles(worktreePath: string): Promise<string[] | null> {
  if (!(await mergeInProgress(worktreePath))) return null;
  return (await statusLines(worktreePath))
    .filter((line) => CONFLICT_CODES.has(line.slice(0, 2)))
    .map((line) => line.slice(3));
}

export async function currentBranch(repoRoot: string): Promise<string> {
  return gitExec(['branch', '--show-current'], repoRoot);
}

export async function repositoryRoot(cwd: string): Promise<string> {
  return gitExec(['rev-parse', '--show-toplevel'], cwd);
}

export async function branchExists(repoRoot: string, branchName: string): Promise<boolean> {
  return gitExec(['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`], repoRoot).then(() => true, () => false);
}

export async function commitsAhead(repoRoot: string, baseBranch: string, branchName: string): Promise<number> {
  const count = await gitExecSafe(['rev-list', '--count', `${baseBranch}..${branchName}`], repoRoot);
  return count ? Number.parseInt(count, 10) || 0 : 0;
}

export async function diffStat(repoRoot: string, baseBranch: string, branchName: string): Promise<string> {
  return gitExecSafe(['diff', '--shortstat', `${baseBranch}...${branchName}`], repoRoot);
}
