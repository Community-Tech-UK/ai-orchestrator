/**
 * Plan Queue landing — turn a verified item branch into one squash commit on
 * the base branch.
 *
 * Callers hold the queue's single landing lock. Every step is idempotent, so a
 * landing interrupted by a crash can simply be run again from the item row.
 *
 * The squash commit is built in the item's own worktree, which has the
 * repository's dependencies, so it is made WITH the repository's pre-commit
 * hook (plan-queue-squash.ts). The item's closed documents go into that same
 * commit, so code and documents land together or not at all. Promotion then
 * fast-forwards the base branch through the managed-integration refs the
 * promoter verifies.
 */

import { buildCliEnv } from '../cli/cli-environment';
import { getLogger } from '../logging/logger';
import { gitExec, gitExecSafe } from '../workspace/git/git-exec';
import { getGitWriteQueue } from '../workspace/git/git-write-queue';
import { integrationOwnershipRef, promoteIntegrationBranch } from '../workspace/git/worktree-integration';
import { CONFLICT_CODES } from './plan-queue-git';
import { runInProcessGroup } from './plan-queue-process';
import { buildLandingCommit, type LandingDocument } from './plan-queue-squash';
import type { PlanQueueItem } from './plan-queue.types';

const logger = getLogger('PlanQueueLanding');

const GATE_TIMEOUT_MS = 15 * 60_000;
const GATE_OUTPUT_TAIL = 6_000;

export type SyncResult =
  | { status: 'up-to-date' }
  | { status: 'merged'; head: string }
  | { status: 'conflict'; conflictFiles: string[] };

export type GateResult = { ok: true } | { ok: false; command: string; output: string };

export type LandResult =
  | { status: 'landed'; commit: string }
  | { status: 'conflict'; conflictFiles: string[] }
  | { status: 'blocked'; reason: string }
  /** The repository's pre-commit hook refused the landing commit. */
  | { status: 'hook-failed'; output: string }
  /** The item branch carries active plan/spec/livetest documents, which never land. */
  | { status: 'active-documents'; paths: string[] };

const ZERO_OID = '0000000000000000000000000000000000000000';

/** True when the git command exits 0 (used for `--is-ancestor` / `--quiet` probes). */
function succeeds(args: string[], cwd: string): Promise<boolean> {
  return gitExec(args, cwd).then(() => true, () => false);
}

function requireGit(item: PlanQueueItem): { branchName: string } {
  if (!item.branchName) throw new Error(`Plan queue item ${item.id} has no branch`);
  return { branchName: item.branchName };
}

/**
 * Bring the base branch into the item branch. On conflict the merge is left IN
 * PLACE in the worktree for the worker to resolve — aborting it would throw the
 * resolution context away. The caller checkpoints after a clean merge.
 */
export async function syncItemWithBase(item: PlanQueueItem, baseBranch: string): Promise<SyncResult> {
  if (!item.worktreePath) throw new Error(`Plan queue item ${item.id} has no worktree`);
  const worktreePath = item.worktreePath;

  return getGitWriteQueue().enqueue('plan-queue-sync', async () => {
    const baseTip = await gitExec(['rev-parse', `refs/heads/${baseBranch}`], worktreePath);
    if (await succeeds(['merge-base', '--is-ancestor', baseTip, 'HEAD'], worktreePath)) {
      return { status: 'up-to-date' };
    }

    try {
      await gitExec(
        ['merge', '--no-verify', '--no-gpg-sign', '--no-edit', '-m', `Plan queue: merge ${baseBranch}`, baseBranch],
        worktreePath,
      );
    } catch {
      const status = await gitExec(['status', '--porcelain'], worktreePath);
      const conflictFiles = status
        .split('\n')
        .filter((line) => CONFLICT_CODES.has(line.slice(0, 2)))
        .map((line) => line.slice(3).trim());
      if (conflictFiles.length === 0) throw new Error(`Merging ${baseBranch} failed without conflicts`);
      return { status: 'conflict', conflictFiles };
    }
    return { status: 'merged', head: await gitExec(['rev-parse', 'HEAD'], worktreePath) };
  });
}

/** Run the deterministic post-merge commands in the item worktree; stop at the first failure. */
export async function runPostMergeGate(commands: readonly string[], cwd: string): Promise<GateResult> {
  for (const command of commands) {
    const { exitCode, output } = await runShell(command, cwd);
    if (exitCode !== 0) {
      return { ok: false, command, output: output.slice(-GATE_OUTPUT_TAIL) };
    }
  }
  return { ok: true };
}

function runShell(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
  // buildCliEnv: a packaged app starts with a stripped PATH that may not find node/npm.
  // Own process group: a timed-out gate command's children must not outlive it in the worktree.
  return runInProcessGroup(command, [], {
    cwd,
    env: buildCliEnv(),
    shell: true,
    timeoutMs: GATE_TIMEOUT_MS,
    outputTail: GATE_OUTPUT_TAIL,
    label: `\`${command}\``,
  });
}

async function deleteIntegrationRefs(repoRoot: string, integrationBranch: string): Promise<void> {
  await getGitWriteQueue().enqueue('plan-queue-integration-cleanup', async () => {
    await gitExecSafe(['update-ref', '-d', `refs/heads/${integrationBranch}`], repoRoot);
    await gitExecSafe(['update-ref', '-d', integrationOwnershipRef(integrationBranch)], repoRoot);
  });
}

/** Point the managed-integration branch and its ownership ref at `commit`, as the promoter requires. */
async function writeIntegrationRefs(repoRoot: string, integrationBranch: string, commit: string): Promise<void> {
  await getGitWriteQueue().enqueue('plan-queue-integration-refs', async () => {
    await gitExec(['update-ref', `refs/heads/${integrationBranch}`, commit, ZERO_OID], repoRoot);
    await gitExec(['update-ref', integrationOwnershipRef(integrationBranch), commit, ZERO_OID], repoRoot);
  });
}

async function promote(
  item: PlanQueueItem,
  repoRoot: string,
  baseBranch: string,
  integrationBranch: string,
  commit: string,
): Promise<LandResult> {
  await deleteIntegrationRefs(repoRoot, integrationBranch);
  await writeIntegrationRefs(repoRoot, integrationBranch, commit);
  const promotion = await promoteIntegrationBranch(repoRoot, baseBranch, integrationBranch, commit, {
    dirtyRootPolicy: 'block-overlap',
  });
  await deleteIntegrationRefs(repoRoot, integrationBranch);
  if (promotion.status === 'blocked') {
    logger.warn('Plan queue landing blocked', { itemId: item.id, reason: promotion.reason });
    return { status: 'blocked', reason: promotion.reason };
  }
  return { status: 'landed', commit: promotion.tip };
}

/**
 * Squash the item branch, with its closed documents, into one commit made with
 * the repository's hooks, and fast-forward the base branch to it. Promotion
 * uses `block-overlap`, so untracked working documents in the root checkout do
 * not block it; a root file the landing would overwrite still does.
 *
 * `onCommitBuilt` receives the commit before promotion so the caller can
 * record it: after a crash between the two, the recorded commit is promoted
 * again (if the base has not moved) rather than rebuilt.
 */
export async function landItemBranch(
  item: PlanQueueItem,
  repoRoot: string,
  baseBranch: string,
  commitMessage: string,
  documents: readonly LandingDocument[] = [],
  onCommitBuilt?: (commit: string) => void,
): Promise<LandResult> {
  const { branchName } = requireGit(item);
  if (!item.worktreePath) throw new Error(`Plan queue item ${item.id} has no worktree`);
  const integrationBranch = `integration/${branchName}`;
  const baseTip = await gitExec(['rev-parse', `refs/heads/${baseBranch}`], repoRoot);

  if (item.landedCommit) {
    // A previous attempt died after promoting...
    if (await succeeds(['merge-base', '--is-ancestor', item.landedCommit, baseTip], repoRoot)) {
      await deleteIntegrationRefs(repoRoot, integrationBranch);
      return { status: 'landed', commit: item.landedCommit };
    }
    // ...or after building the commit but before promoting it.
    const parent = await gitExecSafe(['rev-parse', `${item.landedCommit}^`], repoRoot);
    if (parent === baseTip) return promote(item, repoRoot, baseBranch, integrationBranch, item.landedCommit);
  }

  const built = await buildLandingCommit({
    worktreePath: item.worktreePath,
    branchName,
    baseTip,
    message: commitMessage,
    documents,
  });
  switch (built.status) {
    case 'nothing-to-land':
      return { status: 'landed', commit: baseTip };
    case 'conflict':
    case 'hook-failed':
    case 'active-documents':
      return built;
    case 'committed':
      onCommitBuilt?.(built.commit);
      return promote(item, repoRoot, baseBranch, integrationBranch, built.commit);
  }
}
