import { PlanQueueSpawnRoutingChanged, selectCurrentQueueVerifier } from './plan-queue-checker-routing';
import { holdItem, isHoldNote, PlanQueueSpawnRunPaused, resumeReason, restoreCheckpointAfterVerification } from './plan-queue-run-hold';
import { PlanQueueSpawnStoppedByUser } from './plan-queue-user-close';
/**
 * Plan Queue item flow — the side effects of each item transition: prepare a
 * worktree, run the worker, verify, land, park.
 *
 * Ordering rule throughout: the item row is written BEFORE the side effect it
 * authorises. Holds stop writers before checkpointing. The coordinator owns
 * scheduling (which item runs next) and routes instance outcomes here.
 */

import { existsSync } from 'fs';
import * as path from 'path';
import type { PlanQueueParkReason, PlanQueueVerdict } from '@contracts/schemas/plan-queue';
import type { InstanceProvider } from '../../shared/types/instance.types';
import { AUTOMATION_FAILURE_STATUSES } from '../../shared/types/instance-status-policy';
import { getLogger } from '../logging/logger';
import { holdFromReclaim, releaseReclaimHold } from '../process/reclaim-holds';
import { gitExec } from '../workspace/git/git-exec';
import { appendParkedNote, removeParkedNote } from './plan-queue-doc-close';
import {
  branchExists,
  commitsAhead,
  UnresolvedMergeError,
  unresolvedMergeFiles,
  revertToSnapshot,
  sameTree,
  snapshotTree,
  type TreeSnapshot,
} from './plan-queue-git';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { relaxedSettingsFor } from './plan-queue-relaxation';
import type { PlanQueueTurnOutcome } from './plan-queue-instance-tracker';
import { hasPendingLandingCleanup, PlanQueueItemLanding } from './plan-queue-item-landing';
import { syncItemWithBase } from './plan-queue-landing';
import { quarantineOrphanCheckout, retainedQueuePathExists } from './plan-queue-orphan-checkout';
import { planQueueBranchName } from './plan-queue-worktree';
import {
  buildConflictPrompt,
  buildFixPrompt,
  buildResumePrompt,
  buildVerifierPrompt,
  buildWorkerPrompt,
} from './plan-queue-prompts';
import { canStepUp, stepUpItem } from './plan-queue-step-up';
import { PlanQueueVerifierReminders } from './plan-queue-verifier-reminder';
import type { VerifierSelection } from './plan-queue-verifier-select';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

const logger = getLogger('PlanQueueItemFlow');

/** Two verifier rounds that end without a usable verdict park the item. */
export const MAX_ERRORED_ROUNDS = 2;
const RECLAIM_HOLD_OWNER = 'plan-queue';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function documentStem(documentPath: string): string {
  return path.basename(documentPath).replace(/\.md$/i, '');
}

export class PlanQueueItemFlow {
  /** Tree state each running verification started from. */
  private readonly snapshots = new Map<string, TreeSnapshot>();
  /** Verdicts reported during the verifier's current turn, keyed by item. */
  private readonly pendingVerdicts = new Map<string, { verifierId: string; verdict: PlanQueueVerdict }>();
  private readonly reminders: PlanQueueVerifierReminders;
  /** Per-item operation chain: one side-effecting operation per item at a time. */
  private readonly locks = new Map<string, Promise<void>>();
  private readonly stopping = new Map<string, Promise<void>>();
  /** Failed stops retain ownership without retaining a rejected promise that would block retries. */
  private readonly pendingRetirements = new Set<string>();
  private landingChain: Promise<void> = Promise.resolve();
  private readonly landing: PlanQueueItemLanding;

  constructor(private readonly host: PlanQueueFlowHost) {
    this.reminders = new PlanQueueVerifierReminders(host, (id, outcome) => void this.onVerifierOutcome(id, outcome));
    this.landing = new PlanQueueItemLanding({
      host,
      toFixing: (item, prompt, detail) => this.toFixing(item, prompt, detail),
      park: (item, reason, detail, requireCheckpoint) => this.parkUnlocked(item, reason, detail, requireCheckpoint),
      stopInstance: (id) => this.stopInstance(id),
    });
  }

  /** Runtime ownership, including teardown; persisted instance IDs may be historical. */
  hasActiveWork(itemId: string): boolean {
    const item = this.host.getItem(itemId);
    return this.locks.has(itemId) || hasPendingLandingCleanup(item) || ['preparing', 'working', 'fixing', 'verifying', 'landing'].includes(item.state)
      || [item.workerInstanceId, item.verifierInstanceId].some(id => !!id
        && (this.stopping.has(id) || (this.pendingRetirements.has(id) && this.host.instances.getInstance(id) !== undefined)
          || this.host.tracker.isTracked(id) || this.host.roleOf(id) !== undefined));
  }

  /** Serialize operations; read current state inside the lock before saving. */
  private withItemLock<T>(itemId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(itemId) ?? Promise.resolve();
    const result = previous.then(fn);
    const tail = result.then(() => undefined, () => undefined);
    this.locks.set(itemId, tail);
    void tail.then(() => {
      if (this.locks.get(itemId) === tail) this.locks.delete(itemId);
    });
    return result;
  }

  /** Resolves once no item operation or landing is in flight. Tests and shutdown only. */
  async whenSettled(): Promise<void> {
    while (this.locks.size > 0) {
      await Promise.all([...this.locks.values(), this.landingChain]);
      await new Promise((resolve) => setImmediate(resolve));
    }
    await this.landingChain;
  }

  // Worker
  /**
   * queued → preparing → working. The first transition is synchronous so the
   * scheduler's slot count is exact; the rest runs under the item lock. A
   * parked item's existing branch is reattached rather than recreated.
   */
  startItem(queued: PlanQueueItem): Promise<void> {
    this.host.transition(queued, 'preparing');
    return this.withItemLock(queued.id, async () => {
      let item = this.host.getItem(queued.id);
      if (item.state !== 'preparing') return;
      const run = this.host.getRun(item.runId);
      const resuming = Boolean(item.branchName) && (await branchExists(run.workspaceCwd, item.branchName!));
      try {
        item = resuming
          ? await this.host.worktrees.reattach(item, run.workspaceCwd)
          : await this.host.worktrees.prepare(item, run.workspaceCwd);
      } catch (error) {
        await this.parkUnlocked(this.host.getItem(item.id), 'worktree-error', `Could not prepare the worktree: ${errorMessage(error)}`);
        return;
      }
      const ctx = this.promptContext(run, item);
      const prompt = resuming
        ? buildResumePrompt(ctx, resumeReason(item)) + (await this.conflictAddendum(item, run))
        : buildWorkerPrompt(ctx);
      await this.spawnWorker(item, prompt, 'working');
    });
  }

  /**
   * Boot recovery for an item whose worker session did not survive: make sure
   * its worktree exists (checkpointing whatever is there), then start a fresh
   * worker with a resume prompt.
   */
  resumeAfterRestart(stale: PlanQueueItem): Promise<void> {
    return this.withItemLock(stale.id, async () => {
      let item = this.host.getItem(stale.id);
      if (item.state !== 'preparing' && item.state !== 'working' && item.state !== 'fixing') return;
      const run = this.host.getRun(item.runId);
      try {
        if (item.worktreePath && existsSync(item.worktreePath)) {
          // A merge the worker was still resolving stays in progress; it is
          // re-sent below, never committed with its markers.
          if (!(await unresolvedMergeFiles(item.worktreePath))?.length) {
            item = await this.host.worktrees.checkpoint(item, 'before resume');
          }
        } else if (item.branchName && (await branchExists(run.workspaceCwd, item.branchName))) {
          item = await this.host.worktrees.reattach(item, run.workspaceCwd);
        } else {
          item = await this.host.worktrees.prepare(item, run.workspaceCwd);
        }
      } catch (error) {
        await this.parkUnlocked(this.host.getItem(item.id), 'worktree-error', `Could not recover the worktree: ${errorMessage(error)}`);
        return;
      }
      const prompt = buildResumePrompt(this.promptContext(run, item), 'the app restarted') + (await this.conflictAddendum(item, run));
      await this.spawnWorker(item, prompt, item.state === 'preparing' ? 'working' : null);
    });
  }

  /**
   * `stillHeld`, when given, is a targeted hold (a rule change, not Pause): it does
   * not abort a landing in flight, and it is checked again under the item lock, so
   * a hold that waited behind another change does nothing if the item has moved on.
   */
  hold(itemId: string, reason = 'Paused', stillHeld?: (item: PlanQueueItem) => boolean): Promise<void> {
    if (!stillHeld) this.landing.cancel(itemId);
    return this.withItemLock(itemId, async () => {
      const item = this.host.getItem(itemId);
      if (stillHeld && !stillHeld(item)) return;
      await this.holdUnlocked(item, reason);
    });
  }

  private async holdUnlocked(item: PlanQueueItem, reason = 'Paused'): Promise<void> {
    if (item.state === 'landing') { await this.landing.land(item.id, {}); item = this.host.getItem(item.id); }
    if (hasPendingLandingCleanup(item)) return this.landing.finishCleanup(item);
    await holdItem(this.host, item, (id) => this.stopInstance(id), async (checking) => {
      const before = this.snapshots.get(checking.id);
      if (before && checking.worktreePath) await revertToSnapshot(checking.worktreePath, before);
      else await restoreCheckpointAfterVerification(checking);
      this.snapshots.delete(checking.id);
      this.pendingVerdicts.delete(checking.id);
    }, reason);
  }

  private promptContext(run: PlanQueueRun, item: PlanQueueItem) {
    return {
      item,
      kind: run.kind,
      repoRoot: run.workspaceCwd,
      worktreePath: item.worktreePath ?? '',
      answer: item.answer,
    };
  }

  /** The conflict prompt again, when the worktree holds a merge the worker never finished. */
  private async conflictAddendum(item: PlanQueueItem, run: PlanQueueRun): Promise<string> {
    if (!item.worktreePath || !existsSync(item.worktreePath)) return '';
    const conflicted = await unresolvedMergeFiles(item.worktreePath);
    if (!conflicted?.length || !run.config.baseBranch) return '';
    return `\n\n${buildConflictPrompt(run.config.baseBranch, conflicted)}`;
  }

  private async spawnWorker(
    item: PlanQueueItem,
    prompt: string,
    nextState: 'working' | 'fixing' | null,
  ): Promise<void> {
    const run = this.host.getRun(item.runId);
    if (run.status === 'paused') { await this.holdUnlocked(item); return; }
    try {
      const instance = await this.host.instances.createInstance({
        displayName: `Queue · ${documentStem(item.documentPath)}`,
        isRenamed: true,
        parentId: this.host.liveParentId(run),
        workingDirectory: item.worktreePath ?? run.workspaceCwd,
        initialPrompt: prompt,
        ...(run.workerProvider ? { provider: run.workerProvider as InstanceProvider } : {}),
        ...(run.workerModel ? { modelOverride: run.workerModel } : {}),
        yoloMode: true,
        // A handed-over document's every later worker takes the run's step-up choice (`queueWorkerChoices`).
        metadata: { planQueueRunId: run.id, planQueueItemId: item.id, planQueueRole: 'worker', ...(item.steppedUpAt ? { planQueueSteppedUp: true } : {}) },
      });
      this.host.registerRole(instance.id, { role: 'worker', runId: run.id, itemId: item.id });
      holdFromReclaim(instance.id, RECLAIM_HOLD_OWNER);
      const relaxed = relaxedSettingsFor(run);
      if (relaxed.length) {
        // Holder and sharing runs alike: the audit line is per worker spawn.
        logger.info('Plan queue worker runs under relaxed settings', { itemId: item.id, runId: run.id, settings: relaxed });
      }
      const current = this.host.getItem(item.id);
      const patch = { workerInstanceId: instance.id, question: null, heldAt: null, pendingInstruction: null, detail: isHoldNote(current.detail) ? null : current.detail };
      if (nextState && current.state !== nextState) this.host.transition(current, nextState, patch);
      else this.host.save({ ...current, ...patch });
      this.host.tracker.track(instance.id);
      instance.readyPromise?.catch((error: unknown) => {
        void this.onWorkerOutcome(instance.id, { kind: 'failed', reason: `worker failed to start: ${errorMessage(error)}` });
      });
    } catch (error) {
      if (error instanceof PlanQueueSpawnRunPaused) {
        const current = this.host.getItem(item.id);
        await this.holdUnlocked(error.instanceId ? this.host.save({ ...current, workerInstanceId: error.instanceId }) : current); return;
      }
      if (error instanceof PlanQueueSpawnStoppedByUser && error.instanceId) {
        this.host.save({ ...this.host.getItem(item.id), workerInstanceId: error.instanceId });
        await this.stopInstance(error.instanceId);
      }
      await this.parkUnlocked(this.host.getItem(item.id), error instanceof PlanQueueSpawnStoppedByUser ? 'cancelled' : 'worker-error', error instanceof PlanQueueSpawnStoppedByUser ? 'Stopped: you closed its session. Resume carries on from the same branch.' : `Could not start the worker: ${errorMessage(error)}`);
    }
  }

  /** Send the worker its next turn, respawning it with a resume prompt if its session is gone. */
  private async runWorkerTurn(item: PlanQueueItem, prompt: string): Promise<void> {
    item = this.host.save({ ...item, pendingInstruction: prompt });
    if (this.host.getRun(item.runId).status === 'paused') { await this.holdUnlocked(item); return; }
    const workerId = item.workerInstanceId;
    const worker = workerId ? this.host.instances.getInstance(workerId) : undefined;
    if (workerId && worker && !AUTOMATION_FAILURE_STATUSES.has(worker.status)) {
      this.host.registerRole(workerId, { role: 'worker', runId: item.runId, itemId: item.id });
      this.host.tracker.beginTurn(workerId);
      try {
        await this.host.instances.sendInput(workerId, prompt, undefined, { automatedInput: true, internalSource: 'plan-queue' });
        this.host.save({ ...this.host.getItem(item.id), pendingInstruction: null });
        return;
      } catch (error) {
        logger.warn('Plan queue: worker send failed; starting a fresh worker', { itemId: item.id, error: errorMessage(error) });
      }
    }
    if (workerId) await this.stopInstance(workerId);
    const run = this.host.getRun(item.runId);
    const resume = buildResumePrompt(this.promptContext(run, item), 'the previous worker session ended');
    await this.spawnWorker(item, `${resume}\n\n${prompt}`, null);
  }

  onWorkerOutcome(instanceId: string, outcome: PlanQueueTurnOutcome): Promise<void> {
    const role = this.host.roleOf(instanceId);
    if (role?.role !== 'worker') return Promise.resolve();
    return this.withItemLock(role.itemId, async () => {
      const item = this.host.getItem(role.itemId);
      // Only the item's current worker drives it; and a turn James started by
      // talking to an idle worker is not a work round.
      if (item.workerInstanceId !== instanceId) return;
      if (outcome.kind === 'failed') await this.stopInstance(instanceId);
      if (item.state !== 'working' && item.state !== 'fixing') return;
      if (outcome.kind === 'failed' && this.host.consumeUserClose?.(instanceId)) {
        await this.parkUnlocked(item, 'cancelled', 'Stopped: you closed its session. Resume carries on from the same branch.'); return;
      }
      if (this.host.getRun(item.runId).status === 'paused') { await this.holdUnlocked(item); return; }
      switch (outcome.kind) {
        case 'turn-complete':
          try {
            // What did this round's work, read before the checkpoint can yield, for its checker once the session is gone ('auto' only before startup resolves it).
            const live = this.host.instances.getInstance(instanceId);
            const ranOn = live?.provider && live.provider !== 'auto' ? { workerProvider: live.provider, workerModel: live.currentModel } : {};
            const checkpointed = await this.host.worktrees.checkpoint(item, `round ${item.round + 1} work`);
            this.host.transition(checkpointed, 'awaiting-slot', { question: null, detail: null, pendingInstruction: null, ...ranOn });
            this.host.requestPump();
          } catch (error) {
            if (error instanceof UnresolvedMergeError) {
              await this.parkUnlocked(this.host.getItem(item.id), 'merge-conflict', `The worker ended its turn with the merge still unresolved (${error.conflictFiles.join(', ')}).`);
            } else {
              await this.parkUnlocked(this.host.getItem(item.id), 'worktree-error', `Checkpoint failed: ${errorMessage(error)}`);
            }
          }
          return;
        case 'needs-input':
          this.askJamesForWorker(item, outcome.lastAssistantOutput);
          return;
        case 'provider-limit':
          await this.parkUnlocked(item, 'provider-limit', outcome.notice);
          return;
        case 'failed':
          if (this.host.consumeUserClose?.(instanceId)) await this.parkUnlocked(item, 'cancelled', 'Stopped: you closed its session. Resume carries on from the same branch.');
          else await this.parkUnlocked(item, 'worker-error', outcome.reason);
          return;
      }
    });
  }

  private askJamesForWorker(item: PlanQueueItem, lastAssistantOutput: string | null): void {
    const text = lastAssistantOutput?.trim() || 'The worker stopped and is waiting for input.';
    const saved = this.host.save({
      ...item,
      question: {
        question: text.slice(0, 2000),
        options: [
          { id: 'continue', label: 'Carry on using your best judgement' },
          { id: 'park', label: 'Stop and park this item' },
        ],
      },
    });
    this.host.notifyParent(
      this.host.getRun(saved.runId),
      `Plan Queue: the worker for ${documentStem(saved.documentPath)} is waiting for James.\n\n${text.slice(0, 1500)}\n\n`
        + `Ask James, then call plan_queue_answer with item_id "${saved.id}" and option_id "continue" or "park". James can also answer the worker directly in its session.`,
      [saved],
    );
  }

  /** James answered a worker's question from the panel or the parent session. */
  answerWorker(itemId: string, optionId: string): Promise<void> {
    return this.withItemLock(itemId, async () => {
      const item = this.host.getItem(itemId);
      if (!item.question || (item.state !== 'working' && item.state !== 'fixing')) return;
      if (optionId === 'park') {
        await this.parkUnlocked(item, 'cancelled', 'Parked at James\'s request while the worker waited for input.');
        return;
      }
      const cleared = this.host.save({ ...item, question: null });
      await this.runWorkerTurn(cleared, 'James says: carry on using your best judgement.');
    });
  }

  // Verification
  /** awaiting-slot → verifying. Synchronous first transition reserves the slot. */
  startVerification(waiting: PlanQueueItem): Promise<void> {
    this.host.transition(waiting, 'verifying', { verdict: null, landedCommit: null });
    return this.withItemLock(waiting.id, async () => {
      let item = this.host.getItem(waiting.id);
      if (item.state !== 'verifying' || item.verifierInstanceId) return;
      if (this.host.getRun(item.runId).status === 'paused') { await this.holdUnlocked(item); return; }
      const run = this.host.getRun(item.runId);
      const baseBranch = requireBaseBranch(run);
      if (!item.worktreePath || !existsSync(item.worktreePath)) {
        await this.parkUnlocked(item, 'worktree-error', 'The item worktree is missing; its work is on the branch.');
        return;
      }
      try {
        const sync = await syncItemWithBase(item, baseBranch);
        if (sync.status === 'conflict') {
          await this.toFixing(item, buildConflictPrompt(baseBranch, sync.conflictFiles),
            `Merging ${baseBranch} before verification conflicted (${sync.conflictFiles.join(', ')}); sent back to the worker.`);
          return;
        }
        if (sync.status === 'merged') item = await this.host.worktrees.checkpoint(item, `merge ${baseBranch}`);
      } catch (error) {
        await this.parkUnlocked(this.host.getItem(item.id), 'merge-conflict', `Keeping the branch current failed: ${errorMessage(error)}`);
        return;
      }

      await this.selectAndSpawnVerifier(item, baseBranch);
    });
  }

  private async selectAndSpawnVerifier(item: PlanQueueItem, baseBranch: string): Promise<void> {
    try {
      const { run, selection } = await selectCurrentQueueVerifier(this.host, item);
      if (!selection.ok) { await this.parkUnlocked(item, 'no-diverse-verifier', selection.reason); return; }
      await this.spawnVerifier(item, run, baseBranch, selection.choice);
    } catch (error) {
      if (error instanceof PlanQueueSpawnRunPaused) await this.holdUnlocked(this.host.getItem(item.id));
      else throw error;
    }
  }

  private async spawnVerifier(
    waiting: PlanQueueItem,
    run: PlanQueueRun,
    baseBranch: string,
    choice: Extract<VerifierSelection, { ok: true }>['choice'],
  ): Promise<void> {
    let item = waiting;
    try {
      const worktreePath = item.worktreePath!;
      this.snapshots.set(item.id, await snapshotTree(worktreePath));
      const mainTip = await gitExec(['rev-parse', `refs/heads/${baseBranch}`], run.workspaceCwd);
      item = this.host.save({ ...item, verifiedMainCommit: mainTip });
      const instance = await this.host.instances.createInstance({
        displayName: `Queue verifier · ${documentStem(item.documentPath)} (round ${item.round + 1})`,
        isRenamed: true,
        parentId: this.host.liveParentId(run),
        workingDirectory: worktreePath,
        initialPrompt: buildVerifierPrompt({
          item,
          kind: run.kind,
          repoRoot: run.workspaceCwd,
          worktreePath,
          baseBranch,
          gates: run.config.verifierGates,
        }),
        provider: choice.provider as InstanceProvider,
        ...(choice.modelOverride ? { modelOverride: choice.modelOverride } : {}),
        ...(choice.copilotProfileId ? { copilotAccountProfileId: choice.copilotProfileId } : {}),
        ...(choice.accountProfileIds?.length ? { allowedAccountProfileIds: choice.accountProfileIds } : {}),
        yoloMode: true,
        metadata: { planQueueRunId: run.id, planQueueItemId: item.id, planQueueRole: 'verifier', planQueueRouting: JSON.stringify(run.config.routing) },
      });
      this.host.registerRole(instance.id, { role: 'verifier', runId: run.id, itemId: item.id });
      this.host.save({ ...this.host.getItem(item.id), verifierInstanceId: instance.id, heldAt: null, detail: null });
      this.host.tracker.track(instance.id);
      instance.readyPromise?.catch((error: unknown) => {
        void this.onVerifierOutcome(instance.id, { kind: 'failed', reason: `verifier failed to start: ${errorMessage(error)}` });
      });
    } catch (error) {
      if (error instanceof PlanQueueSpawnRunPaused) {
        const current = this.host.getItem(item.id);
        await this.holdUnlocked(error.instanceId ? this.host.save({ ...current, verifierInstanceId: error.instanceId }) : current); return;
      }
      if (error instanceof PlanQueueSpawnRoutingChanged) { await this.selectAndSpawnVerifier(this.host.getItem(item.id), baseBranch); return; }
      if (error instanceof PlanQueueSpawnStoppedByUser) {
        if (error.instanceId) {
          item = this.host.save({ ...this.host.getItem(item.id), verifierInstanceId: error.instanceId });
          await this.stopInstance(error.instanceId);
        }
        const before = this.snapshots.get(item.id);
        if (before && item.worktreePath) await revertToSnapshot(item.worktreePath, before);
        else await restoreCheckpointAfterVerification(item);
      }
      this.snapshots.delete(item.id);
      if (error instanceof PlanQueueSpawnStoppedByUser) {
        this.host.transition(this.host.getItem(item.id), 'awaiting-slot', { verifierInstanceId: null, detail: 'Its checker was closed; it will be checked again.' });
      } else await this.erroredRound(this.host.getItem(item.id), `Could not start the verifier: ${errorMessage(error)}`);
    }
  }

  /** The verdict tool, already caller-checked by the coordinator. */
  recordVerdict(item: PlanQueueItem, verifierId: string, verdict: PlanQueueVerdict): void {
    this.pendingVerdicts.set(item.id, { verifierId, verdict });
  }

  onVerifierOutcome(instanceId: string, outcome: PlanQueueTurnOutcome): Promise<void> {
    const role = this.host.roleOf(instanceId);
    if (role?.role !== 'verifier') return Promise.resolve();
    return this.withItemLock(role.itemId, () => this.finishVerification(role.itemId, instanceId, outcome));
  }

  private async finishVerification(itemId: string, instanceId: string, outcome: PlanQueueTurnOutcome): Promise<void> {
    let item = this.host.getItem(itemId);
    if (item.state !== 'verifying' || item.verifierInstanceId !== instanceId) return;
    const hasVerdict = this.pendingVerdicts.get(itemId)?.verifierId === instanceId;
    if (await this.reminders.remind(item, instanceId, outcome, hasVerdict, this.snapshots.get(itemId))) return;
    // Keep ownership, verdict and snapshot until the checker can no longer write.
    // A rejected lock tail is settled, so a later hold must still find its ID.
    await this.stopInstance(instanceId);
    const reported = this.pendingVerdicts.get(itemId);
    this.pendingVerdicts.delete(itemId);
    const closedByUser = this.host.consumeUserClose?.(instanceId);
    if (!closedByUser && this.host.getRun(item.runId).status === 'paused') { await this.holdUnlocked(item); return; }
    item = this.host.save({ ...item, verifierInstanceId: null });

    const before = this.snapshots.get(item.id);
    this.snapshots.delete(item.id);
    let treeChanged = false;
    if (before && item.worktreePath) {
      try {
        if (!sameTree(before, await snapshotTree(item.worktreePath))) {
          treeChanged = true;
          await revertToSnapshot(item.worktreePath, before);
        }
      } catch (error) {
        await this.parkUnlocked(item, 'worktree-error', `Checking the worktree after verification failed: ${errorMessage(error)}`);
        return;
      }
    }

    const verdict = reported?.verifierId === instanceId ? reported.verdict : null;
    if (closedByUser) {
      this.host.transition(item, 'awaiting-slot', { detail: 'Its checker was closed; it will be checked again.' });
      this.host.requestPump();
      return;
    }
    if (outcome.kind !== 'turn-complete' || !verdict || treeChanged) {
      const reason = treeChanged
        ? 'the verifier changed the worktree, so its verdict was discarded and its changes reverted'
        : !verdict
          ? outcome.kind === 'failed'
            ? `the verifier failed: ${outcome.reason}`
            : 'the verifier ended its turn without reporting a verdict'
          : `the verifier stopped (${outcome.kind})`;
      await this.erroredRound(item, reason);
      return;
    }

    const round = item.round + 1;
    if (verdict.verdict === 'PASS') {
      const landing = this.host.transition(item, 'landing', { round, verdict, detail: null });
      void this.enqueueLanding(landing.id);
      return;
    }
    const run = this.host.getRun(item.runId);
    if (round >= run.config.maxRounds) {
      if (canStepUp(run, item)) {
        await stepUpItem({
          host: this.host,
          stopInstance: (id) => this.stopInstance(id),
          spawnWorker: (next, prompt) => this.spawnWorker(next, prompt, null),
          promptContext: (r, i) => this.promptContext(r, i),
        }, item, round, verdict);
        return;
      }
      const summary = verdict.findings.slice(0, 5).map((f) => `[${f.severity}, confidence ${f.confidence}] ${f.summary}`).join('; ');
      await this.parkUnlocked({ ...item, round, verdict }, 'round-limit', `Still failing after ${item.steppedUpAt ? 'the step-up worker\'s ' : ''}${round} verification round(s): ${summary || 'no findings listed'}`);
      return;
    }
    await this.toFixing(
      this.host.save({ ...item, round, verdict }),
      buildFixPrompt(round, run.config.maxRounds, verdict.findings),
    );
  }

  private async erroredRound(item: PlanQueueItem, reason: string): Promise<void> {
    const erroredRounds = item.erroredRounds + 1;
    if (erroredRounds >= MAX_ERRORED_ROUNDS) {
      await this.parkUnlocked({ ...item, erroredRounds }, 'verifier-unreliable', reason);
      return;
    }
    this.host.transition(item, 'awaiting-slot', { erroredRounds, detail: reason });
    this.host.requestPump();
  }

  /** Back to the worker; `detail` tells the panel why (it replaces any stale note). */
  private async toFixing(item: PlanQueueItem, prompt: string, detail: string | null = null): Promise<void> {
    const fixing = this.host.transition(item, 'fixing', { detail });
    await this.runWorkerTurn(fixing, prompt);
  }

  // Landing — serial, one at a time across every run
  /** Queue a landing. Never await this while holding the item's lock. */
  enqueueLanding(itemId: string, options: { operatorOverride?: boolean } = {}): Promise<void> {
    const previous = this.landingChain;
    this.landingChain = this.withItemLock(itemId, async () => { await previous; await this.landing.land(itemId, options); })
      .catch((error: unknown) => {
        logger.error('Plan queue landing recovery failed', error instanceof Error ? error : undefined, { itemId });
      });
    return this.landingChain;
  }

  // Parking and operator actions
  /** Operator Resume must wait for retained-checkout recovery and other writers. */
  resume(itemId: string): Promise<void> {
    return this.withItemLock(itemId, async () => {
      // `steppedUpAt` stays: a handed-over document resumes on the step-up choice and is never handed over twice.
      this.host.transition(this.host.getItem(itemId), 'queued', { parkReason: null, detail: null, heldAt: null, round: 0, erroredRounds: 0, landingRefusals: 0, question: null, landedCommit: null, verdict: null, verifiedMainCommit: null });
    });
  }

  /** Park from outside the flow (cancel, operator). Waits for any running operation. */
  park(itemId: string, reason: PlanQueueParkReason, detail: string): Promise<void> {
    return this.withItemLock(itemId, () => this.parkUnlocked(this.host.getItem(itemId), reason, detail));
  }

  /** Any non-terminal state → parked. Stops writers before checkpointing; never deletes the branch. */
  private async parkUnlocked(item: PlanQueueItem, reason: PlanQueueParkReason, detail: string, requireCheckpoint = false): Promise<void> {
    if (hasPendingLandingCleanup(item)) return this.landing.finishCleanup(item);
    if (item.state === 'landed' || item.state === 'parked' || item.state === 'skipped') return;
    const run = this.host.getRun(item.runId);
    const notes = [detail];
    await Promise.all([item.workerInstanceId, item.verifierInstanceId]
      .filter((id): id is string => Boolean(id)).map(id => this.stopInstance(id)));
    if (item.verifierInstanceId) {
      const before = this.snapshots.get(item.id);
      if (before && item.worktreePath) await revertToSnapshot(item.worktreePath, before);
      else await restoreCheckpointAfterVerification(item);
      this.snapshots.delete(item.id);
      this.pendingVerdicts.delete(item.id);
      item = this.host.save({ ...item, verifierInstanceId: null });
    }

    if (item.worktreePath && existsSync(item.worktreePath)) {
      try {
        item = await this.host.worktrees.checkpoint(item, `parked: ${reason}`);
        const removal = await this.host.worktrees.removeWithProof(item, run.workspaceCwd);
        if (removal.removed) item = this.host.getItem(item.id);
        else notes.push(`Worktree kept (${removal.reason}: ${removal.detail}).`);
      } catch (error) {
        if (requireCheckpoint) throw error;
        notes.push(error instanceof UnresolvedMergeError
          ? `Worktree kept with the merge of ${run.config.baseBranch ?? 'the base branch'} still in progress (unresolved: ${error.conflictFiles.join(', ')}); nothing was committed. Resume sends the conflict back to a worker.`
          : `Worktree kept: ${errorMessage(error)}.`);
      }
    } else if (item.worktreePath) {
      item = this.host.save({ ...item, worktreePath: null });
    }

    if (item.branchName && run.config.baseBranch && (await branchExists(run.workspaceCwd, item.branchName))) {
      const commitCount = await commitsAhead(run.workspaceCwd, run.config.baseBranch, item.branchName);
      if (commitCount > 0) {
        await appendParkedNote(item.documentPath, { branchName: item.branchName, reason, commitCount }).catch(() => undefined);
      }
    }

    this.host.transition(item, 'parked', { heldAt: null, parkReason: reason, detail: notes.join(' ').slice(0, 8000) });
    this.host.requestPump();
  }

  /** Explicit Discard: preserve an item-owned orphan copy before deleting its branch. */
  discard(itemId: string, actor = 'James'): Promise<void> {
    return this.withItemLock(itemId, async () => {
      let item = this.host.getItem(itemId);
      if (item.state !== 'parked') throw new Error('Only a parked item can be discarded');
      await Promise.all([item.workerInstanceId, item.verifierInstanceId].filter((id): id is string => Boolean(id)).map((id) => this.stopInstance(id)));
      if (item.worktreePath && await retainedQueuePathExists(item.worktreePath)) {
        item = await quarantineOrphanCheckout(item, this.host.getRun(item.runId).workspaceCwd, planQueueBranchName(item), (next) => { this.host.save(next); });
      }
      const cleared = item.worktreePath ? this.host.save({ ...item, worktreePath: null }) : item;
      if (cleared.branchName) {
        await this.host.worktrees.deleteBranchWithProof(cleared, this.host.getRun(item.runId).workspaceCwd, { discardRequested: true });
      }
      const current = this.host.getItem(itemId);
      const receipt = ` Discarded by ${actor}.`;
      this.host.save({ ...current, detail: `${(current.detail ?? '').slice(0, 8000 - receipt.length)}${receipt}`.trim() });
    });
  }

  /** parked → landing without a verifier PASS ("Land anyway"). Resolves once queued to land. */
  landAnyway(itemId: string): Promise<void> {
    return this.withItemLock(itemId, async () => {
      const item = this.host.getItem(itemId);
      if (item.state !== 'parked' || !item.branchName) throw new Error('Only a parked item with a branch can be landed');
      const run = this.host.getRun(item.runId);
      const reattached = await this.host.worktrees.reattach(item, run.workspaceCwd);
      this.host.transition(reattached, 'landing', { verifiedMainCommit: null, parkReason: null, detail: null });
      void this.enqueueLanding(itemId, { operatorOverride: true });
    });
  }

  /** Retry only a verified landing blockage; preserve its PASS, round and recorded commit. */
  retryLanding(itemId: string): Promise<void> {
    return this.withItemLock(itemId, async () => {
      const item = this.host.getItem(itemId);
      if (item.state !== 'parked' || item.parkReason !== 'land-blocked' || item.verdict?.verdict !== 'PASS' || !item.branchName) {
        throw new Error('Only a land-blocked parked item with a verifier PASS can retry landing');
      }
      const run = this.host.getRun(item.runId);
      const reattached = await this.host.worktrees.reattach(item, run.workspaceCwd);
      await removeParkedNote(reattached.documentPath, reattached.branchName!);
      this.host.transition(reattached, 'landing', { parkReason: null, detail: null });
      void this.enqueueLanding(itemId);
    });
  }

  // Instances
  /** Resolve the live parent; missing parents leave children at the rail's top. */
  liveParentId(run: PlanQueueRun): string | undefined {
    return this.host.resolveRunParent(run);
  }

  /** Stop tracking and terminate one queue instance. Its transcript is archived by termination. */
  retireInstance(instanceId: string): void {
    void this.stopInstance(instanceId).catch((error: unknown) => {
      logger.warn('Plan queue: terminating an instance failed', { instanceId, error: errorMessage(error) });
    });
  }

  /** Await termination before checkpointing or reverting a writer's worktree. */
  stopInstance(instanceId: string): Promise<void> {
    const pending = this.stopping.get(instanceId);
    if (pending) return pending;
    this.pendingRetirements.add(instanceId);
    this.reminders.forget(instanceId);
    this.host.tracker.untrack(instanceId);
    this.host.unregisterRole(instanceId);
    releaseReclaimHold(instanceId);
    const stopped = (this.host.instances.getInstance(instanceId)
      ? this.host.instances.terminateInstance(instanceId, true) : Promise.resolve())
      .then(() => { this.pendingRetirements.delete(instanceId); });
    this.stopping.set(instanceId, stopped);
    void stopped.finally(() => { this.stopping.delete(instanceId); }).catch(() => undefined);
    return stopped;
  }
}

function requireBaseBranch(run: PlanQueueRun): string {
  if (!run.config.baseBranch) throw new Error(`Plan queue run ${run.id} has no base branch`);
  return run.config.baseBranch;
}
