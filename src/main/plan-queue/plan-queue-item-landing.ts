/**
 * Plan Queue landing step — turn a `landing` item into one commit on the base
 * branch, made with the repository's hooks, with its closed documents inside.
 *
 * Order matters and is what keeps every failure honest:
 *   1. bring the base in if it moved since the PASS (conflict or failed
 *      post-merge gate → back to the worker);
 *   2. prepare the closed documents without touching the root checkout — a
 *      failure here parks the item `land-blocked` before anything lands;
 *   3. build the squash commit with hooks (a refusal goes back to the worker
 *      once, then parks) and record it before promoting, so a crash in between
 *      re-promotes instead of rebuilding;
 *   4. fast-forward the base, then retire the superseded root documents.
 *
 * Runs under the item lock and the single landing chain (PlanQueueItemFlow).
 */

import { existsSync } from 'fs';
import type { PlanQueueParkReason } from '@contracts/schemas/plan-queue';
import { getLogger } from '../logging/logger';
import { gitExec } from '../workspace/git/git-exec';
import {
  documentsAreCommitted,
  prepareClosedDocuments,
  renameDocumentsInPlace,
  retireActiveDocuments,
  type PreparedDocuments,
} from './plan-queue-doc-close';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { landItemBranch, runPostMergeGate, syncItemWithBase } from './plan-queue-landing';
import { buildActiveDocumentsPrompt, buildConflictPrompt, buildGateFailurePrompt } from './plan-queue-prompts';
import { restoreItemCheckout } from './plan-queue-squash';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

const logger = getLogger('PlanQueueItemLanding');

/**
 * A landing refused twice (hook or active documents) parks instead of looping.
 * The count is on the item row, so a restart between refusals does not reset it.
 */
const MAX_LANDING_REFUSALS = 2;

export interface PlanQueueLandingContext {
  readonly host: PlanQueueFlowHost;
  /** Back to the worker with a prompt; `detail` tells the panel why. Lock held. */
  toFixing(item: PlanQueueItem, prompt: string, detail: string): Promise<void>;
  /** Park, checkpointing first. Lock held. */
  park(item: PlanQueueItem, reason: PlanQueueParkReason, detail: string): Promise<void>;
  retireWorker(item: PlanQueueItem): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireBaseBranch(run: PlanQueueRun): string {
  if (!run.config.baseBranch) throw new Error(`Plan queue run ${run.id} has no base branch`);
  return run.config.baseBranch;
}

async function isAncestor(commit: string, of: string, repoRoot: string): Promise<boolean> {
  return gitExec(['merge-base', '--is-ancestor', commit, of], repoRoot).then(() => true, () => false);
}

export class PlanQueueItemLanding {
  constructor(private readonly ctx: PlanQueueLandingContext) {}

  async land(itemId: string, options: { operatorOverride?: boolean }): Promise<void> {
    const { host } = this.ctx;
    let item = host.getItem(itemId);
    if (item.state !== 'landing') return;
    const run = host.getRun(item.runId);
    const repoRoot = run.workspaceCwd;
    const baseBranch = requireBaseBranch(run);
    const closeDocuments = !options.operatorOverride && (item.verdict?.documentComplete ?? true);

    if (item.worktreePath && item.branchName && existsSync(item.worktreePath)) {
      // A crash while the squash was being built leaves the worktree on a
      // detached HEAD; restore the item branch before anything checkpoints.
      await restoreItemCheckout(item.worktreePath, item.branchName);
    }

    const baseTip = await gitExec(['rev-parse', `refs/heads/${baseBranch}`], repoRoot);
    const alreadyLanded = item.landedCommit !== null && (await isAncestor(item.landedCommit, baseTip, repoRoot));
    if (!alreadyLanded) {
      const landed = await this.buildAndPromote(item, run, baseTip, closeDocuments);
      if (!landed) return;
      item = landed;
    }
    if (item.landingRefusals) item = host.save({ ...item, landingRefusals: 0 });

    const notes: string[] = [];
    if (options.operatorOverride) {
      notes.push('Landed by James without a verifier PASS; the document was left open.');
    } else if (closeDocuments) {
      notes.push(...(await this.finishDocuments(item, repoRoot, baseBranch)));
    }

    if (item.worktreePath && existsSync(item.worktreePath)) {
      // No checkpoint here: anything new in the tree after landing is unlanded
      // work, and the proof below refuses to remove a dirty tree.
      const removal = await host.worktrees.removeWithProof(item, repoRoot);
      if (removal.removed) item = host.getItem(item.id);
      else notes.push(`Worktree kept (${removal.reason}: ${removal.detail}).`);
    } else if (item.worktreePath) {
      item = host.save({ ...item, worktreePath: null });
    }

    item = host.transition(item, 'landed', { detail: notes.join(' ') || null, question: null, parkReason: null });
    if (!item.worktreePath && item.branchName) {
      try {
        await host.worktrees.deleteBranchWithProof(item, repoRoot);
      } catch (error) {
        logger.warn('Plan queue: landed branch was not deleted', { itemId: item.id, error: errorMessage(error) });
      }
    }
    this.ctx.retireWorker(host.getItem(item.id));
    host.requestPump();
  }

  /** Steps 1-3 and the fast-forward. Returns the landed item, or null when it went elsewhere. */
  private async buildAndPromote(
    start: PlanQueueItem,
    run: PlanQueueRun,
    baseTip: string,
    closeDocuments: boolean,
  ): Promise<PlanQueueItem | null> {
    const { host } = this.ctx;
    const repoRoot = run.workspaceCwd;
    const baseBranch = requireBaseBranch(run);
    let item = start;

    // A commit built on an older base can no longer be promoted; rebuild it.
    if (item.landedCommit) {
      const parent = await gitExec(['rev-parse', `${item.landedCommit}^`], repoRoot).catch(() => '');
      if (parent !== baseTip) item = host.save({ ...item, landedCommit: null });
    }

    if (!item.landedCommit && item.verifiedMainCommit !== baseTip) {
      // Another item landed while this one was being verified: its PASS is stale.
      const sync = await syncItemWithBase(item, baseBranch);
      if (sync.status === 'conflict') {
        await this.ctx.toFixing(item, buildConflictPrompt(baseBranch, sync.conflictFiles),
          `Not landed: merging ${baseBranch} before landing conflicted (${sync.conflictFiles.join(', ')}); sent back to the worker.`);
        return null;
      }
      if (sync.status === 'merged') {
        item = await host.worktrees.checkpoint(item, `merge ${baseBranch} before landing`);
        const gate = await runPostMergeGate(run.config.postMergeGate, item.worktreePath!);
        if (!gate.ok) {
          await this.ctx.toFixing(item, buildGateFailurePrompt(gate.command, gate.output),
            `Not landed: \`${gate.command}\` failed after merging ${baseBranch}; sent back to the worker.`);
          return null;
        }
      }
    }
    if (!item.landedCommit) item = await host.worktrees.checkpoint(item, 'final');

    // A recorded commit already carries its closed documents; only a new build needs them.
    let prepared: PreparedDocuments = { mode: 'commit', documents: [] };
    if (closeDocuments && !item.landedCommit) {
      try {
        prepared = await prepareClosedDocuments(item.documentPath, repoRoot);
      } catch (error) {
        await this.ctx.park(item, 'land-blocked', `Nothing was landed: the documents could not be closed (${errorMessage(error)}).`);
        return null;
      }
    }

    const message = `${run.kind === 'livetests' ? 'Livetest' : 'Plan'}: ${documentStemOf(item.documentPath)}\n\n`
      + `Landed by Plan Queue after ${item.round} verification round(s).\nItem: ${item.id}`;
    const result = await landItemBranch(
      item,
      repoRoot,
      baseBranch,
      message,
      prepared.mode === 'commit' ? prepared.documents : [],
      (commit) => { item = host.save({ ...host.getItem(item.id), landedCommit: commit }); },
    );
    switch (result.status) {
      case 'landed':
        return host.save({ ...host.getItem(item.id), landedCommit: result.commit });
      case 'conflict': {
        // Base moved between the check above and the squash; bring it in so the
        // conflict is in the worker's tree, where it can be resolved.
        const sync = await syncItemWithBase(item, baseBranch);
        const files = sync.status === 'conflict' ? sync.conflictFiles : result.conflictFiles;
        await this.ctx.toFixing(item, buildConflictPrompt(baseBranch, files),
          `Not landed: ${baseBranch} moved during landing and conflicts (${files.join(', ')}); sent back to the worker.`);
        return null;
      }
      case 'blocked':
        await this.ctx.park(host.getItem(item.id), 'land-blocked', result.reason);
        return null;
      case 'hook-failed':
        await this.refused(host.getItem(item.id), 'the pre-commit hook refused the landing commit',
          buildGateFailurePrompt('git commit (the repository pre-commit hook)', result.output), result.output);
        return null;
      case 'active-documents':
        await this.refused(host.getItem(item.id), `the branch carries active planning documents (${result.paths.join(', ')})`,
          buildActiveDocumentsPrompt(result.paths), result.paths.join(', '));
        return null;
    }
  }

  /** Back to the worker the first time; parked the second, so a refusal cannot loop. */
  private async refused(item: PlanQueueItem, summary: string, prompt: string, evidence: string): Promise<void> {
    const count = item.landingRefusals + 1;
    if (count >= MAX_LANDING_REFUSALS) {
      await this.ctx.park({ ...item, landingRefusals: 0 }, 'land-blocked', `Not landed: ${summary} again. ${evidence.slice(-2000)}`);
      return;
    }
    await this.ctx.toFixing({ ...item, landingRefusals: count }, prompt, `Not landed: ${summary}; sent back to the worker.`);
  }

  /** Retire the root copies the landing commit superseded, or rename never-committed documents in place. */
  private async finishDocuments(item: PlanQueueItem, repoRoot: string, baseBranch: string): Promise<string[]> {
    if (await documentsAreCommitted(item.documentPath, repoRoot)) {
      try {
        return await retireActiveDocuments(item.documentPath, repoRoot, baseBranch);
      } catch (error) {
        return [`The closed documents landed with the code; removing the old root copies failed: ${errorMessage(error)}`];
      }
    }
    // Never committed (outside the repository or ignored): renamed in place.
    // prepareClosedDocuments already checked the files exist and the names are
    // free, so this can only fail on a filesystem error.
    try {
      await renameDocumentsInPlace(item.documentPath);
      return [];
    } catch (error) {
      return [`Landed, but renaming the uncommitted documents to _completed failed: ${errorMessage(error)}`];
    }
  }
}

function documentStemOf(documentPath: string): string {
  return (documentPath.split(/[\\/]/).pop() ?? documentPath).replace(/\.md$/i, '');
}
