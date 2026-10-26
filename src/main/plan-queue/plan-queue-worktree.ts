/**
 * Plan Queue item worktrees — the no-lost-work layer.
 *
 * Invariants (docs/plans/2026-09-18-plan-queue_spec_completed.md):
 *  1. The row that owns a worktree is written BEFORE the worktree exists.
 *  2. The coordinator, never the agent, commits safety checkpoints, and a
 *     checkpoint can never be refused by a hook.
 *  3. A worktree directory is removed only when its tree is clean and HEAD is
 *     the recorded checkpoint. A branch is deleted only after it landed or the
 *     operator discarded it.
 *
 * Everything after creation works from the item row alone, because
 * WorktreeManager's session map does not survive a restart.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { sanitizeBranchName, type WorktreeSession } from '../../shared/types/worktree.types';
import { getLogger } from '../logging/logger';
import { gitExec, WORKTREE_CHECKOUT_TIMEOUT_MS } from '../workspace/git/git-exec';
import { getGitWriteQueue } from '../workspace/git/git-write-queue';
import { provisionWorktreeDependencies } from '../workspace/git/worktree-deps';
import {
  deleteLocalBranchIfPresent,
  pathCompareKey,
  removeManagedWorktreeDirectory,
} from '../workspace/git/worktree-cleanup';
import { UnresolvedMergeError, unresolvedMergeFiles } from './plan-queue-git';
import { assertQueueCheckout, retainedQueuePathExists } from './plan-queue-orphan-checkout';
import type { PlanQueueItem } from './plan-queue.types';
import { getCodemem } from '../codemem';
import { stopAttributedLeftoversIn } from '../process/leftover-process-sweeper';

const logger = getLogger('PlanQueueWorktree');

export const PLAN_QUEUE_BRANCH_PREFIX = 'queue/';
export const PLAN_QUEUE_WORKTREE_BASE_DIR = '.worktrees';

/**
 * Kept in the worktree's private git dir (`.git/worktrees/<name>/`), so it
 * survives a restart, never appears in the working tree, and is removed with
 * the worktree.
 */
const PROVISIONED_PATHS_FILE = 'plan-queue-provisioned';

/** The slice of WorktreeManager this service needs; injected for tests. */
export interface PlanQueueWorktreeCreator {
  createWorktree(
    instanceId: string,
    taskDescription: string,
    options?: {
      baseBranch?: string;
      branchName?: string;
      skipInstall?: boolean;
      repoRoot?: string;
      onPrepared?: (session: WorktreeSession) => void | Promise<void>;
    },
  ): Promise<WorktreeSession>;
  getAllSessions(): WorktreeSession[];
  cleanupWorktree(
    worktreeId: string,
    options?: { force?: boolean; retainBranch?: boolean },
  ): Promise<void>;
}

export interface PlanQueueWorktreeDeps {
  creator: PlanQueueWorktreeCreator;
  /** Persist the item. Must throw on failure. */
  saveItem: (item: PlanQueueItem) => void;
  skipInstall?: boolean;
  /** Stop leftover programs a session left working in the folder; defaults to the leftover sweeper. */
  stopLeftoversIn?: (folder: string) => Promise<number>;
}

export type RemovalRefusal = 'dirty-tree' | 'head-not-checkpoint' | 'not-owned';

export type RemovalResult =
  | { removed: true }
  | { removed: false; reason: RemovalRefusal; detail: string };

export function planQueueBranchName(item: Pick<PlanQueueItem, 'id' | 'documentPath'>): string {
  const stem = path
    .basename(item.documentPath)
    .replace(/\.md$/i, '')
    .replace(/_(plan|livetest)$/i, '');
  const suffix = item.id.replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase();
  return `${PLAN_QUEUE_BRANCH_PREFIX}${sanitizeBranchName(stem)}-${suffix}`;
}

export class PlanQueueWorktreeService {
  constructor(private readonly deps: PlanQueueWorktreeDeps) {}

  /**
   * Create the item's worktree. Branch and path are saved through `onPrepared`,
   * which WorktreeManager calls before it touches git.
   */
  async prepare(item: PlanQueueItem, repoRoot: string): Promise<PlanQueueItem> {
    const branchName = planQueueBranchName(item);
    let prepared = item;
    await this.deps.creator.createWorktree(item.id, path.basename(item.documentPath), {
      branchName,
      repoRoot,
      skipInstall: this.deps.skipInstall,
      onPrepared: (session) => {
        prepared = {
          ...item,
          branchName: session.branchName,
          worktreePath: session.worktreePath,
          baseCommit: session.baseCommit,
        };
        this.deps.saveItem(prepared);
      },
    });
    await recordProvisionedPaths(requireWorktree(prepared));
    return prepared;
  }

  /**
   * Check a parked item's existing branch out again (Resume / Land anyway).
   *
   * Deliberately NOT `WorktreeManager.createWorktree`: that always runs
   * `worktree add -b`, and when the branch already exists its failure cleanup
   * deletes the branch — the parked work itself. The path is saved first, as
   * for `prepare`.
   */
  async reattach(item: PlanQueueItem, repoRoot: string): Promise<PlanQueueItem> {
    const branchName = requireBranch(item);
    const worktreePath = path.join(repoRoot, PLAN_QUEUE_WORKTREE_BASE_DIR, branchName);
    const withPath = { ...item, worktreePath };
    this.deps.saveItem(withPath);
    const alreadyThere = await retainedQueuePathExists(worktreePath);
    if (alreadyThere) await assertQueueCheckout(worktreePath, branchName, repoRoot);
    if (!alreadyThere) {
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });
      await getGitWriteQueue().enqueue('plan-queue-reattach', () =>
        gitExec(['worktree', 'add', worktreePath, branchName], repoRoot, WORKTREE_CHECKOUT_TIMEOUT_MS),
      );
      if (!this.deps.skipInstall) {
        await provisionWorktreeDependencies(repoRoot, worktreePath).catch((error: unknown) => {
          logger.warn('Plan queue: dependency provisioning failed for a reattached worktree', {
            itemId: item.id,
            message: error instanceof Error ? error.message : String(error),
          });
        });
      }
      await recordProvisionedPaths(worktreePath);
    }
    const head = await gitExec(['rev-parse', 'HEAD'], worktreePath);
    const reattached = {
      ...withPath,
      checkpointCommit: head,
      landedCommit: head === item.checkpointCommit ? item.landedCommit : null,
    };
    this.deps.saveItem(reattached);
    return reattached;
  }

  /**
   * Commit everything in the worktree to the item branch; throws
   * `UnresolvedMergeError` while a merge is still conflicted. `--no-verify` is
   * deliberate: the branch is throwaway, and the loop's harvest lost work
   * precisely because a pre-commit hook could refuse it.
   */
  async checkpoint(item: PlanQueueItem, label: string): Promise<PlanQueueItem> {
    const worktreePath = requireWorktree(item);
    const branchName = requireBranch(item);
    const scope = await workPathspec(worktreePath);
    const hash = await getGitWriteQueue().enqueue('plan-queue-checkpoint', async () => {
      await assertItemCheckout(worktreePath, branchName);
      // A resolved merge is completed by this commit (that is the worker
      // contract); an unresolved one must never be, or the conflict markers
      // would be committed and could land.
      const conflicted = await unresolvedMergeFiles(worktreePath);
      if (conflicted?.length) throw new UnresolvedMergeError(conflicted);
      await gitExec(['add', '-A', ...scope], worktreePath);
      const status = await gitExec(['status', '--porcelain', ...scope], worktreePath);
      if (status) {
        const message = `Plan queue checkpoint: ${label}\n\nItem: ${item.id}\nDocument: ${item.documentPath}`;
        await gitExec(
          ['commit', '--no-verify', '--no-gpg-sign', '-m', message],
          worktreePath,
        );
      }
      return gitExec(['rev-parse', 'HEAD'], worktreePath);
    });
    // Keep an unchanged candidate for crash recovery; a changed checkpoint
    // requires a fresh squash, including its current document evidence.
    const updated = {
      ...item,
      checkpointCommit: hash,
      landedCommit: hash === item.checkpointCommit ? item.landedCommit : null,
    };
    this.deps.saveItem(updated);
    return updated;
  }

  /** Remove the worktree directory, keeping the branch. Refuses without proof. */
  async removeWithProof(item: PlanQueueItem, repoRoot: string): Promise<RemovalResult> {
    const worktreePath = requireWorktree(item);
    const branchName = requireBranch(item);

    const status = await gitExec(
      ['status', '--porcelain', ...(await workPathspec(worktreePath))],
      worktreePath,
    );
    if (status) {
      return refuse('dirty-tree', `${status.split('\n').length} uncommitted path(s)`);
    }
    const head = await gitExec(['rev-parse', 'HEAD'], worktreePath);
    if (!item.checkpointCommit || head !== item.checkpointCommit) {
      return refuse('head-not-checkpoint', `HEAD ${head} != checkpoint ${item.checkpointCommit ?? 'none'}`);
    }

    // A program an agent left running here would carry on in a deleted folder. Best effort only.
    try {
      const stopped = await (this.deps.stopLeftoversIn ?? stopAttributedLeftoversIn)(worktreePath);
      if (stopped > 0) logger.info('Stopped leftover programs before removing a worktree', { itemId: item.id, stopped });
    } catch (error) {
      logger.warn('Could not check the worktree for leftover programs', { itemId: item.id, error: String(error) });
    }

    const session = this.deps.creator
      .getAllSessions()
      .find((s) => pathCompareKey(s.worktreePath) === pathCompareKey(worktreePath));
    try {
      if (session) {
        // Also releases the manager's concurrency slot and renderer port. `force`
        // skips the manager's own dirty check, which counts provisioned files;
        // the stricter proof above has already passed.
        await this.deps.creator.cleanupWorktree(session.id, { force: true, retainBranch: true });
      } else {
        await removeManagedWorktreeDirectory({
          repoRoot,
          worktreePath,
          baseDir: PLAN_QUEUE_WORKTREE_BASE_DIR,
          expectedBranch: branchName,
        });
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.warn('Plan queue worktree removal refused', { itemId: item.id, detail });
      return refuse('not-owned', detail);
    }

    // The filesystem removal is authoritative. A failed index-worker cleanup
    // must not resurrect lifecycle ownership of a folder that no longer exists.
    try {
      const codemem = getCodemem();
      if (codemem.isIndexingEnabled() && !await codemem.indexWorkerGateway.removeWorkspaceIndex(worktreePath)) {
        logger.info('Retired worktree index cleanup deferred to worker maintenance');
      }
    } catch (error) {
      logger.warn('Retired worktree code-index cleanup failed', { error: String(error) });
    }
    this.deps.saveItem({ ...item, worktreePath: null });
    return { removed: true };
  }

  /** Delete the item branch. Only after it landed, or on an explicit discard. */
  async deleteBranchWithProof(
    item: PlanQueueItem,
    repoRoot: string,
    options: { discardRequested?: boolean } = {},
  ): Promise<void> {
    const branchName = requireBranch(item);
    if (item.state !== 'landed' && !options.discardRequested) {
      throw new Error(`Refusing to delete ${branchName}: item ${item.id} has not landed`);
    }
    if (item.worktreePath) {
      throw new Error(`Refusing to delete ${branchName}: its worktree still exists`);
    }
    await getGitWriteQueue().enqueue('plan-queue-delete-branch', async () => {
      const listed = await gitExec(['worktree', 'list', '--porcelain'], repoRoot);
      if (listed.split('\n').includes(`branch refs/heads/${branchName}`)) {
        throw new Error(`Refusing to delete ${branchName}: it is still checked out`);
      }
      const tip = await gitExec(['for-each-ref', '--format=%(objectname)', `refs/heads/${branchName}`], repoRoot);
      if (tip) {
        // A squash-landed branch is not an ancestor of main. Check the exact
        // tip and registration while holding the shared Git mutation lock.
        await deleteLocalBranchIfPresent(repoRoot, branchName, { allowUnmerged: true, expectedTip: tip }, true);
      }
      this.deps.saveItem({ ...item, branchName: null });
    });
  }
}

/**
 * WorktreeManager provisions a new worktree with files that are not the
 * agent's work: a `.mise.local.toml` port override and copies of the root's
 * `.env*.local` files. This repo ignores them, but a repo that does not would
 * have them swept into a checkpoint by `git add -A` and then squash-landed on
 * main — env files included. Whatever is untracked straight after provisioning
 * is therefore recorded once and excluded from every checkpoint.
 */
async function recordProvisionedPaths(worktreePath: string): Promise<void> {
  const listed = await gitExec(
    ['ls-files', '--others', '--exclude-standard', '--directory', '-z'],
    worktreePath,
  );
  const paths = listed.split('\0').map((p) => p.replace(/\/$/, '')).filter(Boolean);
  await fs.writeFile(await provisionedPathsFile(worktreePath), JSON.stringify(paths), 'utf-8');
}

async function provisionedPathsFile(worktreePath: string): Promise<string> {
  const gitDir = await gitExec(['rev-parse', '--absolute-git-dir'], worktreePath);
  return path.join(gitDir, PROVISIONED_PATHS_FILE);
}

/** Paths WorktreeManager provisioned into this worktree (never the agent's work). */
export async function readProvisionedPaths(worktreePath: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(await provisionedPathsFile(worktreePath), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    // No record (e.g. a worktree re-created for a resumed branch): nothing to exclude.
    return [];
  }
}

/** Pathspec selecting the agent's work: everything except provisioned paths. */
async function workPathspec(worktreePath: string): Promise<string[]> {
  const provisioned = await readProvisionedPaths(worktreePath);
  if (provisioned.length === 0) return [];
  return ['--', '.', ...provisioned.map((p) => `:(exclude,literal)${p}`)];
}

/**
 * The folder must be the top of a checkout of the item's own branch. A plain
 * folder at the queue path (an orphan left by an interrupted checkout) makes
 * git resolve the enclosing repository instead, where `add -A` and `commit`
 * would sweep that repository's whole working tree onto its current branch.
 */
async function assertItemCheckout(worktreePath: string, branchName: string): Promise<void> {
  const root = await gitExec(['rev-parse', '--show-toplevel'], worktreePath);
  const branch = await gitExec(['symbolic-ref', '-q', '--short', 'HEAD'], worktreePath).catch(() => '');
  if (pathCompareKey(await fs.realpath(root)) !== pathCompareKey(await fs.realpath(worktreePath)) || branch !== branchName) {
    throw new Error(`${worktreePath} is not this item's checkout of ${branchName}, so nothing was committed`);
  }
}

function refuse(reason: RemovalRefusal, detail: string): RemovalResult {
  return { removed: false, reason, detail };
}

function requireWorktree(item: PlanQueueItem): string {
  if (!item.worktreePath) throw new Error(`Plan queue item ${item.id} has no worktree`);
  return item.worktreePath;
}

function requireBranch(item: PlanQueueItem): string {
  if (!item.branchName) throw new Error(`Plan queue item ${item.id} has no branch`);
  return item.branchName;
}
