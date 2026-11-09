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
import { existsSync } from 'fs';
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
import { assertQueueCheckout, assertQueueCheckoutOwnership, InvalidQueueCheckoutError, retainedQueuePathExists, setAsideHalfRemovedCheckout } from './plan-queue-orphan-checkout';
import { recoverLandingLeftover } from './plan-queue-landing-leftover';
import type { PlanQueueItem } from './plan-queue.types';
import { workSourceFor } from './plan-queue-work-sources';
import type { PlanQueueHistoryStore } from './plan-queue-history-store';
import { dietAtCheckpoint } from './plan-queue-plan-diet';
import { planningExclusions, planningMoveNote, relocatePlanningFiles, type PlanningMoveReport } from './plan-queue-planning-files';
import { getCodemem } from '../codemem';
import { stopAttributedLeftoversIn } from '../process/leftover-process-sweeper';
import { cleanupPlanQueueCheckCopies, provisionPlanQueueCheckCopy, withPlanQueueCheckCopy,
  withPlanQueueCombinedCopy, type PlanQueueCheckMember, type PlanQueueCombinedCopy } from './plan-queue-check-copies';

const logger = getLogger('PlanQueueWorktree');

export const PLAN_QUEUE_BRANCH_PREFIX = 'queue/';
export const PLAN_QUEUE_WORKTREE_BASE_DIR = '.worktrees';

/** A checkpoint refused checkout ownership before staging or committing anything. */
export class PlanQueueCheckoutOwnershipError extends Error {
  constructor(worktreePath: string, branchName: string, options: ErrorOptions) {
    super(`${worktreePath} is not this item's checkout of ${branchName}, so nothing was committed`, options);
    this.name = 'PlanQueueCheckoutOwnershipError';
  }
}

/**
 * Kept in the worktree's private git dir (`.git/worktrees/<name>/`), so it
 * survives a restart, never appears in the working tree, and is removed with
 * the worktree.
 */
const PROVISIONED_PATHS_FILE = 'plan-queue-provisioned';

/** The slice of WorktreeManager this service needs; injected for tests. */
export interface PlanQueueWorktreeCreator {
  getConfig?(): { maxConcurrent: number };
  createWorktree(
    instanceId: string,
    taskDescription: string,
    options?: {
      baseBranch?: string;
      branchName?: string;
      skipInstall?: boolean;
      repoRoot?: string;
      onPrepared?: (session: WorktreeSession) => void | Promise<void>;
      countsTowardLimit?: boolean;
    },
  ): Promise<WorktreeSession>;
  getAllSessions(): WorktreeSession[];
  cleanupWorktree(
    worktreeId: string,
    options?: { force?: boolean; retainBranch?: boolean; deleteBranch?: boolean },
  ): Promise<void>;
}

export interface PlanQueueWorktreeDeps {
  /** Trusted owning run, never inferred from the checkout being checked. */
  repoRootForItem: (item: PlanQueueItem) => string;
  history?: PlanQueueHistoryStore;
  retainedWorktreePaths?: () => readonly string[];
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

export function planQueueBranchName(item: Pick<PlanQueueItem, 'id' | 'sourceRef' | 'sourceKind'>): string {
  const suffix = item.id.replace(/[^a-z0-9]/gi, '').slice(-6).toLowerCase();
  return `${PLAN_QUEUE_BRANCH_PREFIX}${sanitizeBranchName(workSourceFor(item.sourceKind).branchSlug(item))}-${suffix}`;
}

export class PlanQueueWorktreeService {
  private readonly retainedPaths = new Set<string>();
  constructor(private readonly deps: PlanQueueWorktreeDeps) {}

  worktreeUsage(): { inUse: number; maxConcurrent: number } {
    const paths = new Set(this.deps.creator.getAllSessions().map(session => pathCompareKey(session.worktreePath)));
    for (const retained of this.retainedPaths) {
      if (existsSync(retained)) paths.add(retained);
      else this.retainedPaths.delete(retained);
    }
    for (const retained of this.deps.retainedWorktreePaths?.() ?? []) {
      if (existsSync(retained)) paths.add(pathCompareKey(retained));
    }
    return { inUse: paths.size, maxConcurrent: this.deps.creator.getConfig?.().maxConcurrent ?? 5 };
  }

  /** The pump's check slots bound these temporary queue-owned comparison folders. */
  async withBaseline<T>(repoRoot: string, baseSha: string, action: (cwd: string) => Promise<T>): Promise<T> {
    const options = { repoRoot, baseTip: baseSha, creator: this.deps.creator, skipInstall: this.deps.skipInstall };
    return withPlanQueueCheckCopy({ ...options, kind: 'base' }, async cwd => {
      await provisionPlanQueueCheckCopy(options, cwd);
      return action(cwd);
    });
  }

  withCombinedCopy<T>(repoRoot: string, baseTip: string, members: readonly PlanQueueCheckMember[],
    action: (copy: PlanQueueCombinedCopy) => Promise<T>, signal?: AbortSignal): Promise<T | undefined> {
    return withPlanQueueCombinedCopy({ repoRoot, baseTip, creator: this.deps.creator, skipInstall: this.deps.skipInstall, signal }, members, action);
  }

  cleanupScratchCopies(workspaceRoots: readonly string[]): Promise<void> {
    return cleanupPlanQueueCheckCopies(workspaceRoots);
  }

  /**
   * Create the item's worktree. Branch and path are saved through `onPrepared`,
   * which WorktreeManager calls before it touches git. The queue's worker slots
   * already limit its checkouts, and a paused item keeps its checkout, so they
   * stay outside the app-wide worktree limit (they used to fill it and starve
   * every other run).
   */
  async prepare(item: PlanQueueItem, repoRoot: string): Promise<PlanQueueItem> {
    const branchName = planQueueBranchName(item);
    let prepared = item;
    await this.deps.creator.createWorktree(item.id, workSourceFor(item.sourceKind).fullName(item), {
      branchName,
      repoRoot,
      skipInstall: this.deps.skipInstall,
      countsTowardLimit: false,
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
    this.retainedPaths.add(pathCompareKey(worktreePath));
    const withPath = { ...item, worktreePath };
    this.deps.saveItem(withPath);
    let alreadyThere = await retainedQueuePathExists(worktreePath);
    let rescueRef: string | null = null;
    if (alreadyThere) {
      const movedTo = await setAsideHalfRemovedCheckout(worktreePath, branchName, repoRoot);
      if (movedTo) {
        logger.warn('Plan queue: moved a half-removed checkout aside before checking its branch out again', { itemId: item.id, movedTo });
        alreadyThere = false;
      } else {
        await assertQueueCheckoutOwnership(worktreePath, repoRoot);
        rescueRef = await recoverLeftover(worktreePath, branchName, item.id, repoRoot);
        await assertQueueCheckout(worktreePath, branchName, repoRoot);
      }
    }
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
      ...(rescueRef ? { detail: rescueNote(rescueRef) } : {}),
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
    let rescueRef: string | null = null;
    let planningNote: string | null = null;
    const hash = await getGitWriteQueue().enqueue('plan-queue-checkpoint', async () => {
      try { await assertQueueCheckoutOwnership(worktreePath, this.deps.repoRootForItem(item)); }
      catch (error) {
        if (error instanceof InvalidQueueCheckoutError) throw new PlanQueueCheckoutOwnershipError(worktreePath, branchName, { cause: error });
        throw error;
      }
      // `??`: the write queue reruns a job after a Git lock error, and a rerun finds nothing left to recover.
      rescueRef = (await recoverLeftoverUnqueued(worktreePath, branchName, item.id, this.deps.repoRootForItem(item))) ?? rescueRef;
      await assertItemCheckout(worktreePath, branchName, this.deps.repoRootForItem(item));
      await dietAtCheckpoint(item, this.deps.history);
      // A resolved merge is completed by this commit (that is the worker
      // contract); an unresolved one must never be, or the conflict markers
      // would be committed and could land.
      const conflicted = await unresolvedMergeFiles(worktreePath);
      if (conflicted?.length) throw new UnresolvedMergeError(conflicted);
      // Planning files never reach a commit: each moves to the root checkout first, and one
      // that cannot move is left out of this commit (see plan-queue-planning-files.ts).
      const planning = await this.movePlanningFiles(item);
      planningNote = planningMoveNote(planning) ?? planningNote;
      const scope = await workPathspec(worktreePath, planningExclusions(planning.failed));
      await gitExec(['add', '-A', ...scope], worktreePath);
      const status = await gitExec(['status', '--porcelain', ...scope], worktreePath);
      if (status) {
        const message = `Plan queue checkpoint: ${label}\n\nItem: ${item.id}\n${workSourceFor(item.sourceKind).checkpointTrailer(item)}`;
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
      ...checkpointDetail(rescueRef, planningNote),
    };
    this.deps.saveItem(updated);
    return updated;
  }

  /**
   * Move every untracked planning file in the item's folder to the root checkout. Called inside the
   * Git write queue by `checkpoint`, and as the landing preflight (`preflightPlanningFiles`).
   */
  private async movePlanningFiles(item: PlanQueueItem): Promise<PlanningMoveReport> {
    const worktreePath = requireWorktree(item);
    return relocatePlanningFiles({
      itemId: item.id,
      worktreePath,
      repoRoot: this.deps.repoRootForItem(item),
      provisioned: await readProvisionedPaths(worktreePath),
    });
  }

  /**
   * Before a landing squash: try again to move any planning file an earlier checkpoint could not
   * move. A file that still cannot move is reported, and the caller parks the item before the
   * squash, so no landing cleanup ever runs with that file in the folder.
   */
  async preflightPlanningFiles(item: PlanQueueItem): Promise<PlanningMoveReport> {
    const worktreePath = requireWorktree(item);
    const branchName = requireBranch(item);
    return getGitWriteQueue().enqueue('plan-queue-planning-preflight', async () => {
      await assertItemCheckout(worktreePath, branchName, this.deps.repoRootForItem(item));
      return this.movePlanningFiles(item);
    });
  }

  /**
   * Discard of a job with a live worktree: commit its edits to the branch, then remove the folder.
   * An unfinished merge cannot be committed and may hold hand-made fixes, so `checkpoint` throwing
   * for one leaves the folder in place.
   */
  async retireForDiscard(item: PlanQueueItem, repoRoot: string): Promise<void> {
    const removal = await this.removeWithProof(await this.checkpoint(item, 'discarded'), repoRoot);
    if (!removal.removed) throw new Error(`Its worktree could not be removed (${removal.reason}: ${removal.detail})`);
  }

  /** Remove the worktree directory, keeping the branch. Refuses without proof. */
  async removeWithProof(item: PlanQueueItem, repoRoot: string): Promise<RemovalResult> {
    const worktreePath = requireWorktree(item);
    const branchName = requireBranch(item);
    try { await assertQueueCheckout(worktreePath, branchName, repoRoot); }
    catch (error) {
      if (error instanceof InvalidQueueCheckoutError) return refuse('not-owned', error.message);
      throw error;
    }

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
      throw error;
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
    this.retainedPaths.delete(pathCompareKey(worktreePath));
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
async function workPathspec(worktreePath: string, alsoExclude: readonly string[] = []): Promise<string[]> {
  const provisioned = await readProvisionedPaths(worktreePath);
  if (provisioned.length === 0 && alsoExclude.length === 0) return [];
  return ['--', '.', ...provisioned.map((p) => `:(exclude,literal)${p}`), ...alsoExclude];
}

/**
 * The folder must be the top of a checkout of the item's own branch. A plain
 * folder at the queue path (an orphan left by an interrupted checkout) makes
 * git resolve the enclosing repository instead, where `add -A` and `commit`
 * would sweep that repository's whole working tree onto its current branch.
 */
async function assertItemCheckout(worktreePath: string, branchName: string, repoRoot: string): Promise<void> {
  try { await assertQueueCheckout(worktreePath, branchName, repoRoot); }
  catch (error) {
    if (error instanceof InvalidQueueCheckoutError) throw new PlanQueueCheckoutOwnershipError(worktreePath, branchName, { cause: error });
    throw error;
  }
}

/**
 * Put back a checkout an interrupted landing left detached
 * (plan-queue-landing-leftover.ts); returns the rescue ref when some files
 * were set aside. Takes the Git write queue, so never call it from inside it.
 */
export function recoverLeftover(worktreePath: string, branchName: string, itemId: string, repoRoot: string): Promise<string | null> {
  return getGitWriteQueue().enqueue('plan-queue-recover-landing-leftover', async () => {
    try { await assertQueueCheckoutOwnership(worktreePath, repoRoot); }
    catch (error) {
      if (error instanceof InvalidQueueCheckoutError) throw new PlanQueueCheckoutOwnershipError(worktreePath, branchName, { cause: error });
      throw error;
    }
    return recoverLeftoverUnqueued(worktreePath, branchName, itemId, repoRoot);
  });
}

async function recoverLeftoverUnqueued(worktreePath: string, branchName: string, itemId: string, repoRoot: string): Promise<string | null> {
  const provisioned = await readProvisionedPaths(worktreePath);
  // A planning file the recovery would otherwise remove moves to the root checkout instead.
  const relocate = async (file: string): Promise<boolean> =>
    (await relocatePlanningFiles({ itemId, worktreePath, repoRoot, provisioned }, [file])).failed.length === 0;
  const recovered = await recoverLandingLeftover(worktreePath, branchName, itemId, provisioned, relocate);
  if (!recovered) return null;
  logger.warn('Plan queue: put a checkout an interrupted landing left detached back on its branch', {
    itemId, rescueRef: recovered.rescueRef, unexplained: recovered.unexplained.length,
  });
  return recovered.rescueRef;
}

export function rescueNote(rescueRef: string): string {
  return 'A landing had stopped part-way and left this item\'s folder off its branch. It was put back on the branch. '
    + `Some files in it matched neither side (half-written, or edited while it was off the branch); they were left off the branch, and the whole folder was saved at ${rescueRef} in case any of it is needed.`;
}

/** The item note after a checkpoint: a landing-leftover rescue and/or planning files that moved. */
function checkpointDetail(rescueRef: string | null, planningNote: string | null): { detail?: string } {
  const parts = [rescueRef ? rescueNote(rescueRef) : null, planningNote].filter((part): part is string => part !== null);
  return parts.length ? { detail: parts.join(' ') } : {};
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
