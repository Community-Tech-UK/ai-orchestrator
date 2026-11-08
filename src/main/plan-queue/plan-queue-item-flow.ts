import { spawnQueueChecker } from './plan-queue-checker-spawn';
import { PlanQueueVerification } from './plan-queue-verification';
import { PlanQueueGateRunner } from './plan-queue-gate-receipts';
import { PlanQueuePreparationErrors } from './plan-queue-error-class';
import { PlanQueueTurnRetries } from './plan-queue-turn-retry';
import { recycleQueueCopilotSession } from './plan-queue-session-recycle';
import { recordQueueRestart } from './plan-queue-restart-progress';
import { PARK_ON_REPEATED_FINDING, repeatedFindingIds } from './plan-queue-progress';
import { selectCurrentQueueVerifier } from './plan-queue-checker-routing';
import { holdItem, isHoldNote, parkAfterVerifierRestoreFailure, PlanQueueSpawnRunPaused, resumeReason, restoreVerifierTree, usageWaitNote } from './plan-queue-run-hold';
import { PlanQueueSpawnOutOfUsage } from './plan-queue-spawn';
import { PlanQueueUsageWaits, takeUsageHold } from './plan-queue-usage-wait';
import { recordItemTiming, recordSessionEnd, recordSessionStart, TIMING_REASONS } from './plan-queue-timings';
import { PlanQueueSpawnStoppedByUser } from './plan-queue-user-close';
/**
 * Plan Queue item flow — the side effects of each item transition: prepare a
 * worktree, run the worker, verify, land, park.
 *
 * Ordering rule throughout: the item row is written BEFORE the side effect it
 * authorises. Holds stop writers before checkpointing. The coordinator owns
 * scheduling (which item runs next) and routes instance outcomes here.
 */

import * as path from 'path';
import type { PlanQueueParkReason, PlanQueueVerdict } from '@contracts/schemas/plan-queue';
import type { InstanceProvider } from '../../shared/types/instance.types';
import { AUTOMATION_FAILURE_STATUSES } from '../../shared/types/instance-status-policy';
import { getLogger } from '../logging/logger';
import { holdFromReclaim, releaseReclaimHold } from '../process/reclaim-holds';
import { appendParkedBranchNote, removeParkedNote } from './plan-queue-doc-close';
import {
  branchExists,
  UnresolvedMergeError,
  unresolvedMergeFiles,
  revertToSnapshot,
  sameTree,
  snapshotTree,
  type TreeSnapshot,
} from './plan-queue-git';
import type { PlanQueueFlowHost } from './plan-queue-host';
import { relaxedSettingsFor } from './plan-queue-relaxation';
import { isStoppedByHarnessError, unreportedVerifierReason, type PlanQueueTurnOutcome } from './plan-queue-instance-tracker';
import { isNeverAutoRetried } from './plan-queue-park-policy';
import { findingKind, parkingForDeferrals, parkingForFailure, refuseInconsistentVerdict, refuseUnclosedPlanPass } from './plan-queue-deferred-checks';
import { hasPendingLandingCleanup, PlanQueueItemLanding, isAncestor, type PlanQueueLandingOptions } from './plan-queue-item-landing';
import type { LandAnywayApproval } from './plan-queue-land-anyway-authority';
import { PlanQueueLandingWaits } from './plan-queue-landing-wait';
import { isLandingWait } from './plan-queue-state';
import { startQueueVerification } from './plan-queue-start-verification';
import { hasCheckout, InvalidQueueCheckoutError, retainedQueuePathExists } from './plan-queue-orphan-checkout';
import { discardParkedItem, PlanQueueDiscardedRefs, restoreBeforeResume, restoreDiscardedWork } from './plan-queue-discard';
import { PlanQueueLandingRetries } from './plan-queue-landing-retries';
import { PlanQueueKeptFolders } from './plan-queue-kept-folders';
import { PlanQueueRunBreaker } from './plan-queue-run-breaker';
import { planQueueBranchName } from './plan-queue-worktree';
import { describePlanningMoves } from './plan-queue-planning-files';
import {
  buildContinuePrompt,
  buildFixPrompt,
  buildResumePrompt,
  buildWorkerPrompt,
} from './plan-queue-prompts';
import { canStepUp, stepUpItem } from './plan-queue-step-up';
import { PlanQueueWorkerSessions, askJamesForWorker } from './plan-queue-worker-sessions';
import { PlanQueueVerifierReminders } from './plan-queue-verifier-reminder';
import { PlanQueueWorkerReports } from './plan-queue-worker-report';
import type { VerifierSelection } from './plan-queue-verifier-select';
import type { PlanQueueItem, PlanQueueRun } from './plan-queue.types';

/** Event note kept when a parked item is landed without a PASS: who authorised it and which message, never the message text. */
export const LAND_ANYWAY_AUTHORISED = 'land-anyway-authorised';

const logger = getLogger('PlanQueueItemFlow');

/** Two verifier rounds that end without a usable verdict park the item. */
export const MAX_ERRORED_ROUNDS = 2;
const RECLAIM_HOLD_OWNER = 'plan-queue';
const CHECK_RETRY_MS = 60_000;

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
  private readonly workerReports: PlanQueueWorkerReports;
  /** Per-item operation chain: one side-effecting operation per item at a time. */
  private readonly locks = new Map<string, Promise<void>>();
  private readonly stopping = new Map<string, Promise<void>>();
  /** Failed stops retain ownership without retaining a rejected promise that would block retries. */
  private readonly pendingRetirements = new Set<string>();
  private readonly workerSessions: PlanQueueWorkerSessions;
  private readonly usageWaits: PlanQueueUsageWaits;
  private landingChain: Promise<void> = Promise.resolve();
  private readonly landing: PlanQueueItemLanding;
  private readonly landingWaits: PlanQueueLandingWaits;
  private readonly verification: PlanQueueVerification;
  private readonly preparationErrors: PlanQueuePreparationErrors;
  private readonly retries: PlanQueueTurnRetries;

  /** Folders an earlier park or landing had to keep; the scheduler retries them. */
  readonly keptFolders: PlanQueueKeptFolders;
  readonly discardedRefs: PlanQueueDiscardedRefs;
  readonly landingRetries: PlanQueueLandingRetries;
  /** Jobs running a Harness checklist now. Held in memory, so a restart starts with none. */
  readonly checklistTurns = new Set<string>();
  readonly breaker: PlanQueueRunBreaker;

  constructor(private readonly host: PlanQueueFlowHost) {
    this.usageWaits = new PlanQueueUsageWaits((id, kind, waitedMs) => recordItemTiming(host, id, TIMING_REASONS.usageWait, { kind, waitedMs }));
    this.verification = new PlanQueueVerification(host, new PlanQueueGateRunner(), {
      lock: (id, action) => this.withItemLock(id, action), waiting: id => this.isWaitingForUsage(id),
    });
    this.breaker = new PlanQueueRunBreaker(host);
    this.preparationErrors = new PlanQueuePreparationErrors(host, this.breaker);
    this.retries = new PlanQueueTurnRetries(host);
    this.keptFolders = new PlanQueueKeptFolders(host, (id, action) => this.withItemLock(id, action));
    this.discardedRefs = new PlanQueueDiscardedRefs(host, (id, action) => this.withItemLock(id, action));
    this.landingRetries = new PlanQueueLandingRetries(host, id => this.retryLanding(id, { automatic: true }));
    this.workerSessions = new PlanQueueWorkerSessions({
      host, lock: (id, action) => this.withItemLock(id, action),
      stop: (id) => this.stopInstance(id), spawn: (item, prompt) => this.spawnWorker(item, prompt, null),
      failed: (id, reason) => this.onWorkerOutcome(id, { kind: 'failed', reason }),
    });
    this.reminders = new PlanQueueVerifierReminders(host, (id, outcome) => void this.onVerifierOutcome(id, outcome).catch((error: unknown) => logger.warn('Plan queue: handling checker reminder failure failed', { instanceId: id, error: errorMessage(error) })));
    this.workerReports = new PlanQueueWorkerReports(host, (id, outcome) => void this.onWorkerOutcome(id, outcome).catch((error: unknown) => logger.warn('Plan queue: handling worker reminder failure failed', { instanceId: id, error: errorMessage(error) })));
    this.landingWaits = new PlanQueueLandingWaits({
      host, lock: (id, action) => this.withItemLock(id, action), enqueueLanding: (id) => this.enqueueLanding(id),
      park: (item, reason, detail) => this.parkUnlocked(item, reason, detail),
    });
    this.landing = new PlanQueueItemLanding({
      host, waits: this.landingWaits,
      toFixing: (item, prompt, detail) => this.toFixing(item, prompt, detail),
      park: (item, reason, detail, requireCheckpoint) => this.parkUnlocked(item, reason, detail, requireCheckpoint),
      stopInstance: (id) => this.stopInstance(id),
    });
  }

  /** Runtime ownership, including teardown; persisted instance IDs may be historical. */
  cancelChecks(): void { this.verification.cancelAll(); this.retries.cancelAll(); }

  hasActiveWork(itemId: string): boolean {
    const item = this.host.getItem(itemId);
    // A landing that waits for the root checkout to clear runs nothing, so it is not work.
    return this.locks.has(itemId) || hasPendingLandingCleanup(item) || ['preparing', 'working', 'fixing', 'verifying'].includes(item.state) || (item.state === 'landing' && !isLandingWait(item))
      || [item.workerInstanceId, item.verifierInstanceId].some(id => !!id
        && (this.stopping.has(id) || (this.pendingRetirements.has(id) && this.host.instances.getInstance(id) !== undefined)
          || this.host.tracker.isTracked(id) || this.host.roleOf(id) !== undefined));
  }

  /** The scheduler's retry. A cleanup already under way is left to finish. */
  finishLandingCleanup(itemId: string): Promise<void> {
    return this.locks.has(itemId) ? Promise.resolve() : this.withItemLock(itemId, () => this.landing.retryCleanup(itemId));
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

  /** True while an item waits for usage to come back on its route; the scheduler skips it. */
  isWaitingForUsage(itemId: string): boolean { return this.usageWaits.isWaiting(itemId) || this.preparationErrors.waiting(this.host.getItem(itemId)); }

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
        const checkout = await (resuming ? this.host.worktrees.reattach(item, run.workspaceCwd) : this.host.worktrees.prepare(item, run.workspaceCwd));
        item = await this.workerSessions.withLivetestPort(checkout, run);
      } catch (error) {
        if (this.preparationErrors.defer(this.host.getItem(item.id), error)) return;
        await this.parkUnlocked(this.host.getItem(item.id), 'worktree-error', `Could not prepare the worktree: ${errorMessage(error)}`);
        this.preparationErrors.failed(item, error);
        return;
      }
      const ctx = this.workerSessions.promptContext(run, item);
      try { await this.verification.pin(item); }
      catch (error) { await this.parkUnlocked(item, 'missing-document', errorMessage(error)); return; }
      const prompt = resuming
        ? buildResumePrompt(ctx, resumeReason(item)) + (await this.workerSessions.conflictAddendum(item, run))
        : buildWorkerPrompt(ctx);
      await this.spawnWorker(item, prompt, 'working', resuming ? buildContinuePrompt(ctx, resumeReason(item)) + (await this.workerSessions.conflictAddendum(item, run)) : undefined);
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
        if (item.worktreePath && await hasCheckout(item.worktreePath)) {
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
        item = await this.workerSessions.withLivetestPort(item, run, true);
      } catch (error) {
        if (this.preparationErrors.defer(this.host.getItem(item.id), error)) return;
        await this.parkUnlocked(this.host.getItem(item.id), 'worktree-error', `Could not recover the worktree: ${errorMessage(error)}`);
        this.preparationErrors.failed(item, error);
        return;
      }
      if (await recordQueueRestart(this.host, item) >= 3) {
        await this.parkUnlocked(item, 'restart-loop', 'Restarted 3 times without progress. Check the saved work, then Resume.'); return;
      }
      const prompt = buildResumePrompt(this.workerSessions.promptContext(run, item), 'the app restarted') + (await this.workerSessions.conflictAddendum(item, run));
      await this.spawnWorker(item, prompt, item.state === 'preparing' ? 'working' : null, buildContinuePrompt(this.workerSessions.promptContext(run, item), 'the app restarted') + (await this.workerSessions.conflictAddendum(item, run)));
    });
  }

  /**
   * `stillHeld`, when given, is a targeted hold (a rule change, not Pause): it does
   * not abort a landing in flight, and it is checked again under the item lock, so
   * a hold that waited behind another change does nothing if the item has moved on.
   */
  hold(itemId: string, reason = 'Paused', stillHeld?: (item: PlanQueueItem) => boolean): Promise<void> {
    this.retries.cancel(itemId);
    if (!stillHeld) this.verification.cancel(itemId);
    if (!stillHeld) this.landing.cancel(itemId);
    return this.withItemLock(itemId, async () => {
      // Under the lock, so a usage wait recorded by a spawn still in flight is cleared too.
      this.usageWaits.clear(itemId);
      const item = this.host.getItem(itemId);
      if (stillHeld && !stillHeld(item)) return;
      await this.holdUnlocked(item, reason);
    });
  }

  private async holdUnlocked(item: PlanQueueItem, reason = 'Paused'): Promise<void> {
    // A waiting landing has nothing to stop and keeps its wait through Pause.
    if (item.state === 'landing' && !isLandingWait(item)) { await this.landing.land(item.id, {}); item = this.host.getItem(item.id); }
    if (hasPendingLandingCleanup(item)) return this.landing.finishCleanup(item);
    if (item.workerInstanceId) { this.workerSessions.record(item.id, item.workerInstanceId); item = this.host.getItem(item.id); }
    await holdItem(this.host, item, (id) => this.stopInstance(id), async (checking) => {
      try { await restoreVerifierTree(checking, this.host.getRun(checking.runId).workspaceCwd, this.snapshots.get(checking.id)); }
      catch (error) {
        if (error instanceof InvalidQueueCheckoutError) { this.snapshots.delete(checking.id); this.pendingVerdicts.delete(checking.id); }
        throw error;
      }
      this.snapshots.delete(checking.id); this.pendingVerdicts.delete(checking.id);
    }, reason); this.verification.forgetCheck(item.id);
  }

  private async spawnWorker(
    item: PlanQueueItem,
    prompt: string,
    nextState: 'working' | 'fixing' | null,
    continuePrompt?: string,
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
        metadata: { planQueueRunId: run.id, planQueueItemId: item.id, planQueueRole: 'worker', planQueueRound: item.round, ...(continuePrompt ? { planQueueContinuePrompt: continuePrompt } : {}), ...(item.steppedUpAt ? { planQueueSteppedUp: true } : {}) },
      });
      this.host.registerRole(instance.id, { role: 'worker', runId: run.id, itemId: item.id });
      const started = this.host.instances.getInstance(instance.id);
      recordSessionStart(this.host, item.id, 'worker', instance.id, started?.provider ?? run.workerProvider, started?.currentModel ?? run.workerModel);
      holdFromReclaim(instance.id, RECLAIM_HOLD_OWNER);
      const relaxed = relaxedSettingsFor(run);
      if (relaxed.length) {
        // Holder and sharing runs alike: the audit line is per worker spawn.
        logger.info('Plan queue worker runs under relaxed settings', { itemId: item.id, runId: run.id, settings: relaxed });
      }
      const current = this.host.getItem(item.id);
      const patch = { workerInstanceId: instance.id, question: null, heldAt: null, pendingInstruction: null, workerReport: null,
        detail: isHoldNote(current.detail) || /^(?:Waiting for a free work folder|Waiting for the provider or machine)/.test(current.detail ?? '') ? null : current.detail };
      if (nextState && current.state !== nextState) this.host.transition(current, nextState, patch);
      else this.host.save({ ...current, ...patch });
      this.workerSessions.watch(instance, item, prompt);
      this.preparationErrors.succeeded(run.id, item.id);
    } catch (error) {
      if (error instanceof PlanQueueSpawnRunPaused) {
        const current = this.host.getItem(item.id);
        await this.holdUnlocked(error.instanceId ? this.host.save({ ...current, workerInstanceId: error.instanceId }) : current); return;
      }
      if (error instanceof PlanQueueSpawnOutOfUsage) {
        // Never parked and never a round: the worker would only hit its limit and fail.
        await this.holdUnlocked(this.host.getItem(item.id), usageWaitNote(error.message));
        this.usageWaits.start(item.id, error, 'worker');
        return;
      }
      if (error instanceof PlanQueueSpawnStoppedByUser && error.instanceId) {
        this.host.save({ ...this.host.getItem(item.id), workerInstanceId: error.instanceId });
        await this.stopInstance(error.instanceId);
      }
      if (!(error instanceof PlanQueueSpawnStoppedByUser) && this.preparationErrors.defer(this.host.getItem(item.id), error)) return;
      await this.parkUnlocked(this.host.getItem(item.id), error instanceof PlanQueueSpawnStoppedByUser ? 'cancelled' : 'worker-error', error instanceof PlanQueueSpawnStoppedByUser ? 'Stopped: you closed its session. Resume carries on from the same branch.' : `Could not start the worker: ${errorMessage(error)}`);
      if (!(error instanceof PlanQueueSpawnStoppedByUser)) this.preparationErrors.failed(item, error);
    }
  }

  /** Send the worker its next turn, respawning it with a resume prompt if its session is gone. */
  private async runWorkerTurn(item: PlanQueueItem, prompt: string): Promise<void> {
    item = this.host.save({ ...item, pendingInstruction: prompt, workerReport: null });
    if (this.host.getRun(item.runId).status === 'paused') { await this.holdUnlocked(item); return; }
    const workerId = item.workerInstanceId;
    const worker = workerId ? this.host.instances.getInstance(workerId) : undefined;
    if (workerId && worker && !AUTOMATION_FAILURE_STATUSES.has(worker.status)) {
      try {
        if (await recycleQueueCopilotSession(this.host.instances, worker, () => this.host.tracker.untrack(workerId))) {
          this.workerSessions.record(item.id, workerId);
          prompt = buildResumePrompt(this.workerSessions.promptContext(this.host.getRun(item.runId), item), 'Copilot compaction left its context above 90%') + '\n\n' + prompt;
        }
      } catch (error) {
        await this.parkUnlocked(item, 'worker-error', `Could not refresh Copilot context: ${errorMessage(error)}`); return;
      }
      if (this.host.getRun(item.runId).status === 'paused') { await this.holdUnlocked(this.host.getItem(item.id)); return; }
      this.host.registerRole(workerId, { role: 'worker', runId: item.runId, itemId: item.id });
      this.host.tracker.beginTurn(workerId);
      this.workerReports.beginTurn(workerId);
      worker.metadata = { ...worker.metadata, planQueueRound: item.round };
      try {
        await this.host.instances.sendInput(workerId, prompt, undefined, { automatedInput: true, internalSource: 'plan-queue' });
        this.host.save({ ...this.host.getItem(item.id), pendingInstruction: null });
        return;
      } catch (error) {
        if (isStoppedByHarnessError(error)) return;
        logger.warn('Plan queue: worker send failed; starting a fresh worker', { itemId: item.id, error: errorMessage(error) });
      }
    }
    if (workerId) { this.workerSessions.record(item.id, workerId); await this.stopInstance(workerId); item = this.host.getItem(item.id); }
    const run = this.host.getRun(item.runId);
    const resume = buildResumePrompt(this.workerSessions.promptContext(run, item), 'the previous worker session ended');
    await this.spawnWorker(item, resume, null, buildContinuePrompt(this.workerSessions.promptContext(run, item), 'the previous worker session ended'));
  }

  onWorkerOutcome(instanceId: string, outcome: PlanQueueTurnOutcome): Promise<void> {
    const reopening = outcome.kind === 'failed' && this.workerSessions.isReopening(instanceId);
    const closedDuringReopen = reopening && this.host.consumeUserClose?.(instanceId);
    if (reopening && !closedDuringReopen && outcome.kind === 'failed') {
      this.workerSessions.rememberFailure(instanceId, outcome.reason);
      return Promise.resolve();
    }
    const role = this.host.roleOf(instanceId);
    if (role?.role !== 'worker') return Promise.resolve();
    this.workerSessions.record(role.itemId, instanceId);
    return this.withItemLock(role.itemId, async () => {
      const item = this.host.getItem(role.itemId);
      // Only the item's current worker drives it; and a turn James started by
      // talking to an idle worker is not a work round.
      if (item.workerInstanceId !== instanceId) return;
      if (item.state !== 'working' && item.state !== 'fixing') return;
      if (outcome.kind === 'failed' && (closedDuringReopen || this.host.consumeUserClose?.(instanceId))) {
        await this.parkUnlocked(item, 'cancelled', 'Stopped: you closed its session. Resume carries on from the same branch.'); return;
      }
      if (this.host.getRun(item.runId).status === 'paused') { await this.holdUnlocked(item); return; }
      if (outcome.kind === 'turn-complete') {
        // A turn that ended without its report is reminded; once the reminders are spent it is a failed turn.
        const gate = this.workerReports.afterTurn(item, instanceId);
        if (gate === 'reminded') return;
        if (gate !== 'ok') outcome = { kind: 'failed', reason: gate.failed };
      }
      if (outcome.kind === 'failed' && await this.retries.retry(item, instanceId, outcome.reason)) return;
      if (outcome.kind === 'failed') await this.stopInstance(instanceId);
      switch (outcome.kind) {
        case 'turn-complete':
          this.retries.completed(instanceId);
          try {
            // What did this round's work, read before the session closes, for its checker ('auto' only before startup resolves it).
            const live = this.host.instances.getInstance(instanceId);
            this.verification.rememberWorkerClaim(item, live?.outputBuffer.filter(message => message.type === 'assistant').at(-1)?.content ?? '');
            const ranOn = live?.provider && live.provider !== 'auto' ? { workerProvider: live.provider, workerModel: live.currentModel } : {};
            const closed = await this.workerSessions.closeIfSaved(item, instanceId);
            if (closed === null) return;
            const checkpointed = await this.host.worktrees.checkpoint(item, `round ${item.round + 1} work`);
            this.host.transition(checkpointed, 'awaiting-slot', { question: null, detail: null, pendingInstruction: null, ...ranOn, ...(closed ? { workerInstanceId: null } : {}) });
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
          askJamesForWorker(this.host, item, outcome.lastAssistantOutput);
          return;
        case 'provider-limit': {
          // A usage limit passes, so the item waits for usage like a worker that could not start. The history is
          // persisted: a limit the usage data does not track would otherwise loop here with nobody told.
          const waitMs = takeUsageHold(this.host.history, item, 'queued');
          if (waitMs === null) { await this.parkUnlocked(item, 'provider-limit', outcome.notice); return; }
          const waiting = new PlanQueueSpawnOutOfUsage(null, "this worker's provider");
          this.usageWaits.start(item.id, waiting, 'worker', waitMs);
          await this.holdUnlocked(item, usageWaitNote(waiting.message));
          return;
        }
        case 'stopped-by-harness':
          await this.parkUnlocked(item, 'stopped-by-harness', outcome.notice);
          return;
        case 'failed':
          if (this.host.consumeUserClose?.(instanceId)) await this.parkUnlocked(item, 'cancelled', 'Stopped: you closed its session. Resume carries on from the same branch.');
          else { await this.parkUnlocked(item, 'worker-error', outcome.reason); this.breaker.note(item.runId, item.id, outcome.reason); }
          return;
      }
    });
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
  isClaimed(itemId: string): boolean { return this.verification.groups.isClaimed(itemId); }
  private releaseChecklistTurn(itemId: string): void { if (this.checklistTurns.delete(itemId)) this.host.requestPump(); }

  /** awaiting-slot → verifying. The slot and turn are taken synchronously, because the pump starts several checks in one pass. */
  startVerification(waiting: PlanQueueItem): Promise<void> {
    const run = this.host.getRun(waiting.runId);
    if (run.config.verifierGates.length) this.checklistTurns.add(waiting.id);
    const finished = (): void => { this.releaseChecklistTurn(waiting.id); this.verification.groups.release(waiting.id); };
    try {
      this.verification.groups.reserve(waiting, run);
      this.host.transition(waiting, 'verifying', { verdict: null, landedCommit: null });
    } catch (error) { this.checklistTurns.delete(waiting.id); this.verification.groups.release(waiting.id); throw error; }
    return this.withItemLock(waiting.id, () => startQueueVerification({
      host: this.host, verification: this.verification, hold: item => this.holdUnlocked(item),
      park: (item, reason, detail) => this.parkUnlocked(item, reason, detail),
      fix: (item, prompt, detail) => this.toFixing(item, prompt, detail),
      spawn: (item, base) => this.selectAndSpawnVerifier(item, base),
      checksFinished: ran => { this.releaseChecklistTurn(waiting.id); if (ran) this.breaker.succeeded(waiting.runId, waiting.id); },
      checksFailed: message => { this.breaker.note(waiting.runId, waiting.id, message); this.preparationErrors.holdOff(waiting.id, CHECK_RETRY_MS); },
    }, waiting.id)).finally(finished);
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

  private spawnVerifier(item: PlanQueueItem, run: PlanQueueRun, baseBranch: string,
    choice: Extract<VerifierSelection, { ok: true }>['choice']): Promise<void> {
    return spawnQueueChecker({ host: this.host, snapshots: this.snapshots, usageWaits: this.usageWaits,
      checkedBase: id => this.verification.checkedBase(id),
      prompt: (current, currentRun, base) => this.verification.prompt(current, currentRun, base),
      hold: current => this.holdUnlocked(current), select: (current, base) => this.selectAndSpawnVerifier(current, base),
      stop: id => this.stopInstance(id), forgetCheck: id => this.verification.forgetCheck(id), erroredRound: (current, reason) => this.erroredRound(current, reason),
      onVerifierOutcome: (id, outcome) => this.onVerifierOutcome(id, outcome),
    }, item, run, baseBranch, choice);
  }

  /** The verdict tool, already caller-checked by the coordinator. */
  recordVerdict(item: PlanQueueItem, verifierId: string, verdict: PlanQueueVerdict): void {
    refuseInconsistentVerdict(verdict);
    refuseUnclosedPlanPass(this.host.getRun(item.runId).kind, verdict);
    this.pendingVerdicts.set(item.id, { verifierId, verdict: { ...verdict, findings: verdict.findings.map(finding => ({ ...finding, kind: findingKind(finding) })) } });
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
    let treeChanged = false;
    if (before && item.worktreePath) {
      try {
        if (!sameTree(before, await snapshotTree(item.worktreePath))) {
          treeChanged = true;
          await revertToSnapshot(item.worktreePath, before, this.host.getRun(item.runId).workspaceCwd, item.branchName!);
        }
      } catch (error) {
        if (item.workerInstanceId) await this.stopInstance(item.workerInstanceId);
        parkAfterVerifierRestoreFailure(this.host, item, error, 'Checking the work folder after verification failed.');
        this.snapshots.delete(item.id); this.verification.forgetCheck(item.id);
        return;
      }
    }
    this.snapshots.delete(item.id);

    let verdict = reported?.verifierId === instanceId ? reported.verdict : null;
    if (closedByUser) {
      this.host.transition(item, 'awaiting-slot', { detail: 'Its checker was closed; it will be checked again.' }); this.verification.forgetCheck(item.id);
      this.host.requestPump();
      return;
    }
    if (outcome.kind === 'provider-limit' && !verdict && !treeChanged) {
      // A checker at its usage limit judged nothing, so this is a wait, not an errored round.
      const waiting = new PlanQueueSpawnOutOfUsage(null, "this checker's provider");
      const waitMs = takeUsageHold(this.host.history, item, 'awaiting-slot');
      this.verification.forgetCheck(item.id);
      if (waitMs === null) { await this.parkUnlocked(item, 'provider-limit', outcome.notice); return; }
      this.host.transition(item, 'awaiting-slot', { detail: usageWaitNote(waiting.message) });
      this.usageWaits.start(item.id, waiting, 'check', waitMs);
      return;
    }
    if (outcome.kind === 'stopped-by-harness') { await this.parkUnlocked(item, 'stopped-by-harness', outcome.notice); return; }
    if (outcome.kind !== 'turn-complete' || !verdict || treeChanged) {
      const reason = treeChanged
        ? 'the verifier changed the worktree, so its verdict was discarded and its changes reverted'
        : !verdict
          ? unreportedVerifierReason(outcome)
          : `the verifier stopped (${outcome.kind})`;
      await this.erroredRound(item, reason);
      return;
    }

    verdict = await this.verification.record(item, verdict);
    const round = item.round + 1;
    // Nothing a worker can fix (setup or a human's answer), or too much left for live checks: set aside, no new worker round.
    const notCode = parkingForFailure(verdict) ?? parkingForDeferrals(verdict);
    if (notCode) { await this.parkUnlocked({ ...item, round, verdict }, notCode.reason, notCode.detail); return; }
    if (PARK_ON_REPEATED_FINDING && repeatedFindingIds(this.host.history.listVerdicts(item.id)).thrice.size) {
      await this.parkUnlocked({ ...item, round, verdict }, 'stuck-on-same-finding', 'The same finding failed in three rounds. Reproduce it before another fix.'); return;
    }
    if (verdict.verdict === 'PASS') {
      const landing = this.host.transition(item, 'landing', { round, verdict, detail: null });
      void this.enqueueLanding(landing.id);
      return;
    }
    const run = this.host.getRun(item.runId);
    if (round >= run.config.maxRounds) {
      if (canStepUp(run, item, verdict)) {
        await stepUpItem({
          host: this.host,
          stopInstance: (id) => this.stopInstance(id),
          spawnWorker: (next, prompt) => this.spawnWorker(next, prompt, null),
          promptContext: (r, i) => this.workerSessions.promptContext(r, i),
        }, item, round, verdict);
        return;
      }
      const summary = verdict.findings.slice(0, 5).map((f) => `[${f.severity}, confidence ${f.confidence}] ${f.summary}`).join('; ');
      await this.parkUnlocked({ ...item, round, verdict }, 'round-limit', `Still failing after ${item.steppedUpAt ? 'the step-up worker\'s ' : ''}${round} verification round(s): ${summary || 'no findings listed'}`);
      return;
    }
    await this.toFixing(
      this.host.save({ ...item, round, verdict }),
      buildFixPrompt(round, run.config.maxRounds, verdict.findings, await describePlanningMoves(run.workspaceCwd, item.id)) + this.verification.stepBack(item),
    );
  }

  private async erroredRound(item: PlanQueueItem, reason: string): Promise<void> {
    const erroredRounds = item.erroredRounds + 1; this.verification.forgetCheck(item.id);
    if (erroredRounds >= MAX_ERRORED_ROUNDS) {
      await this.parkUnlocked({ ...item, erroredRounds }, 'verifier-unreliable', reason);
      this.breaker.note(item.runId, item.id, reason);
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

  /** Land a waiting item whose paths have cleared, or park it after 24 hours. Never awaits a landing. */
  recheckLandingWait(itemId: string): Promise<void> { return this.landingWaits.recheck(itemId); }

  // Landing — serial, one at a time across every run
  /** Queue a landing. Never await this while holding the item's lock. */
  enqueueLanding(itemId: string, options: PlanQueueLandingOptions = {}): Promise<void> {
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
      this.usageWaits.clear(itemId);
      const item = this.host.getItem(itemId);
      await Promise.all([item.workerInstanceId, item.verifierInstanceId].filter((id): id is string => Boolean(id)).map(id => this.stopInstance(id)));
      this.preparationErrors.succeeded(item.runId, item.id);
      await restoreBeforeResume(this.host, itemId);
      // A checker must not review the note: its hash would go into the closed documents, and a later retry takes the note off.
      const resumed = this.host.getItem(itemId);
      if (resumed.checkpointCommit) this.verification.forgetResults(resumed.checkpointCommit);
      // Unless another attempt is being checked or landing: its review holds these bytes, note and all.
      if (resumed.branchName && !this.host.store.documentBeingChecked(resumed.documentPath, resumed.id)) {
        // A document that can't safely be edited keeps its note, as it always did; the Resume still goes ahead.
        const change = await removeParkedNote(resumed.documentPath, resumed.branchName).catch((error: unknown) => {
          logger.warn('Plan queue: the parked note stayed in the document', { itemId, error: errorMessage(error) });
          return undefined;
        });
        this.host.history.recordDocumentTransformation(resumed, change);
      }
      // `steppedUpAt` stays: a handed-over document resumes on the step-up choice and is never handed over twice.
      this.host.transition(this.host.getItem(itemId), 'queued', { parkReason: null, detail: null, heldAt: null, discardedAt: null, discardedBy: null, round: 0, erroredRounds: 0, landingRefusals: 0, baseConflicts: 0, question: null, landedCommit: null, verdict: null, verifiedMainCommit: null, pendingInstruction: this.workerSessions.carryOverForResume(itemId) });
    });
  }

  /** Park from outside the flow (cancel, operator). Waits for any running operation. */
  park(itemId: string, reason: PlanQueueParkReason, detail: string): Promise<void> {
    this.retries.cancel(itemId);
    this.verification.cancel(itemId);
    return this.withItemLock(itemId, () => this.parkUnlocked(this.host.getItem(itemId), reason, detail));
  }

  /** Any non-terminal state → parked. Stops writers before checkpointing; never deletes the branch. */
  private async parkUnlocked(item: PlanQueueItem, reason: PlanQueueParkReason, detail: string, requireCheckpoint = false): Promise<void> {
    if (hasPendingLandingCleanup(item)) return this.landing.finishCleanup(item);
    if (item.state === 'landed' || item.state === 'parked' || item.state === 'skipped') return;
    // A stop Harness chose is recorded first, so a restart during the slower steps below parks the job instead of restarting its work.
    if (isNeverAutoRetried(reason)) item = this.host.save({ ...item, parkReason: reason, detail });
    const run = this.host.getRun(item.runId);
    const notes = [detail];
    await Promise.all([item.workerInstanceId, item.verifierInstanceId]
      .filter((id): id is string => Boolean(id)).map(id => this.stopInstance(id)));
    this.verification.forgetCheck(item.id);
    if (item.verifierInstanceId) {
      try { await restoreVerifierTree(item, run.workspaceCwd, this.snapshots.get(item.id)); }
      catch (error) { parkAfterVerifierRestoreFailure(this.host, item, error, detail); return; }
      finally { this.snapshots.delete(item.id); this.pendingVerdicts.delete(item.id); }
      item = this.host.save({ ...item, verifierInstanceId: null });
    }

    if (item.worktreePath && await hasCheckout(item.worktreePath)) {
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
      if (await retainedQueuePathExists(item.worktreePath)) notes.push(`Its folder ${item.worktreePath} held no checkout and was left in place.`);
      item = this.host.save({ ...item, worktreePath: null });
    }

    const noteFailure = await appendParkedBranchNote(item, run, reason, this.host.history);
    if (noteFailure) notes.push(noteFailure);

    this.host.transition(item, 'parked', { heldAt: null, parkReason: reason, detail: notes.join(' ').slice(0, 8000) });
    this.preparationErrors.forget(item.id);
    this.host.requestPump();
  }

  /** Explicit Discard: stop the job's sessions, then clear it away; see plan-queue-discard.ts. */
  discard(itemId: string, actor = 'James'): Promise<void> {
    return this.withItemLock(itemId, async () => {
      const item = this.host.getItem(itemId);
      if (item.state !== 'parked') throw new Error('Only a parked item can be discarded');
      await Promise.all([item.workerInstanceId, item.verifierInstanceId].filter((id): id is string => Boolean(id)).map((id) => this.stopInstance(id)));
      await discardParkedItem(this.host, item, actor);
    });
  }

  /** Undo a Discard while its reference is kept. */
  restoreDiscarded(itemId: string): Promise<void> {
    return this.withItemLock(itemId, () => restoreDiscardedWork(this.host, itemId));
  }

  /**
   * parked → landing without a verifier PASS ("Land anyway"). Resolves once queued to land.
   * The caller has already been authorised (`plan-queue-land-anyway-authority.ts`); the queue's event record keeps who, and which message.
   */
  landAnyway(itemId: string, approval: LandAnywayApproval): Promise<void> {
    return this.withItemLock(itemId, async () => {
      const item = this.host.getItem(itemId);
      if (item.state !== 'parked' || !item.branchName) throw new Error('Only a parked item with a branch can be landed');
      const run = this.host.getRun(item.runId);
      const reattached = await this.host.worktrees.reattach(item, run.workspaceCwd);
      this.host.history.recordEvent({ itemId: item.id, runId: item.runId, fromState: item.state, toState: item.state,
        reason: LAND_ANYWAY_AUTHORISED, detailHead: JSON.stringify(approval.reference), round: item.round, tokens: 0 });
      this.host.transition(reattached, 'landing', { verifiedMainCommit: null, parkReason: null, detail: null });
      void this.enqueueLanding(itemId, { landAnywayBy: approval.by });
    });
  }

  /** Retry only a verified landing blockage; preserve its PASS and round. `automatic`: Harness's own retry (step 3.2). */
  retryLanding(itemId: string, options: { automatic?: boolean } = {}): Promise<void> {
    return this.withItemLock(itemId, async () => {
      const item = this.host.getItem(itemId);
      const blocked = item.parkReason === 'land-blocked' || (options.automatic === true && item.parkReason === 'merge-conflict');
      if (item.state !== 'parked' || !blocked || item.verdict?.verdict !== 'PASS' || !item.branchName) {
        throw new Error('Only a land-blocked parked item with a verifier PASS can retry landing');
      }
      const run = this.host.getRun(item.runId);
      const reattached = await this.host.worktrees.reattach(item, run.workspaceCwd);
      const change = await removeParkedNote(reattached.documentPath, reattached.branchName!);
      this.host.history.recordDocumentTransformation(reattached, change);
      // A commit not yet on the base carries the document as it was before the note, which no longer matches: build it again.
      const stale = change && reattached.landedCommit
        && !await isAncestor(reattached.landedCommit, `refs/heads/${run.config.baseBranch}`, run.workspaceCwd);
      this.host.transition(reattached, 'landing', { parkReason: null, detail: null, landingAutomatic: options.automatic === true,
        ...(stale ? { landedCommit: null } : {}) });
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
    this.workerSessions.forget(instanceId);
    this.retries.completed(instanceId);
    recordSessionEnd(this.host, instanceId);
    this.pendingRetirements.add(instanceId);
    this.reminders.forget(instanceId);
    this.workerReports.forget(instanceId);
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
