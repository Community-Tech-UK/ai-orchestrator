/**
 * worktree-integration — P4 dedicated-integration-worktree merge.
 *
 * The legacy merge path in WorktreeManager checks out the target branch in the
 * REPO ROOT and merges there, which races any concurrent session that also uses
 * the root checkout. This module performs the merge in a dedicated, throwaway
 * worktree instead, so integration never runs in the root checkout.
 *
 * Topology constraint (interim): the real target branch (e.g. `main`) is checked
 * out in the root worktree, and git refuses to check out the same branch in two
 * worktrees. So we create the integration worktree in DETACHED HEAD at the
 * target tip, then build the merge on an isolated integration branch. The result
 * is a clean, mergeable integration branch — the orchestrator fast-forwards the
 * real target through its own controlled path (or, long term, the P8 bare-repo
 * hub removes the privileged root entirely). The root checkout is never touched.
 *
 * All git writes go through the shared GitWriteQueue so they serialize against
 * every other orchestrator git write on the shared `.git`.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import { realpathSync } from 'fs';
import { getLogger } from '../../logging/logger';
import { getGitWriteQueue } from './git-write-queue';
import { hermeticGitEnv } from './git-env';
import type { MergeStrategy } from '../../../shared/types/worktree.types';

const execFileAsync = promisify(execFile);
const logger = getLogger('WorktreeIntegration');

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    // Hermetic env: ignore inherited GIT_DIR/GIT_INDEX_FILE (e.g. when running
    // inside a git hook) so this resolves the repo from cwd only.
    env: hermeticGitEnv(),
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  });
  return typeof stdout === 'string' ? stdout.trim() : String(stdout).trim();
}

async function gitSafe(args: string[], cwd: string): Promise<string> {
  try {
    return await git(args, cwd);
  } catch {
    return '';
  }
}

export interface IntegrationParams {
  repoRoot: string;
  /** Worktree base dir (e.g. `.worktrees`), relative to repoRoot. */
  baseDir: string;
  /** The session branch holding the harvested work to integrate. */
  sessionBranch: string;
  /** The branch we are integrating onto (e.g. `main`). */
  targetBranch: string;
  strategy: MergeStrategy;
  /** Override the auto-generated integration branch name. */
  integrationBranch?: string;
  commitMessage?: string;
  /** Stable suffix for the temp worktree dir name (tests pass a fixed value). */
  nonce?: string;
}

export interface IntegrationResult {
  success: boolean;
  /** The merge commit on the integration branch. */
  mergeCommit?: string;
  /** The isolated branch that now contains the integrated result. */
  integrationBranch?: string;
  error?: string;
  conflictFiles?: string[];
}

function parseConflictFiles(statusPorcelain: string): string[] {
  // Porcelain conflict markers: UU, AA, DD, AU, UA, DU, UD.
  const conflictCodes = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);
  return statusPorcelain
    .split('\n')
    .filter((l) => conflictCodes.has(l.slice(0, 2)))
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
}

/**
 * Integrate `sessionBranch` onto `targetBranch` inside a dedicated detached
 * worktree, producing an isolated integration branch. Never mutates the root
 * checkout. The dedicated worktree is always removed; on failure the integration
 * branch is also deleted so no stray refs accumulate.
 */
export async function integrateViaWorktree(params: IntegrationParams): Promise<IntegrationResult> {
  const {
    repoRoot,
    baseDir,
    sessionBranch,
    targetBranch,
    strategy,
    commitMessage,
    nonce,
  } = params;

  if (strategy === 'manual') {
    return { success: false, error: 'Manual merge strategy requires user intervention' };
  }

  const integrationBranch = params.integrationBranch ?? `integration/${sessionBranch}`;
  const suffix = nonce ?? `${Date.now().toString(36)}`;
  const intPath = path.join(repoRoot, baseDir, `.integration-${suffix}`);

  const queue = getGitWriteQueue();

  try {
    // Detached checkout at the target tip — allowed even though targetBranch is
    // checked out in the root worktree, because we don't check out the branch.
    await queue.enqueue('integration-add', () =>
      git(['worktree', 'add', '--detach', intPath, targetBranch], repoRoot),
    );
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  let outcome: IntegrationResult;
  let cleanupBranch = false;
  try {
    const result = await queue.enqueue('integration-merge', async () => {
      // Force-create the integration branch at the detached target tip.
      await git(['checkout', '-B', integrationBranch], intPath);

      if (strategy === 'squash') {
        await git(['merge', '--squash', sessionBranch], intPath);
        const msg =
          commitMessage ?? `Integrate ${sessionBranch} into ${targetBranch} (squash)`;
        await git(['commit', '--no-gpg-sign', '--no-verify', '-m', msg], intPath);
      } else {
        // auto / rebase both resolve to an isolated no-ff merge commit here;
        // rebase semantics are meaningless on a throwaway integration branch.
        const msg = commitMessage ?? `Integrate ${sessionBranch} into ${targetBranch}`;
        await git(
          ['merge', '--no-ff', '--no-verify', '--no-gpg-sign', '-m', msg, sessionBranch],
          intPath,
        );
      }

      return git(['rev-parse', 'HEAD'], intPath);
    });

    logger.info('WorktreeIntegration: integrated session branch', {
      sessionBranch,
      targetBranch,
      integrationBranch,
      mergeCommit: result,
    });
    outcome = { success: true, mergeCommit: result, integrationBranch };
  } catch (err) {
    const status = await gitSafe(['status', '--porcelain'], intPath);
    const conflictFiles = parseConflictFiles(status);
    await gitSafe(['merge', '--abort'], intPath);
    cleanupBranch = true;
    logger.warn('WorktreeIntegration: integration failed', {
      sessionBranch,
      targetBranch,
      conflictFiles,
      message: err instanceof Error ? err.message : String(err),
    });
    outcome = {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      conflictFiles: conflictFiles.length > 0 ? conflictFiles : undefined,
    };
  } finally {
    // Always remove the throwaway worktree first (the integration branch ref
    // persists on success).
    await queue.enqueue('integration-remove', () =>
      gitSafe(['worktree', 'remove', '--force', intPath], repoRoot),
    );
  }

  // On failure, delete the partial integration branch AFTER the worktree is gone
  // (git refuses to delete a branch checked out in a live worktree).
  if (cleanupBranch) {
    await queue.enqueue('integration-branch-cleanup', () =>
      gitSafe(['branch', '-D', integrationBranch], repoRoot),
    );
  }

  return outcome;
}

export interface SharedIntegrationParams {
  repoRoot: string;
  baseDir: string;
  sessionBranch: string;
  /** Shared, accumulating integration branch (e.g. `integration/main`). */
  integrationBranch: string;
  /** Branch the integration line is created from when it does not yet exist. */
  baseBranch: string;
  strategy: MergeStrategy;
  commitMessage?: string;
  nonce?: string;
}

export interface SharedIntegrationResult {
  success: boolean;
  integrationBranch: string;
  /** New tip of the integration branch after the merge. */
  mergeCommit?: string;
  /** True when the session branch was already contained — a no-op merge. */
  alreadyIntegrated?: boolean;
  error?: string;
  conflictFiles?: string[];
}

async function isAncestor(candidate: string, target: string, cwd: string): Promise<boolean> {
  try {
    await git(['merge-base', '--is-ancestor', candidate, target], cwd);
    return true;
  } catch {
    return false;
  }
}

/** True when `branch` is the checked-out branch of any live worktree (incl. root). */
export async function isBranchCheckedOut(repoRoot: string, branch: string): Promise<boolean> {
  const list = await git(['worktree', 'list', '--porcelain'], repoRoot);
  return list.split('\n').some((l) => l.trim() === `branch refs/heads/${branch}`);
}

interface WorktreeCheckout {
  path: string;
  branch?: string;
}

function parseWorktreeCheckouts(porcelain: string): WorktreeCheckout[] {
  const checkouts: WorktreeCheckout[] = [];
  let current: WorktreeCheckout | undefined;

  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) };
      checkouts.push(current);
    } else if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }

  return checkouts;
}

function canonicalPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function hasRootCheckoutChanges(
  statusPorcelain: string,
  checkouts: WorktreeCheckout[],
  repoRoot: string,
): boolean {
  const nestedWorktrees = checkouts
    .map((checkout) => canonicalPath(checkout.path))
    .filter((checkoutPath) => checkoutPath !== canonicalPath(repoRoot))
    .map((checkoutPath) => path.relative(canonicalPath(repoRoot), checkoutPath))
    .filter((relativePath) => relativePath && !relativePath.startsWith('..'));

  return statusPorcelain.split('\n').filter(Boolean).some((line) => {
    if (!line.startsWith('?? ')) return true;

    const untrackedPath = line.slice(3).replace(/\/$/, '');
    return !nestedWorktrees.some(
      (worktreePath) =>
        untrackedPath === worktreePath || untrackedPath.startsWith(`${worktreePath}${path.sep}`),
    );
  });
}

export type BasePromotionResult =
  | { status: 'promoted'; method: 'checked-out-ff' | 'update-ref'; tip: string }
  | { status: 'already-promoted'; tip: string }
  | { status: 'blocked'; reason: string };

const ZERO_OID = '0000000000000000000000000000000000000000';

function integrationOwnershipRef(integrationBranch: string): string {
  return `refs/aio/managed-integrations/${integrationBranch}`;
}

/**
 * Promote an isolated integration branch back to its base branch without
 * risking operator work in another checkout.
 *
 * A base checked out at the repository root is advanced with `merge --ff-only`
 * so both its ref and working tree move together. An unchecked base is advanced
 * with a compare-and-swap `update-ref`. A base owned by any other worktree, a
 * dirty root, or a non-fast-forward topology is reported as blocked.
 */
export async function promoteIntegrationBranch(
  repoRoot: string,
  baseBranch: string,
  integrationBranch: string,
  expectedIntegrationTip?: string,
): Promise<BasePromotionResult> {
  return getGitWriteQueue().enqueue('promote-integration', async () => {
    const baseTip = await gitSafe(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${baseBranch}`],
      repoRoot,
    );
    const integrationTip = await gitSafe(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${integrationBranch}`],
      repoRoot,
    );

    if (!baseTip) {
      return { status: 'blocked', reason: `base branch ${baseBranch} does not exist` };
    }
    if (!integrationTip) {
      return {
        status: 'blocked',
        reason: `integration branch ${integrationBranch} does not exist`,
      };
    }
    const ownershipTip = await gitSafe(
      ['rev-parse', '--verify', '--quiet', integrationOwnershipRef(integrationBranch)],
      repoRoot,
    );
    if (
      !ownershipTip
      || ownershipTip !== integrationTip
      || (expectedIntegrationTip && expectedIntegrationTip !== integrationTip)
    ) {
      return {
        status: 'blocked',
        reason: 'managed integration branch identity could not be verified',
      };
    }
    if (baseTip === integrationTip) {
      return { status: 'already-promoted', tip: integrationTip };
    }
    if (!(await isAncestor(baseTip, integrationTip, repoRoot))) {
      return {
        status: 'blocked',
        reason: `${baseBranch} cannot be fast-forwarded to ${integrationBranch}`,
      };
    }

    let checkoutList: string;
    try {
      checkoutList = await git(['worktree', 'list', '--porcelain'], repoRoot);
    } catch (err) {
      logger.warn('WorktreeIntegration: unable to inspect worktree ownership', {
        baseBranch,
        message: err instanceof Error ? err.message : String(err),
      });
      return { status: 'blocked', reason: 'unable to inspect worktree ownership' };
    }
    const checkouts = parseWorktreeCheckouts(checkoutList);
    const baseCheckout = checkouts.find((checkout) => checkout.branch === baseBranch);

    if (baseCheckout) {
      if (canonicalPath(baseCheckout.path) !== canonicalPath(repoRoot)) {
        return {
          status: 'blocked',
          reason: `${baseBranch} is checked out outside the repository root`,
        };
      }

      let currentBranch: string;
      try {
        currentBranch = await git(['branch', '--show-current'], repoRoot);
      } catch {
        return { status: 'blocked', reason: 'unable to inspect root checkout branch' };
      }
      if (currentBranch !== baseBranch) {
        return {
          status: 'blocked',
          reason: `${baseBranch} is not the active root branch`,
        };
      }
      let rootStatus: string;
      try {
        rootStatus = await git(
          ['status', '--porcelain', '--untracked-files=all'],
          repoRoot,
        );
      } catch {
        return { status: 'blocked', reason: 'unable to inspect root checkout status' };
      }
      if (hasRootCheckoutChanges(rootStatus, checkouts, repoRoot)) {
        return { status: 'blocked', reason: 'root checkout has uncommitted changes' };
      }

      try {
        await git(['merge', '--ff-only', '--no-verify', integrationBranch], repoRoot);
        logger.info('WorktreeIntegration: promoted integration branch at root', {
          baseBranch,
          integrationBranch,
          to: integrationTip,
        });
        return {
          status: 'promoted',
          method: 'checked-out-ff',
          tip: integrationTip,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn('WorktreeIntegration: checked-out base promotion failed', {
          baseBranch,
          integrationBranch,
          message,
        });
        return { status: 'blocked', reason: 'checked-out base promotion failed' };
      }
    }

    try {
      await git(
        ['update-ref', `refs/heads/${baseBranch}`, integrationTip, baseTip],
        repoRoot,
      );
      logger.info('WorktreeIntegration: promoted unchecked base branch', {
        baseBranch,
        integrationBranch,
        to: integrationTip,
      });
      return { status: 'promoted', method: 'update-ref', tip: integrationTip };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn('WorktreeIntegration: unchecked base promotion failed', {
        baseBranch,
        integrationBranch,
        message,
      });
      return { status: 'blocked', reason: 'unchecked base promotion failed' };
    }
  });
}

/**
 * Auto-integrate `sessionBranch` into the shared, accumulating integration
 * branch. The integration worktree checks out the REAL integration branch (not
 * detached), so a clean merge advances the branch ref directly. The whole
 * sequence runs as a single git-write-queue op, so concurrent integrations
 * serialize and never collide on "branch already checked out". The root checkout
 * is never touched.
 */
export async function integrateIntoSharedBranch(
  params: SharedIntegrationParams,
): Promise<SharedIntegrationResult> {
  const { repoRoot, baseDir, sessionBranch, integrationBranch, baseBranch, strategy, commitMessage } =
    params;
  const suffix = params.nonce ?? Date.now().toString(36);
  const intPath = path.join(repoRoot, baseDir, `.integration-${suffix}`);

  return getGitWriteQueue().enqueue('integrate-shared', async () => {
    const branchRef = `refs/heads/${integrationBranch}`;
    const ownerRef = integrationOwnershipRef(integrationBranch);
    // Existing integration-looking branches are never adopted implicitly.
    // The parallel ownership ref records the exact tip AIO last wrote.
    let integrationTip = await gitSafe(
      ['rev-parse', '--verify', '--quiet', `refs/heads/${integrationBranch}`],
      repoRoot,
    );
    let ownedTip = await gitSafe(
      ['rev-parse', '--verify', '--quiet', ownerRef],
      repoRoot,
    );
    if (integrationTip) {
      if (!ownedTip || ownedTip !== integrationTip) {
        return {
          success: false,
          integrationBranch,
          error: 'Integration branch is not registered as AIO-owned',
        };
      }
    } else {
      if (ownedTip) {
        return {
          success: false,
          integrationBranch,
          error: 'AIO integration ownership metadata is stale',
        };
      }
      const baseTip = await git(['rev-parse', baseBranch], repoRoot);
      await git(['update-ref', branchRef, baseTip, ZERO_OID], repoRoot);
      try {
        await git(['update-ref', ownerRef, baseTip, ZERO_OID], repoRoot);
      } catch (error) {
        await gitSafe(['update-ref', '-d', branchRef, baseTip], repoRoot);
        throw error;
      }
      integrationTip = baseTip;
      ownedTip = baseTip;
    }

    // Skip if the session branch is already contained in the integration branch.
    if (await isAncestor(sessionBranch, integrationBranch, repoRoot)) {
      return {
        success: true,
        integrationBranch,
        alreadyIntegrated: true,
        mergeCommit: integrationTip,
      };
    }

    await git(['worktree', 'add', intPath, integrationBranch], repoRoot);
    try {
      const checkedOutTip = await git(['rev-parse', 'HEAD'], intPath);
      if (checkedOutTip !== ownedTip) {
        throw new Error('Managed integration branch changed before checkout');
      }
      const msg = commitMessage ?? `Auto-integrate ${sessionBranch} into ${integrationBranch}`;
      if (strategy === 'squash') {
        await git(['merge', '--squash', sessionBranch], intPath);
        await git(['commit', '--no-gpg-sign', '--no-verify', '-m', msg], intPath);
      } else {
        await git(['merge', '--no-ff', '--no-verify', '--no-gpg-sign', '-m', msg, sessionBranch], intPath);
      }
      const head = await git(['rev-parse', 'HEAD'], intPath);
      await git(['update-ref', ownerRef, head, ownedTip], repoRoot);
      logger.info('WorktreeIntegration: auto-integrated into shared branch', {
        sessionBranch,
        integrationBranch,
        mergeCommit: head,
      });
      return { success: true, integrationBranch, mergeCommit: head };
    } catch (err) {
      const status = await gitSafe(['status', '--porcelain'], intPath);
      const conflictFiles = parseConflictFiles(status);
      await gitSafe(['merge', '--abort'], intPath);
      logger.warn('WorktreeIntegration: shared integration conflict', {
        sessionBranch,
        integrationBranch,
        conflictFiles,
      });
      return {
        success: false,
        integrationBranch,
        error: err instanceof Error ? err.message : String(err),
        conflictFiles: conflictFiles.length > 0 ? conflictFiles : undefined,
      };
    } finally {
      await git(['worktree', 'remove', '--force', intPath], repoRoot);
      const remaining = parseWorktreeCheckouts(
        await git(['worktree', 'list', '--porcelain'], repoRoot),
      );
      if (remaining.some((checkout) =>
        canonicalPath(checkout.path) === canonicalPath(intPath)
      )) {
        throw new Error('Temporary integration worktree cleanup failed');
      }
    }
  });
}

/**
 * Fast-forward `baseBranch` to the integration branch tip, but ONLY when the
 * base is not checked out in any live worktree (advancing a checked-out branch
 * would desync that worktree). Returns true if it advanced. In the typical AIO
 * topology the root holds the base branch, so this safely no-ops and the work
 * stays on the integration branch for a controlled promotion.
 */
export async function tryAdvanceBaseBranch(
  repoRoot: string,
  baseBranch: string,
  integrationBranch: string,
): Promise<boolean> {
  if (await isBranchCheckedOut(repoRoot, baseBranch)) return false;

  const baseTip = await gitSafe(['rev-parse', baseBranch], repoRoot);
  const intTip = await gitSafe(['rev-parse', integrationBranch], repoRoot);
  if (!baseTip || !intTip || baseTip === intTip) return false;
  // Only a true fast-forward (base is an ancestor of the integration tip).
  if (!(await isAncestor(baseBranch, integrationBranch, repoRoot))) return false;

  try {
    await getGitWriteQueue().enqueue('advance-base', () =>
      git(['update-ref', `refs/heads/${baseBranch}`, intTip, baseTip], repoRoot),
    );
    logger.info('WorktreeIntegration: fast-forwarded base branch', {
      baseBranch,
      integrationBranch,
      to: intTip,
    });
    return true;
  } catch (err) {
    logger.warn('WorktreeIntegration: base fast-forward failed', {
      baseBranch,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
