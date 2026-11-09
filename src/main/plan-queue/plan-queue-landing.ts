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

import * as path from 'path';
import { buildCliEnv } from '../cli/cli-environment';
import { getLogger } from '../logging/logger';
import { gitExec, gitExecSafe } from '../workspace/git/git-exec';
import { getGitWriteQueue } from '../workspace/git/git-write-queue';
import { integrationOwnershipRef, promoteIntegrationBranch } from '../workspace/git/worktree-integration';
import { CONFLICT_CODES } from './plan-queue-git';
import { isTestCommand } from './plan-queue-gate-receipts';
import { assertQueueCheckout } from './plan-queue-orphan-checkout';
import { QUEUE_TEST_ENV, runInProcessGroup } from './plan-queue-process';
import { buildLandingCommit, type LandingDocument } from './plan-queue-squash';
import type { PlanQueueItem } from './plan-queue.types';
import { LandingTimer } from './plan-queue-timings';
import { workSourceFor } from './plan-queue-work-sources';

const logger = getLogger('PlanQueueLanding');

const GATE_TIMEOUT_MS = 15 * 60_000;
const GATE_OUTPUT_TAIL = 6_000;

export type SyncResult =
  | { status: 'up-to-date' }
  | { status: 'merged'; head: string }
  | { status: 'conflict'; conflictFiles: string[] };

export type GateResult = { ok: true } | { ok: false; command: string; output: string; timedOut?: boolean };

export type LandResult =
  | { status: 'landed'; commit: string; mergedPaths?: string[] }
  | { status: 'conflict'; conflictFiles: string[] }
  /**
   * The landing is not finalizable yet. When this follows a promotion whose
   * document merge was interrupted and could not be recovered, the commit IS
   * already on the base branch; the item holds here with the backup reason
   * until James restores his edits, exactly as a crash between the
   * fast-forward and the document writes would.
   */
  | { status: 'blocked'; reason: string }
  /** The root checkout's uncommitted work is on paths this landing changes, and the overlap resolver refused them. */
  | { status: 'dirty-overlap'; reason: string; paths: string[] }
  /** The repository's pre-commit hook refused the landing commit, or ran out of time (`timedOut`). */
  | { status: 'hook-failed'; output: string; timedOut?: boolean }
  /** The item branch carries active plan/spec/livetest documents, which never land. */
  | { status: 'active-documents'; paths: string[]; note?: string };

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
export async function syncItemWithBase(item: PlanQueueItem, baseBranch: string, repoRoot: string): Promise<SyncResult> {
  if (!item.worktreePath) throw new Error(`Plan queue item ${item.id} has no worktree`);
  const worktreePath = item.worktreePath;

  return getGitWriteQueue().enqueue('plan-queue-sync', async () => {
    await assertQueueCheckout(worktreePath, requireGit(item).branchName, repoRoot);
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
      if (!await workSourceFor(item.sourceKind).resolveSyncConflict(worktreePath, conflictFiles)) return { status: 'conflict', conflictFiles };
    }
    return { status: 'merged', head: await gitExec(['rev-parse', 'HEAD'], worktreePath) };
  });
}

/** Run the deterministic post-merge commands in the item worktree; stop at the first failure. */
export async function runPostMergeGate(commands: readonly string[], cwd: string, signal?: AbortSignal): Promise<GateResult> {
  for (const command of commands) {
    const { exitCode, output, timedOut } = await runShell(command, cwd, signal);
    if (exitCode !== 0) {
      return { ok: false, command, output: output.slice(-GATE_OUTPUT_TAIL), ...(timedOut ? { timedOut } : {}) };
    }
  }
  return { ok: true };
}

function runShell(command: string, cwd: string, signal?: AbortSignal): Promise<{ exitCode: number; output: string; timedOut?: boolean }> {
  // buildCliEnv: a packaged app starts with a stripped PATH that may not find node/npm.
  // Own process group: a timed-out gate command's children must not outlive it in the worktree.
  return runInProcessGroup(command, [], {
    cwd,
    env: { ...buildCliEnv(), ...QUEUE_TEST_ENV },
    shell: true,
    timeoutMs: GATE_TIMEOUT_MS,
    outputTail: GATE_OUTPUT_TAIL,
    label: `\`${command}\``,
    signal,
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
    resolveDirtyOverlap: workSourceFor(item.sourceKind).overlapResolver(item.id),
  });
  await deleteIntegrationRefs(repoRoot, integrationBranch);
  if (promotion.status === 'blocked') {
    logger.warn('Plan queue landing blocked', { itemId: item.id, reason: promotion.reason });
    const reason = promotion.reason
      + (promotion.overlaps && promotion.overlaps.length > 1 ? ` Overlapping paths: ${promotion.overlaps.join(', ')}.` : '');
    return promotion.code === 'dirty-overlap' ? { status: 'dirty-overlap', reason, paths: promotion.overlaps ?? [] } : { status: 'blocked', reason };
  }
  if (promotion.status === 'promoted' && promotion.documentMergeInterrupted) {
    // The fast-forward already moved the base; only the document-merge writes
    // were interrupted. Reconcile the durable backup now — what the next
    // landing attempt would do — so this attempt lands when the merge can
    // complete, and holds the item in its designed land-blocked state with the
    // backup visible when it cannot.
    logger.warn('Plan queue landing: document merge finish failed after promotion; recovering from the backup', {
      itemId: item.id,
      message: promotion.documentMergeInterrupted,
    });
    const recovered = await workSourceFor(item.sourceKind).recoverLandingMerge(repoRoot, item.id);
    return recovered.ok
      ? { status: 'landed', commit: promotion.tip, ...(recovered.mergedPaths.length ? { mergedPaths: recovered.mergedPaths } : {}) }
      : { status: 'blocked', reason: recovered.reason };
  }
  return { status: 'landed', commit: promotion.tip, ...('mergedPaths' in promotion ? { mergedPaths: promotion.mergedPaths } : {}) };
}

/**
 * Why the item must not land when its branch carries commits the base branch
 * no longer has (the base was reset past them), or null when it may. The
 * squash would put back everything they added, under this item's name.
 *
 * The item's own commits are the branch's first-parent line down to where it
 * started. Anything else not on the base came in through a merge, so the
 * branch is foreign-carrying when it started from a commit the base no longer
 * has, or when it merged in commits the base does not have.
 */
async function strayHistoryReason(item: PlanQueueItem, branchName: string, baseBranch: string, baseTip: string, repoRoot: string): Promise<string | null> {
  let stray = '';
  if (item.baseCommit && !(await succeeds(['merge-base', '--is-ancestor', item.baseCommit, baseTip], repoRoot))) {
    stray = item.baseCommit;
  } else {
    const own = new Set((await gitExec(['rev-list', '--first-parent', branchName, `^${baseTip}`], repoRoot)).split('\n'));
    stray = (await gitExec(['rev-list', '--reverse', branchName, `^${baseTip}`], repoRoot)).split('\n').find((c) => c && !own.has(c)) ?? '';
  }
  if (!stray) return null;
  const subject = await gitExecSafe(['log', '-1', '--format=%s', stray], repoRoot);
  logger.warn('Plan queue landing refused: the branch carries commits the base branch no longer has', { itemId: item.id, stray });
  return `Not landed: this item's branch carries commit ${stray.slice(0, 8)}${subject ? ` ("${subject}")` : ''}, which is not on ${baseBranch}, `
    + `so landing it would put that commit's changes on ${baseBranch} too. Its work is safe on ${branchName}; `
    + `its own changes need moving onto the current ${baseBranch} before it can land.`;
}

/**
 * Only complete, green machine receipts for this checklist may cover a hook's tests, and only when the checklist
 * itself ran tests that reported passing. A checklist without a test run (a livetest's type check and lint) proves
 * nothing about tests, so the hook still runs them.
 */
function checkedTreeForLanding(item: PlanQueueItem, commands: readonly string[]): string | null {
  const verdict = item.verdict;
  if (verdict?.verdict !== 'PASS' || !commands.length || verdict.gatesRun.length !== commands.length) return null;
  const tree = verdict.gatesRun[0].testedTree;
  if (!tree || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) return null;
  const green = verdict.gatesRun.every((receipt, index) => receipt.command === commands[index] && receipt.testedTree === tree
    && receipt.exitCode === 0 && !receipt.timedOut
    && (receipt.classification === 'passed' || receipt.classification === 'not-recognised'));
  const ranTests = verdict.gatesRun.some(receipt => isTestCommand(receipt.command) && receipt.classification === 'passed');
  return green && ranTests ? tree : null;
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
  configuredCommands: readonly string[],
  documents: readonly LandingDocument[] = [],
  onCommitBuilt?: (commit: string) => void,
  signal?: AbortSignal,
  timer = new LandingTimer(),
): Promise<LandResult> {
  const { branchName } = requireGit(item);
  if (!item.worktreePath) throw new Error(`Plan queue item ${item.id} has no worktree`);
  const integrationBranch = `integration/${branchName}`;
  const baseTip = await gitExec(['rev-parse', `refs/heads/${baseBranch}`], repoRoot);

  const recordedCommit = item.landedCommit;
  if (recordedCommit) {
    // A previous attempt died after promoting...
    if (await succeeds(['merge-base', '--is-ancestor', recordedCommit, baseTip], repoRoot)) {
      await deleteIntegrationRefs(repoRoot, integrationBranch);
      return { status: 'landed', commit: recordedCommit };
    }
    // ...or after building the commit but before promoting it.
    const parent = await gitExecSafe(['rev-parse', `${recordedCommit}^`], repoRoot);
    if (parent === baseTip) {
      signal?.throwIfAborted();
      return timer.measure('publish', () => promote(item, repoRoot, baseBranch, integrationBranch, recordedCommit));
    }
  }

  const stray = await strayHistoryReason(item, branchName, baseBranch, baseTip, repoRoot);
  if (stray) return { status: 'blocked', reason: stray };

  const built = await buildLandingCommit({
    repoRoot,
    worktreePath: item.worktreePath,
    branchName,
    itemId: item.id,
    baseTip,
    message: commitMessage,
    documents,
    greenTestedTree: checkedTreeForLanding(item, configuredCommands),
    ...(item.section != null ? { stepPlan: path.relative(repoRoot, item.sourceRef) } : {}),
    signal,
    timer,
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
      signal?.throwIfAborted();
      return timer.measure('publish', () => promote(item, repoRoot, baseBranch, integrationBranch, built.commit));
  }
}
