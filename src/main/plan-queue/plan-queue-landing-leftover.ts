/**
 * Put back a checkout an interrupted landing left on a detached HEAD.
 *
 * `buildLandingCommit` detaches the item worktree at the base tip to build the
 * squash and always checks the item branch out again afterwards. When that
 * restore never runs (its Git command was killed, or the app stopped), every
 * later checkpoint refuses the folder, because it is no longer a checkout of
 * the item branch. Only landing itself used to repair it, so Pause, Resume and
 * the end of a round stayed stuck for good. A detach stopped before it moved
 * HEAD is the opposite trap: the folder looks fine, and the next checkpoint
 * would commit the base files mixed into it.
 */

import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { gitExec, WORKTREE_CHECKOUT_TIMEOUT_MS } from '../workspace/git/git-exec';
import { hermeticGitEnv } from '../workspace/git/git-env';
import { isOwnCheckout } from './plan-queue-git';

const execFileAsync = promisify(execFile);

/** How Git records the squash's `checkout --detach <full hash>` in the worktree's reflog. */
const DETACH_ENTRY = /^checkout: moving from (.+) to ([0-9a-f]{40}|[0-9a-f]{64})$/;

/** Operations whose state a forced checkout would destroy; none is part of a squash. */
const IN_PROGRESS_MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply'];

export const RESCUE_REF_PREFIX = 'refs/plan-queue/rescue/';

export interface LandingLeftoverRecovery {
  /** Set when some file matched neither side; the whole folder was saved there first. */
  rescueRef: string | null;
  /** Those files, which are only in the rescue commit, never on the branch. */
  unexplained: string[];
}

/**
 * Kept in the worktree's private git dir while a landing has the folder off
 * its branch: written (holding the base tip) before the detach, removed once
 * the branch is checked out again. It is what proves a folder still on its
 * branch was being rewritten when the landing stopped: a detach killed before
 * it moved HEAD leaves base files mixed into the branch's.
 */
export const LANDING_MARKER_FILE = 'plan-queue-landing';

/**
 * Returns null, touching nothing, unless the folder is provably the queue's
 * own leftover: the top of a linked checkout of its own, no merge, rebase,
 * cherry-pick or bisect in progress, and either
 *  - HEAD detached, with the newest reflog entry the queue's detach from this
 *    item's branch to the commit HEAD is on (nothing committed or checked out
 *    since, apart from the queue's own squash for this item); or
 *  - HEAD on the branch with the landing marker still present.
 *
 * The item's work is on its branch, so the folder is put back by checking the
 * branch out clean and removing untracked files the branch does not have.
 * A file on disk matching neither the branch tip nor the other side (HEAD, or
 * the marker's base tip) is never carried over: it may be an edit, but it may
 * as easily be a file a killed checkout left cut short, or a squash conflict
 * with its markers. Instead the whole folder is first saved as a commit under
 * `refs/plan-queue/rescue/`, so nothing is lost. `excluded` are the
 * provisioned paths, which are never the agent's work and are left alone.
 * Throws, changing nothing, when the folder holds a separate Git repository
 * the rescue commit could not save. Call inside the Git write queue.
 */
export async function recoverLandingLeftover(
  worktreePath: string,
  branchName: string,
  itemId: string,
  excluded: readonly string[],
): Promise<LandingLeftoverRecovery | null> {
  if (!(await isOwnCheckout(worktreePath))) return null;
  const gitfile = await fs.lstat(path.join(worktreePath, '.git')).catch(() => null);
  if (!gitfile?.isFile()) return null;
  const gitDir = await gitExec(['rev-parse', '--absolute-git-dir'], worktreePath);
  const marker = path.join(gitDir, LANDING_MARKER_FILE);
  const symbolic = await gitExec(['symbolic-ref', '-q', 'HEAD'], worktreePath).catch(() => '');
  const onBranch = symbolic === `refs/heads/${branchName}`;
  if (symbolic && !onBranch) return null;
  const markedBase = onBranch ? (await fs.readFile(marker, 'utf-8').catch(() => '')).trim() : '';
  if (onBranch && !markedBase) return null;
  for (const inProgress of IN_PROGRESS_MARKERS) {
    if (await exists(path.join(gitDir, inProgress))) return null;
  }
  const head = await gitExec(['rev-parse', 'HEAD'], worktreePath);
  if (!onBranch && !(await detachedByLanding(worktreePath, branchName, itemId, head))) return null;
  const branchTip = await gitExec(['rev-parse', '-q', '--verify', `refs/heads/${branchName}^{commit}`], worktreePath).catch(() => '');
  const otherSide = onBranch ? await gitExec(['rev-parse', '-q', '--verify', `${markedBase}^{commit}`], worktreePath).catch(() => '') : head;
  if (!branchTip || !otherSide) return null;

  const scratchIndex = path.join(gitDir, 'plan-queue-recovery-index');
  try {
    const isExcluded = (file: string) => excluded.some((p) => file === p || file.startsWith(`${p}/`));
    const offBranch = await pathsDifferingFrom(branchTip, worktreePath, scratchIndex);
    const nested = [...offBranch].find((file) => file.endsWith('/') && !isExcluded(file.slice(0, -1)));
    if (nested) {
      throw new Error(`The folder ${worktreePath} was left off its branch by a landing, but holds a separate Git repository at `
        + `${nested}, which cannot be set aside safely, so nothing was changed. Move that folder out, then resume.`);
    }
    const unexplained = [...await pathsDifferingFrom(otherSide, worktreePath, scratchIndex)]
      .filter((file) => offBranch.has(file) && !isExcluded(file))
      .sort();

    let rescueRef: string | null = null;
    if (unexplained.length) {
      const rescue = await commitFolder(worktreePath, scratchIndex, excluded, [...new Set([head, branchTip])],
        `Plan queue rescue: a checkout a landing left off its branch\n\nItem: ${itemId}\nBranch: ${branchName}`);
      rescueRef = `${RESCUE_REF_PREFIX}${itemId}-${Date.now()}`;
      await gitExec(['update-ref', rescueRef, rescue], worktreePath);
    }

    // `read-tree` first: a restore killed after writing the index but before
    // moving HEAD leaves an index that would hide the other side's files from
    // the checkout.
    await gitExec(['read-tree', head], worktreePath, WORKTREE_CHECKOUT_TIMEOUT_MS);
    await gitExec(['checkout', '-f', '-q', branchName], worktreePath, WORKTREE_CHECKOUT_TIMEOUT_MS);
    // Anything untracked now is not on the branch: the other side's files
    // (still in Git) or the unexplained ones (in the rescue commit). Left
    // here, the next checkpoint would commit them.
    const untracked = (await gitLarge(['ls-files', '-z', '--others', '--exclude-standard'], worktreePath)).split('\0');
    for (const file of untracked.filter((f) => f && !isExcluded(f))) await fs.rm(path.join(worktreePath, file), { force: true });
    for (const leftover of [LANDING_MARKER_FILE, 'SQUASH_MSG', 'MERGE_MSG', 'AUTO_MERGE']) await fs.rm(path.join(gitDir, leftover), { force: true });
    return { rescueRef, unexplained };
  } finally {
    await fs.rm(scratchIndex, { force: true });
  }
}

/** The newest reflog entry is the squash's detach from this branch to HEAD, or the squash commit right after it. */
async function detachedByLanding(worktreePath: string, branchName: string, itemId: string, head: string): Promise<boolean> {
  const [newest = '', previous = ''] = (await gitExec(['reflog', '-2', '--format=%gs', 'HEAD'], worktreePath).catch(() => '')).split('\n');
  // The squash's own commit may follow the detach when only the restore failed.
  const landed = newest.startsWith('commit: ') && await isLandingCommit(head, itemId, worktreePath);
  const detach = DETACH_ENTRY.exec(landed ? previous : newest);
  const detachedAt = landed ? await gitExec(['rev-parse', 'HEAD^'], worktreePath) : head;
  return Boolean(detach && detach[1] === branchName && detach[2] === detachedAt);
}

/** A squash commit `buildLandingCommit` made for this item: one parent, and the item line its message always ends with. */
async function isLandingCommit(commit: string, itemId: string, worktreePath: string): Promise<boolean> {
  const [parents, message] = await Promise.all([
    gitExec(['rev-list', '--parents', '-n', '1', commit], worktreePath),
    gitExec(['log', '-1', '--format=%B', commit], worktreePath),
  ]);
  return parents.split(' ').length === 2 && /^(Plan|Livetest): /.test(message) && message.endsWith(`\nItem: ${itemId}`);
}

async function exists(target: string): Promise<boolean> {
  return fs.lstat(target).then(() => true, () => false);
}

/** Git against a scratch index, so the checkout's own index is never read or changed. */
function gitWithIndex(args: string[], cwd: string, indexFile: string): Promise<string> {
  return gitLarge(args, cwd, indexFile);
}

/** Git with room for a whole large tree's output, against `indexFile` when given. */
async function gitLarge(args: string[], cwd: string, indexFile?: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: indexFile ? { ...hermeticGitEnv(), GIT_INDEX_FILE: indexFile } : hermeticGitEnv(),
    encoding: 'utf-8',
    maxBuffer: 256 * 1024 * 1024,
    timeout: WORKTREE_CHECKOUT_TIMEOUT_MS,
  });
  return String(stdout);
}

/** Paths whose content on disk differs from `commit`: changed, missing, or not in it at all. */
async function pathsDifferingFrom(commit: string, worktreePath: string, indexFile: string): Promise<Set<string>> {
  await gitWithIndex(['read-tree', commit], worktreePath, indexFile);
  const changed = await gitWithIndex(['diff', '--no-renames', '--name-only', '-z'], worktreePath, indexFile);
  const untracked = await gitWithIndex(['ls-files', '-z', '--others', '--exclude-standard'], worktreePath, indexFile);
  return new Set(`${changed}\0${untracked}`.split('\0').filter(Boolean));
}

/** Commit everything on disk (ignored and excluded paths aside) without touching HEAD, the index or hooks. */
async function commitFolder(
  worktreePath: string,
  indexFile: string,
  excluded: readonly string[],
  parents: readonly string[],
  message: string,
): Promise<string> {
  await gitWithIndex(['read-tree', parents[0]], worktreePath, indexFile);
  await gitWithIndex(['add', '-A', '--', '.', ...excluded.map((p) => `:(exclude,literal)${p}`)], worktreePath, indexFile);
  const tree = (await gitWithIndex(['write-tree'], worktreePath, indexFile)).trim();
  return gitExec(['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message], worktreePath);
}
