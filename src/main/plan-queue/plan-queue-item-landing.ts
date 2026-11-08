/**
 * Plan Queue landing step — turn a `landing` item into one commit on the base
 * branch, made with the repository's hooks, with its closed documents inside.
 *
 * Order matters and is what keeps every failure honest:
 *   1. bring the base in if it moved since the PASS (conflict or failed
 *      post-merge gate → back to the worker);
 *   2. prepare the closed documents without touching the root checkout — a
 *      failure here parks the item `land-blocked` before anything lands;
 *   3. check the root checkout's uncommitted edits would merge (it waits if
 *      not, before any hook runs), then build the squash commit with hooks (a
 *      refusal goes back to the worker once, then parks) and record it before
 *      promoting, so a crash in between re-promotes instead of rebuilding;
 *   4. fast-forward the base, then retire the superseded root documents;
 *   5. stop retained sessions before proof cleanup, keeping IDs until it succeeds.
 *
 * Runs under the item lock and the single landing chain (PlanQueueItemFlow).
 */

import { existsSync } from 'fs';
import type { PlanQueueParkReason } from '@contracts/schemas/plan-queue';
import { getLogger } from '../logging/logger';
import { gitExec } from '../workspace/git/git-exec';
import {
  assertNoOtherUnlandedWork,
  documentsAreCommitted,
  prepareClosedDocuments,
  renameDocumentsInPlace,
  retireActiveDocuments,
  type PreparedDocuments,
} from './plan-queue-doc-close';
import { recoverDocumentMergeForItem } from './plan-queue-doc-merge';
import { assertDocumentReview, readDocumentReview, type DocumentReview } from './plan-queue-document-review';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { mergeCheckStillOwed, recordMergeCheckOwed } from './plan-queue-check-timeouts';
import { landItemBranch, runPostMergeGate, syncItemWithBase } from './plan-queue-landing';
import { landingBlockers, overlapReason, type PlanQueueLandingWaits } from './plan-queue-landing-wait';
import { updatePlanIntegrationStatus } from './plan-queue-document-status';
import { buildActiveDocumentsPrompt, buildConflictPrompt, buildGateFailurePrompt } from './plan-queue-prompts';
import { clearPlanningMoveRecord, planningMoveNote } from './plan-queue-planning-files';
import { returnToItemCheckout } from './plan-queue-squash';
import { mergeInProgress } from './plan-queue-git';
import { PlanQueueCheckoutOwnershipError, rescueNote } from './plan-queue-worktree';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';
import type { PlanQueueGateReceipt } from './plan-queue-gate-receipts';
import { groupCoversMovedBase, groupRoundStillIntact } from './plan-queue-group-landing';
import { LandingTimer, recordItemTiming, recordTiming, TIMING_REASONS } from './plan-queue-timings';

const logger = getLogger('PlanQueueItemLanding');

/**
 * A landing refused twice (hook or active documents) parks instead of looping.
 * The count is on the item row, so a restart between refusals does not reset it.
 */
const MAX_LANDING_REFUSALS = 2;

/** Returns to the worker for the base branch moving under the item (conflict or failed post-merge check) before it parks. */
const MAX_BASE_RETURNS = 3;

/** Set for "Land anyway": who authorised it, worded to follow "Landed without a verifier PASS" in the item's note. */
export interface PlanQueueLandingOptions {
  landAnywayBy?: string;
}

export interface PlanQueueLandingContext {
  readonly host: PlanQueueFlowHost;
  /** Back to the worker with a prompt; `detail` tells the panel why. Lock held. */
  toFixing(item: PlanQueueItem, prompt: string, detail: string): Promise<void>;
  /** Park, stopping writers before checkpointing. Lock held. */
  park(item: PlanQueueItem, reason: PlanQueueParkReason, detail: string, requireCheckpoint?: boolean): Promise<void>;
  stopInstance(instanceId: string): Promise<void>;
  /** Where a landing the root checkout's uncommitted code is blocking waits. */
  readonly waits: Pick<PlanQueueLandingWaits, 'begin'>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireBaseBranch(run: PlanQueueRun): string {
  if (!run.config.baseBranch) throw new Error(`Plan queue run ${run.id} has no base branch`);
  return run.config.baseBranch;
}

export async function isAncestor(commit: string, of: string, repoRoot: string): Promise<boolean> {
  return gitExec(['merge-base', '--is-ancestor', commit, of], repoRoot).then(() => true, () => false);
}

/** Landed rows retain session IDs until their post-promotion cleanup has completed. */
export function hasPendingLandingCleanup(item: PlanQueueItem): boolean {
  return item.state === 'landed' && Boolean(item.workerInstanceId || item.verifierInstanceId);
}

export class PlanQueueItemLanding {
  private readonly active = new Map<string, AbortController>();
  private readonly cleanupFailures = new Map<string, string>();
  constructor(private readonly ctx: PlanQueueLandingContext) {}

  cancel(itemId: string): void { this.active.get(itemId)?.abort(); }

  async land(itemId: string, options: PlanQueueLandingOptions): Promise<void> {
    const controller = new AbortController();
    this.active.set(itemId, controller);
    if (options.landAnywayBy === undefined && this.ctx.host.getRun(this.ctx.host.getItem(itemId).runId).status === 'paused') controller.abort();
    try { await this.landActive(itemId, options, controller.signal); }
    catch (error) {
      const item = this.ctx.host.getItem(itemId);
      if (controller.signal.aborted && error === controller.signal.reason && item.landingAutomatic) {
        // Back to how it was before Harness's own retry: checking it again could hand a failure to a worker. It may have
        // merged the base already, so the check after merging is owed whenever it lands.
        recordMergeCheckOwed(this.ctx.host, item);
        this.ctx.host.transition(item, 'parked', { parkReason: 'land-blocked', verifiedMainCommit: null, landedCommit: null,
          detail: 'Harness\'s own retry stopped before landing because the run was paused or changed. Once the run is running, Try merging again tries it.' });
      } else if (controller.signal.aborted && error === controller.signal.reason) {
        this.ctx.host.transition(item, 'awaiting-slot', { verifiedMainCommit: null, landedCommit: null,
          heldAt: item.heldAt ?? Date.now(), detail: 'Paused before landing.' });
      } else {
        logger.error('Plan queue landing failed unexpectedly', error instanceof Error ? error : undefined, { itemId });
        // A folder that is not the item's checkout cannot be checkpointed; requiring it would leave the item stuck in landing.
        if (item.state !== 'landed') {
          const reason = `Landing failed: ${errorMessage(error)}`;
          // Saving the folder can fail for the same reason the landing did. Stay in `landing` only for Pause, whose next hold recovers it.
          await this.ctx.park(item, 'land-blocked', reason, !(error instanceof PlanQueueCheckoutOwnershipError)).catch((parkError: unknown) => {
            if (controller.signal.aborted) throw parkError;
            return this.ctx.park(item, 'land-blocked', reason, false);
          });
        }
      }
    } finally { this.active.delete(itemId); }
  }

  /** A newer attempt's code can reach the base and still end up set aside, when closing its documents failed. */
  private async newerAttemptOnBase(item: PlanQueueItem, baseTip: string, repoRoot: string): Promise<boolean> {
    for (const commit of this.ctx.host.store.newerAttemptCommits(item)) {
      if (await isAncestor(commit, baseTip, repoRoot)) return true;
    }
    return false;
  }

  private async landActive(itemId: string, options: PlanQueueLandingOptions, signal: AbortSignal): Promise<void> {
    const { host } = this.ctx;
    let item = host.getItem(itemId);
    if (item.state !== 'landing') return;
    if (!signal.aborted) {
      // Its turn in the landing line began. The save rewrites the same row to announce it, so the session list stops
      // showing this item as waiting behind another landing.
      recordTiming(host.history, item, TIMING_REASONS.landingStart, {});
      item = host.save(item);
    }
    const run = host.getRun(item.runId);
    const repoRoot = run.workspaceCwd;
    const baseBranch = requireBaseBranch(run);
    // A step job never closes its plan: James or a closing session does that once the last step has landed.
    const closeDocuments = options.landAnywayBy === undefined && item.section == null && (item.verdict?.documentComplete ?? true);

    // A recorded promotion is not complete until pending root edits are restored.
    // This runs before the already-landed shortcut, outside any Git write thunk.
    const recovered = await recoverDocumentMergeForItem(repoRoot, item.id);
    if (!recovered.ok) {
      await this.ctx.park(item, 'land-blocked', recovered.reason);
      return;
    }
    if (recovered.mergedPaths.length) {
      item = host.save({ ...item, detail: `Merged with your uncommitted edits to ${recovered.mergedPaths.join(', ')}; your edits are still uncommitted.` });
    }

    let rescueRef: string | null = null;
    if (item.worktreePath && item.branchName && existsSync(item.worktreePath)) {
      // A crash while the squash was being built leaves the worktree off its
      // branch; restore the item branch before anything checkpoints.
      rescueRef = await returnToItemCheckout(item.worktreePath, item.branchName, item.id, repoRoot);
      if (rescueRef) item = host.save({ ...item, detail: rescueNote(rescueRef) });
    }

    const baseTip = await gitExec(['rev-parse', `refs/heads/${baseBranch}`], repoRoot);
    const alreadyLanded = item.landedCommit !== null && (await isAncestor(item.landedCommit, baseTip, repoRoot));
    if (!alreadyLanded) {
      signal.throwIfAborted();
      // The request-time check cannot see the future: a resumed attempt can reach this point after a newer one merged.
      if (options.landAnywayBy === undefined && (host.store.newerAttemptLanded(item) || await this.newerAttemptOnBase(item, baseTip, repoRoot))) {
        await this.ctx.park(item, 'land-blocked', 'Nothing was landed: a newer attempt at this document merged first.');
        return;
      }
      // Land anyway can't wait: the pump's later attempt wouldn't know it was an override. Nor does Harness's own retry:
      // its run has usually ended, and a wait would hold one of the few job places for a day. It tries again tomorrow.
      const landed = await this.buildAndPromote(item, run, baseTip, closeDocuments, signal, options.landAnywayBy === undefined && !item.landingAutomatic);
      if (!landed) return;
      item = landed;
    }
    if (item.landingRefusals || item.baseConflicts) item = host.save({ ...item, landingRefusals: 0, baseConflicts: 0 });

    const notes: string[] = [];
    if (item.detail?.startsWith('Merged with your uncommitted edits to ')) notes.push(item.detail);
    if (rescueRef) notes.push(rescueNote(rescueRef));
    if (options.landAnywayBy !== undefined) {
      notes.push(`Landed without a verifier PASS ${options.landAnywayBy}; the document was left open.`);
    } else if (closeDocuments) {
      notes.push(...(await this.finishDocuments(item, repoRoot, baseBranch)));
    }
    // A plan that stays open says whether its work is on main; a closed one carries that in its closed copy. Live-test documents have no such line.
    if (!closeDocuments && run.kind === 'plans') {
      try { await updatePlanIntegrationStatus(item.documentPath, item.branchName ?? '', item.landedCommit!, item.section); }
      catch (error) { notes.push(`Code landed, but the plan's "On main" line could not be updated: ${errorMessage(error)}`); }
    }

    item = host.transition(item, 'landed', { workerSession: undefined, detail: notes.join(' ') || null, question: null, parkReason: null });
    await this.finishCleanup(item);
  }

  /** Retry only session/proof cleanup; promoted code is never checkpointed or landed again. Lock held. */
  async finishCleanup(item: PlanQueueItem): Promise<void> {
    const { host } = this.ctx;
    const repoRoot = host.getRun(item.runId).workspaceCwd;
    await Promise.all([item.workerInstanceId, item.verifierInstanceId]
      .filter((id): id is string => Boolean(id)).map(id => this.ctx.stopInstance(id)));
    const notes = item.detail ? [item.detail] : [];
    if (item.worktreePath && existsSync(item.worktreePath)) {
      // A stopped worker's late edits are unlanded work. Proof must preserve a dirty tree.
      const removal = await host.worktrees.removeWithProof(item, repoRoot);
      if (removal.removed) item = host.getItem(item.id);
      else notes.push(`Worktree kept (${removal.reason}: ${removal.detail}).`);
    } else if (item.worktreePath) {
      item = host.save({ ...item, worktreePath: null });
    }

    if (!item.worktreePath && item.branchName) {
      try {
        await host.worktrees.deleteBranchWithProof(item, repoRoot);
      } catch (error) {
        logger.warn('Plan queue: landed branch was not deleted', { itemId: item.id, error: errorMessage(error) });
      }
    }
    await clearPlanningMoveRecord(repoRoot, item.id).catch((error: unknown) => {
      logger.warn('Plan queue: the moved-planning-files record was not removed', { itemId: item.id, error: errorMessage(error) });
    });
    // Proof services persist ownership changes themselves; never restore their stale input row.
    host.save({ ...host.getItem(item.id), workerInstanceId: null, verifierInstanceId: null, detail: notes.join(' ') || null });
    host.requestPump();
  }

  /** Never rejects: a failure stays pending for the scheduler's next pass, and passes are frequent, so each different failure is logged once. Lock held. */
  async retryCleanup(itemId: string): Promise<void> {
    try {
      const item = this.ctx.host.getItem(itemId);
      if (!hasPendingLandingCleanup(item)) return;
      await this.finishCleanup(item);
      this.cleanupFailures.delete(itemId);
    } catch (error) {
      const message = errorMessage(error);
      if (this.cleanupFailures.get(itemId) !== message) logger.warn('Plan queue: landed job cleanup failed; it will be retried', { itemId, error: message });
      this.cleanupFailures.set(itemId, message);
    }
  }

  /** Steps 1-3 and the fast-forward, timed: every attempt that ran a step leaves one landing-time row. */
  private async buildAndPromote(
    start: PlanQueueItem,
    run: PlanQueueRun,
    baseTip: string,
    closeDocuments: boolean,
    signal: AbortSignal,
    canWait: boolean,
  ): Promise<PlanQueueItem | null> {
    const timer = new LandingTimer();
    let outcome = 'failed';
    try {
      const landed = await this.buildAndPromoteMeasured(start, run, baseTip, closeDocuments, signal, canWait, timer);
      outcome = landed ? 'landed' : 'not-landed';
      return landed;
    } finally {
      const detail = timer.detail(outcome);
      if (detail) recordItemTiming(this.ctx.host, start.id, TIMING_REASONS.landing, detail);
    }
  }

  /** Returns the landed item, or null when it went elsewhere. */
  private async buildAndPromoteMeasured(
    start: PlanQueueItem,
    run: PlanQueueRun,
    baseTip: string,
    closeDocuments: boolean,
    signal: AbortSignal,
    canWait: boolean,
    timer: LandingTimer,
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
      const group = await groupCoversMovedBase(item, run, baseTip, host) ? item.verdict?.gatesRun[0]?.checkGroup : undefined;
      const sync = await timer.measure('sync', () => syncItemWithBase(item, baseBranch, repoRoot));
      if (sync.status === 'conflict') {
        await this.returnForBase(item, baseBranch, buildConflictPrompt(baseBranch, sync.conflictFiles),
          `merging ${baseBranch} before landing conflicted (${sync.conflictFiles.join(', ')})`);
        return null;
      }
      const checked = await this.checkMergedBase(item, run, sync.status === 'merged', baseTip, group, signal, timer);
      if (!checked) return null;
      item = checked;
    }
    // A recorded commit carries its closed documents, so it needs no check, unless the landing waited: they could be edited meanwhile.
    if (closeDocuments && (!item.landedCommit || item.landingWaitSince != null)) {
      assertDocumentReview(await readDocumentReview(item.documentPath), this.reviewedDocuments(item));
    }
    if (!item.landedCommit) {
      item = await host.worktrees.checkpoint(item, 'final');
      // Before the planning files move and the hook runs: a landing that cannot promote must not spend the hook's time.
      const blockers = await landingBlockers(item, run);
      if (blockers.length) { await this.waitOrPark(item, blockers, canWait); return null; }
      // Planning files are moved now, before the squash, so landing cleanup never runs with one in the folder.
      const planning = await host.worktrees.preflightPlanningFiles(item);
      const note = planningMoveNote(planning);
      if (planning.failed.length) {
        await this.ctx.park(item, 'land-blocked', `Nothing was landed. ${note} Fix that, or move the file by hand, then press Try merging again.`);
        return null;
      }
      if (note) item = host.save({ ...item, detail: note });
    }

    // A recorded commit already carries its closed documents; only a new build needs them.
    let prepared: PreparedDocuments = { mode: 'commit', documents: [] };
    if (closeDocuments && !item.landedCommit) {
      try {
        await assertNoOtherUnlandedWork(item.documentPath, item.branchName ?? '');
        prepared = await prepareClosedDocuments(item.documentPath, repoRoot, item.worktreePath, this.reviewedDocuments(item));
      } catch (error) {
        await this.ctx.park(item, 'land-blocked', `Nothing was landed: the documents could not be closed (${errorMessage(error)}).`);
        return null;
      }
    }

    const message = `${run.kind === 'livetests' ? 'Livetest' : 'Plan'}: ${documentStemOf(item.documentPath)}${item.section == null ? '' : ` (Step ${item.section})`}\n\n`
      + `Landed by Plan Queue after ${item.round} verification round(s).\nItem: ${item.id}`;
    const result = await landItemBranch(
      item,
      repoRoot,
      baseBranch,
      message,
      run.config.verifierGates,
      prepared.mode === 'commit' ? prepared.documents : [],
      (commit) => { item = host.save({ ...host.getItem(item.id), landedCommit: commit }); },
      signal,
      timer,
    );
    switch (result.status) {
      case 'landed':
        return host.save({ ...host.getItem(item.id), landedCommit: result.commit,
          detail: result.mergedPaths?.length ? `Merged with your uncommitted edits to ${result.mergedPaths.join(', ')}; your edits are still uncommitted.` : null });
      case 'conflict': {
        // Base moved between the check above and the squash; bring it in so the
        // conflict is in the worker's tree, where it can be resolved.
        const sync = await timer.measure('sync', () => syncItemWithBase(item, baseBranch, repoRoot));
        if (sync.status === 'merged') {
          // It merged after all, so there is nothing for a worker to resolve: check that and build the commit again.
          const tip = await gitExec(['rev-parse', `refs/heads/${baseBranch}`], repoRoot);
          const checked = await this.checkMergedBase(host.getItem(item.id), run, true, tip, undefined, signal, timer);
          return checked && this.buildAndPromoteMeasured(checked, run, tip, closeDocuments, signal, canWait, timer);
        }
        const files = sync.status === 'conflict' ? sync.conflictFiles : result.conflictFiles;
        await this.returnForBase(item, baseBranch, buildConflictPrompt(baseBranch, files),
          `${baseBranch} moved during landing and conflicts (${files.join(', ')})`);
        return null;
      }
      case 'blocked':
        await this.ctx.park(host.getItem(item.id), 'land-blocked', result.reason);
        return null;
      case 'dirty-overlap':
        await this.waitOrPark(host.getItem(item.id), result.paths, canWait);
        return null;
      case 'hook-failed':
        // A timeout is not something a worker can fix, and another round would hold every project's landings again.
        if (result.timedOut) {
          await this.ctx.park({ ...host.getItem(item.id), landingRefusals: 0 }, 'land-blocked',
            `Not landed: the pre-commit check ran out of time, so nothing changed on ${baseBranch}. A worker cannot fix a timeout; press Try merging again once the machine is less busy. ${result.output.slice(-1000)}`);
          return null;
        }
        await this.refused(host.getItem(item.id), 'the pre-commit hook refused the landing commit',
          buildGateFailurePrompt('git commit (the repository pre-commit hook)', result.output), result.output);
        return null;
      case 'active-documents':
        await this.refused(host.getItem(item.id), `the branch carries active planning documents (${result.paths.join(', ')})${result.note ? `: ${result.note}` : ''}`,
          buildActiveDocumentsPrompt(result.paths), result.paths.join(', '));
        return null;
    }
  }

  /** Record a merge of the base and run the check it owes. Returns the item, or null when it went elsewhere. */
  private async checkMergedBase(
    start: PlanQueueItem,
    run: PlanQueueRun,
    merged: boolean,
    baseTip: string,
    group: PlanQueueGateReceipt['checkGroup'],
    signal: AbortSignal,
    timer: LandingTimer,
  ): Promise<PlanQueueItem | null> {
    const { host } = this.ctx;
    const repoRoot = run.workspaceCwd;
    const baseBranch = requireBaseBranch(run);
    const item = merged ? await host.worktrees.checkpoint(start, `merge ${baseBranch} before landing`) : start;
    // A check that didn't pass left the merge in place, so the next try finds nothing to merge but still owes the check.
    if (!merged && !mergeCheckStillOwed(host, item)) return item;
    const covered = group && await gitExec(['rev-parse', `refs/heads/${baseBranch}`], repoRoot) === baseTip
      && groupRoundStillIntact(group, host);
    const gate = covered ? { ok: true } as const : await timer.measure('mergeCheck', () => runPostMergeGate(run.config.postMergeGate, item.worktreePath!, signal));
    if (gate.ok) return item;
    // Whatever happens next, the merged work hasn't passed this check; only a new verdict on it settles that.
    recordMergeCheckOwed(host, item);
    if (gate.timedOut) {
      await this.ctx.park(item, 'land-blocked', `Not landed: \`${gate.command}\` ran out of time after merging ${baseBranch}, so nothing changed on ${baseBranch}. A worker cannot fix a timeout; press Try merging again once the machine is quieter.`);
      return null;
    }
    if (item.landingAutomatic) {
      await this.setAsideAgain(item, 'land-blocked', `\`${gate.command}\` failed after merging ${baseBranch}`);
      return null;
    }
    await this.returnForBase(item, baseBranch, buildGateFailurePrompt(gate.command, gate.output),
      `\`${gate.command}\` failed after merging ${baseBranch}`);
    return null;
  }

  /** The root checkout's uncommitted code is in the way: wait for it to clear, or park when waiting is not allowed. Lock held. */
  private async waitOrPark(item: PlanQueueItem, paths: readonly string[], canWait: boolean): Promise<void> {
    const reason = overlapReason(paths);
    const parkNote = canWait ? this.ctx.waits.begin(item, paths, reason)
      : `Not landed. ${reason} ${item.landingAutomatic ? 'Try merging again' : 'Land anyway'} works once these are committed or put away.`;
    if (parkNote !== null) await this.ctx.park(item, 'land-blocked', parkNote);
  }

  /** Harness's own retry starts no worker: what would need one sets the job aside again with its pass, for a later try or James. */
  private async setAsideAgain(item: PlanQueueItem, reason: PlanQueueParkReason, summary: string): Promise<void> {
    if (item.worktreePath && await mergeInProgress(item.worktreePath)) await gitExec(['merge', '--abort'], item.worktreePath);
    await this.ctx.park(item, reason, `Not landed when Harness tried again by itself: ${summary}. `
      + (reason === 'merge-conflict' ? 'Resume hands it back to a worker, which drops its passed check.' : 'Try merging again once that is fixed.'));
  }

  /** Back to the worker while the base branch keeps moving under the item; parked on the fourth return, so it cannot loop. */
  private async returnForBase(item: PlanQueueItem, baseBranch: string, prompt: string, summary: string): Promise<void> {
    if (item.landingAutomatic) return this.setAsideAgain(item, 'merge-conflict', summary);
    const count = item.baseConflicts + 1;
    if (count > MAX_BASE_RETURNS) {
      await this.ctx.park({ ...item, baseConflicts: 0 }, 'merge-conflict',
        `Not landed: ${summary}, and ${baseBranch} has already sent this back to the worker ${MAX_BASE_RETURNS} times. Resume gives it a fresh start once ${baseBranch} has settled.`);
      return;
    }
    await this.ctx.toFixing({ ...item, baseConflicts: count }, prompt, `Not landed: ${summary}; sent back to the worker.`);
  }

  /** Back to the worker the first time; parked the second, so a refusal cannot loop. */
  private async refused(item: PlanQueueItem, summary: string, prompt: string, evidence: string): Promise<void> {
    if (item.landingAutomatic) return this.setAsideAgain(item, 'land-blocked', `${summary}. ${evidence.slice(-2000)}`);
    const count = item.landingRefusals + 1;
    if (count >= MAX_LANDING_REFUSALS) {
      await this.ctx.park({ ...item, landingRefusals: 0 }, 'land-blocked', `Not landed: ${summary} again. ${evidence.slice(-2000)}`);
      return;
    }
    await this.ctx.toFixing({ ...item, landingRefusals: count }, prompt, `Not landed: ${summary}; sent back to the worker.`);
  }

  private reviewedDocuments(item: PlanQueueItem): DocumentReview {
    const hash = this.ctx.host.history.reviewedDocuments(item.id);
    if (!hash) throw new Error('The source document has no recorded checker identity; check it again before closing it.');
    return hash;
  }

  /** Retire the root copies the landing commit superseded, or rename never-committed documents in place. */
  private async finishDocuments(item: PlanQueueItem, repoRoot: string, baseBranch: string): Promise<string[]> {
    const reviewedSha256 = this.reviewedDocuments(item);
    if (await documentsAreCommitted(item.documentPath, repoRoot)) {
      try {
        return await retireActiveDocuments(item.documentPath, repoRoot, baseBranch, reviewedSha256);
      } catch (error) {
        throw new Error(`The closed documents landed with the code; removing the old root copies failed: ${errorMessage(error)}`, { cause: error });
      }
    }
    // Never committed (outside the repository or ignored): close in place,
    // revalidating the accepted bytes rather than adopting a later snapshot.
    try {
      await renameDocumentsInPlace(item.documentPath, reviewedSha256, item.landedCommit!);
      return [];
    } catch (error) {
      throw new Error(`Code landed, but the uncommitted documents remain open: ${errorMessage(error)}`, { cause: error });
    }
  }
}

function documentStemOf(documentPath: string): string {
  return (documentPath.split(/[\\/]/).pop() ?? documentPath).replace(/\.md$/i, '');
}
