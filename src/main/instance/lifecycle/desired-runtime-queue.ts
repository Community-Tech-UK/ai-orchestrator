/**
 * Desired-runtime queue.
 *
 * Runtime changes (model/provider) respawn the session, which the status gate
 * refuses mid-turn. Before this queue, a change requested while the instance
 * was busy simply threw — the picker either disabled itself or the error was
 * swallowed, which is the main reason model swapping felt broken.
 *
 * This helper parks a change requested while busy in
 * {@link Instance.desiredRuntime} and lets the RuntimeReconciler apply it the
 * moment the instance transitions into an input-waiting status. It replaced
 * the bespoke `pendingYoloMode`/`YoloModeQueue` pattern — yolo flips ride the
 * same queue (`DesiredRuntime.yoloMode`) since the 2026-07-17 migration.
 */

import { getLogger } from '../../logging/logger';
import { generateId } from '../../../shared/utils/id-generator';
import { getModelSwitchUnavailableReason, isModelSwitchAllowedStatus } from '../../../shared/types/instance-status-policy';
import { computeRuntimeDiff } from './runtime-reconciler-plan';
import { isAdapterOnLoanError } from './adapter-loan-registry';
import type { DesiredRuntime } from './runtime-reconciler.types';
import type { Instance, OutputMessage } from '../../../shared/types/instance.types';

const logger = getLogger('DesiredRuntimeQueue');

interface AccountChangeCompletion {
  promise: Promise<Instance>;
  resolve(instance: Instance): void;
  reject(error: unknown): void;
}

interface ActiveRuntimeChange {
  superseded: boolean;
  boundaryObserved: boolean;
  unavailableReason?: string;
  yoloCleanup?: { desired: DesiredRuntime; yoloMode: boolean };
}

function cannotContinue(instance: Instance): boolean {
  return instance.status === 'terminated' || instance.status === 'failed' || instance.status === 'superseded';
}

export interface DesiredRuntimeQueueDeps {
  getInstance(instanceId: string): Instance | undefined;
  /**
   * LT-020: true while a loop iteration is executing on this instance's
   * adapter. Applying a change then respawns the CLI the loop is mid-iteration
   * on, which the loop can only see as an unexplained `process_exit`.
   *
   * **Required on purpose.** As an optional dep this guard could be deleted at
   * the single production call site with every test still green — the exact
   * shape of "exists but isn't wired" that shipped the bug it prevents. Test
   * doubles that don't care pass `() => false`.
   */
  isAdapterOnLoan(instanceId: string): boolean;
  /** Optional diagnostic hook; absent in test doubles that don't care. */
  warnIfLoanLooksWedged?(instanceId: string): void;
  /** Apply the desired runtime now (respawns the session). Caller must be settled. */
  applyChange(instanceId: string, desired: DesiredRuntime): Promise<Instance>;
  /** Broadcast the queued desired runtime (set or cleared) to the renderer. */
  publishPendingState(instance: Instance): void;
  /** Surface a permanently-failed deferred apply in the transcript. */
  notifyApplyFailure(instance: Instance, message: OutputMessage): void;
}

export class DesiredRuntimeQueue {
  /** Instances with a deferred apply already scheduled (dedupe guard). */
  private readonly scheduled = new Set<string>();
  /** Explicit account IPC must acknowledge the completed handoff, not parking it. */
  private readonly accountCompletions = new Map<string, AccountChangeCompletion>();
  /** A live stamp may still precede a write held behind the session mutex. */
  private readonly applying = new Map<string, ActiveRuntimeChange>();

  constructor(private readonly deps: DesiredRuntimeQueueDeps) {}

  /**
   * Whether the change may be applied right now. Status alone is not enough:
   * a borrowed adapter (LT-020) can leave the instance reading input-waiting
   * between two turns of the same in-flight loop iteration.
   */
  private canApplyNow(instance: Instance): boolean {
    return isModelSwitchAllowedStatus(instance.status)
      && !this.deps.isAdapterOnLoan(instance.id);
  }

  private isTransientRejection(error: unknown, active: ActiveRuntimeChange, instance: Instance): boolean {
    // The reconciler's status gate emits a plain Error. Match the exact reason
    // from an observed unavailable status, plus a real later ready boundary;
    // an arbitrary startup error with an idle/error transition is permanent.
    return isAdapterOnLoanError(error) || !this.canApplyNow(instance)
      || (active.boundaryObserved && active.unavailableReason !== undefined
        && error instanceof Error && error.message === active.unavailableReason);
  }

  /**
   * Queue-aware change request. Applies immediately from an input-waiting
   * status; otherwise parks the desired runtime for auto-apply on the next
   * settle. A desired runtime matching the live config cancels any queued
   * change instead. Confirmed account handoffs wait for application even when
   * queued; ordinary runtime requests acknowledge that they were parked.
   */
  async requestChange(instanceId: string, desired: DesiredRuntime): Promise<Instance> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      this.rejectQueuedAccount(instanceId, new Error(`Instance ${instanceId} not found`));
      throw new Error(`Instance ${instanceId} not found`);
    }
    if (cannotContinue(instance)) {
      this.rejectQueuedAccount(instanceId, new Error('This session can no longer change accounts.'));
      throw new Error('This session can no longer change accounts.');
    }

    this.rejectQueuedAccount(instanceId, new Error('Queued account change was superseded or cancelled.'));
    const active = this.applying.get(instanceId);
    if (active) active.superseded = true;
    let retryAfterParking = false;
    let yoloCleanupAfterParking: ActiveRuntimeChange['yoloCleanup'];

    // Re-selecting the live config is a no-op — and cancels a queued change.
    // While an apply is active, that config may still be overwritten: park the
    // reset behind it rather than claiming cancellation before its write ends.
    if (!active && !computeRuntimeDiff(instance, desired).hasChanges) {
      if (instance.desiredRuntime !== undefined) {
        instance.desiredRuntime = undefined;
        this.deps.publishPendingState(instance);
        logger.info('Queued desired runtime cancelled', { instanceId });
      }
      return instance;
    }

    // Apply immediately from a settled state. If we lose a race to a new
    // turn, the reconciler throws on its status gate — fall through and queue.
    if (!active && this.canApplyNow(instance)) {
      const immediate: ActiveRuntimeChange = { superseded: false, boundaryObserved: false };
      this.applying.set(instanceId, immediate);
      instance.desiredRuntime = desired;
      this.deps.publishPendingState(instance);
      let requeued = false;
      let failedPermanently = false;
      try {
        const result = await this.deps.applyChange(instanceId, desired);
        if (cannotContinue(result) || this.deps.getInstance(instanceId) !== result) {
          // Completion on a removed/replaced runtime is never a transient race.
          failedPermanently = true;
          throw new Error('This session is no longer available after the account change.');
        }
        return result;
      } catch (error) {
        const live = this.deps.getInstance(instanceId);
        // As in the deferred path, a loan rejection retries later only for
        // the original owner; a replacement must never inherit this request.
        if (failedPermanently || live !== instance || cannotContinue(live) || immediate.superseded
          || !this.isTransientRejection(error, immediate, live)) {
          failedPermanently = true;
          throw error;
        }
        // Became busy, or a loop took the adapter mid-flight — queue below.
        requeued = true;
      } finally {
        this.applying.delete(instanceId);
        const live = this.deps.getInstance(instanceId);
        if (!requeued) {
          this.finishYoloCleanup(instanceId, immediate.yoloCleanup, failedPermanently ? desired : undefined);
          this.clearAppliedPendingState(instanceId, desired);
          if (live) this.onSettled(live);
        } else {
          retryAfterParking = immediate.boundaryObserved;
          yoloCleanupAfterParking = immediate.yoloCleanup;
        }
      }
    }

    const live = this.deps.getInstance(instanceId) ?? instance;
    live.desiredRuntime = desired;
    const completion = desired.accountProfileId !== undefined
      && (desired.accountHandoffKind ?? 'explicit') === 'explicit'
      && desired.accountHandoffConfirmed
      ? this.createAccountCompletion(instanceId)
      : undefined;
    this.deps.publishPendingState(live);
    logger.info('Runtime change queued (instance not waiting for input)', {
      instanceId,
      status: live.status,
      desiredRuntime: desired,
    });
    // This path parks quietly and never reaches `assertAdapterNotOnLoan`, so a
    // wedged loan would otherwise show as a pending chip that never lands, with
    // nothing in the log to explain it.
    this.deps.warnIfLoanLooksWedged?.(instanceId);
    this.finishYoloCleanup(instanceId, yoloCleanupAfterParking);
    if (retryAfterParking) this.onSettled(live);
    return completion?.promise ?? live;
  }

  /**
   * Remove a satisfied queued permission flip, or cancel an opposite queued
   * flip after an explicit setter forces the live value. The queue owns the
   * remainder's publication/completion and postpones cleanup across active writes.
   */
  clearQueuedYoloKey(instance: Instance): void {
    const desired = instance.desiredRuntime;
    if (desired?.yoloMode === undefined) return;
    const cleanup = { desired, yoloMode: instance.yoloMode };
    const active = this.applying.get(instance.id);
    if (active) {
      // Account and mode stamps are provisional until the owned apply exits.
      // Preserve exact pending identity so a later replacement invalidates this intent.
      active.yoloCleanup = cleanup;
      return;
    }
    this.finishYoloCleanup(instance.id, cleanup);
    this.onSettled(instance);
  }

  private finishYoloCleanup(
    instanceId: string,
    cleanup: ActiveRuntimeChange['yoloCleanup'],
    discardedDesired?: DesiredRuntime,
  ): void {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      this.rejectQueuedAccount(instanceId, new Error(`Instance ${instanceId} not found`));
      return;
    }
    // A cleanup must never revive the exact target whose permanent failure
    // just discarded it. A separately queued newer target retains ownership.
    if (!cleanup || cleanup.desired === discardedDesired || instance.desiredRuntime !== cleanup.desired) return;
    if (cannotContinue(instance)) {
      this.onSettled(instance);
      return;
    }
    const { yoloMode: _cleared, ...rest } = cleanup.desired;
    // An older future write may have changed the mode after the user forced it.
    // Keep an explicit correction in that case; omission would adopt the stale write.
    const remainder = instance.yoloMode === cleanup.yoloMode ? rest : { ...rest, yoloMode: cleanup.yoloMode };
    instance.desiredRuntime = computeRuntimeDiff(instance, remainder).hasChanges ? remainder : undefined;
    this.deps.publishPendingState(instance);
    if (instance.desiredRuntime === undefined) {
      const completion = this.accountCompletions.get(instanceId);
      this.accountCompletions.delete(instanceId);
      completion?.resolve(instance);
    }
  }

  private clearAppliedPendingState(instanceId: string, desired: DesiredRuntime): void {
    const instance = this.deps.getInstance(instanceId);
    if (instance?.desiredRuntime !== desired) return;
    instance.desiredRuntime = undefined;
    this.deps.publishPendingState(instance);
  }

  private createAccountCompletion(instanceId: string): AccountChangeCompletion {
    let resolve!: AccountChangeCompletion['resolve'];
    let reject!: AccountChangeCompletion['reject'];
    const promise = new Promise<Instance>((onSuccess, onFailure) => {
      resolve = onSuccess;
      reject = onFailure;
    });
    const completion = { promise, resolve, reject };
    this.accountCompletions.set(instanceId, completion);
    return completion;
  }

  private rejectQueuedAccount(instanceId: string, error: unknown): void {
    const completion = this.accountCompletions.get(instanceId);
    this.accountCompletions.delete(instanceId);
    completion?.reject(error);
  }

  /**
   * Called on every state transition. When an instance settles into an
   * input-waiting status with a queued desired runtime, schedule the apply.
   */
  onSettled(instance: Instance): void {
    if (cannotContinue(instance)) {
      this.rejectQueuedAccount(instance.id, new Error('This session can no longer change accounts.'));
      if (instance.desiredRuntime !== undefined) {
        instance.desiredRuntime = undefined;
        this.deps.publishPendingState(instance);
      }
      const active = this.applying.get(instance.id);
      if (active) active.superseded = true;
      return;
    }
    const active = this.applying.get(instance.id);
    if (active) {
      const unavailableReason = getModelSwitchUnavailableReason(instance.status);
      if (unavailableReason) active.unavailableReason = unavailableReason;
      if (this.canApplyNow(instance)) active.boundaryObserved = true;
    }
    if (this.canApplyNow(instance) && instance.desiredRuntime !== undefined) {
      this.schedule(instance.id);
    }
  }

  /**
   * LT-020: a loop iteration finished borrowing this instance's adapter. That
   * — not the instance's status flicker mid-iteration — is the real boundary at
   * which a queued change becomes safe.
   */
  onAdapterLoanReleased(instanceId: string): void {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      this.rejectQueuedAccount(instanceId, new Error(`Instance ${instanceId} not found`));
      return;
    }
    if (!this.canApplyNow(instance)) return;
    const active = this.applying.get(instanceId);
    if (active) active.boundaryObserved = true;
    if (instance.desiredRuntime === undefined) return;
    logger.info('Applying runtime change deferred by a loop adapter loan', {
      instanceId,
      desiredRuntime: instance.desiredRuntime,
    });
    this.schedule(instanceId);
  }

  /**
   * Defer the apply to a fresh macrotask. It MUST NOT run inline within a
   * state transition: the apply acquires the session mutex, and transitions
   * can run while that mutex is held — re-entering synchronously would
   * self-deadlock. `setImmediate` defers past the current call stack.
   */
  private schedule(instanceId: string): void {
    if (this.scheduled.has(instanceId) || this.applying.has(instanceId)) {
      return;
    }
    this.scheduled.add(instanceId);
    setImmediate(() => {
      void this.apply(instanceId);
    });
  }

  private async apply(instanceId: string): Promise<void> {
    this.scheduled.delete(instanceId);
    // A direct request can start between scheduling and this macrotask. Its
    // completion will schedule the remaining desired runtime after it exits.
    if (this.applying.has(instanceId)) return;
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      this.rejectQueuedAccount(instanceId, new Error(`Instance ${instanceId} not found`));
      return;
    }
    const desired = instance.desiredRuntime;
    if (desired === undefined) {
      return;
    }
    if (!this.canApplyNow(instance)) {
      // Raced with a new turn, or a loop borrowed the adapter (LT-020). A later
      // settled transition — or the loan release — reschedules.
      return;
    }
    const completion = this.accountCompletions.get(instanceId);
    this.accountCompletions.delete(instanceId);
    // The previous owned apply may have failed or already reached this target.
    // Re-check only now, when no future write can invalidate the live stamp.
    if (!computeRuntimeDiff(instance, desired).hasChanges) {
      instance.desiredRuntime = undefined;
      this.deps.publishPendingState(instance);
      completion?.resolve(instance);
      return;
    }
    const active: ActiveRuntimeChange = { superseded: false, boundaryObserved: false };
    this.applying.set(instanceId, active);
    let requeued = false;
    let failedPermanently = false;
    // Keep ownership visible to newly connected renderers until the future
    // write finishes. The applying guard prevents reentrant/double applies.
    this.deps.publishPendingState(instance);
    try {
      const result = await this.deps.applyChange(instanceId, desired);
      if (cannotContinue(result) || this.deps.getInstance(instanceId) !== result) {
        completion?.reject(new Error('This session is no longer available after the account change.'));
      } else {
        completion?.resolve(result);
      }
    } catch (error) {
      // The status checked above is re-checked by the reconciler *after* it
      // acquires the session mutex, and another holder (a restart, say) can own
      // that mutex for seconds. Losing that race is transient, not a failed
      // swap — re-park the request so an observed settle/loan release retries
      // it, exactly as the immediate path does. Without a fresh boundary, a
      // transient rejection remains parked rather than spinning.
      const live = this.deps.getInstance(instanceId);
      // A loan rejection is retry-later only while the original instance owns
      // this operation; the loan need not still be held when we get here. A short
      // iteration can start and finish inside this window, which would
      // otherwise make `canApplyNow` true again and drop the user's change with
      // a permanent-failure notice quoting a transient condition.
      if (live === instance && !cannotContinue(live) && !active.superseded
        && this.isTransientRejection(error, active, live)) {
        live.desiredRuntime = desired;
        if (completion) this.accountCompletions.set(instanceId, completion);
        requeued = true;
        this.deps.publishPendingState(live);
        logger.info('Deferred runtime change lost the status race; re-queued', {
          instanceId,
          status: live.status,
          reason: isAdapterOnLoanError(error) ? 'adapter-on-loan' : 'status',
          desiredRuntime: desired,
        });
        return;
      }

      completion?.reject(error);
      failedPermanently = true;

      // Unlike the YOLO queue we do NOT retry: a failed swap is usually
      // permanent (target CLI missing), and silent retry loops would respawn
      // repeatedly. Surface it in the transcript instead.
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Deferred runtime change failed; dropping the queued request', {
        instanceId,
        desired,
        error: message,
      });
      if (live === instance) {
        this.deps.notifyApplyFailure(live, {
          id: generateId(),
          timestamp: Date.now(),
          type: 'system',
          content: `Queued runtime change could not be applied: ${message}`,
          metadata: { kind: 'pending-model-change-failed' },
        });
      }
    } finally {
      this.applying.delete(instanceId);
      this.finishYoloCleanup(instanceId, active.yoloCleanup, failedPermanently ? desired : undefined);
      if (!requeued) this.clearAppliedPendingState(instanceId, desired);
      // A settle/loan release can race ahead of the transient rejection. Consume
      // that real boundary once; a rejection without a new event never spins.
      const live = this.deps.getInstance(instanceId);
      if (live && (!requeued || active.boundaryObserved)) this.onSettled(live);
    }
  }
}
