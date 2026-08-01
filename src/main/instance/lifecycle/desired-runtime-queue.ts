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
import { isModelSwitchAllowedStatus } from '../../../shared/types/instance-status-policy';
import { computeRuntimeDiff } from './runtime-reconciler-plan';
import { isAdapterOnLoanError } from './adapter-loan-registry';
import type { DesiredRuntime } from './runtime-reconciler.types';
import type { Instance, OutputMessage } from '../../../shared/types/instance.types';

const logger = getLogger('DesiredRuntimeQueue');

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

  /**
   * Queue-aware change request. Applies immediately from an input-waiting
   * status; otherwise parks the desired runtime for auto-apply on the next
   * settle. A desired runtime matching the live config cancels any queued
   * change instead.
   */
  async requestChange(instanceId: string, desired: DesiredRuntime): Promise<Instance> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    // Re-selecting the live config is a no-op — and cancels a queued change.
    if (!computeRuntimeDiff(instance, desired).hasChanges) {
      if (instance.desiredRuntime !== undefined) {
        instance.desiredRuntime = undefined;
        this.deps.publishPendingState(instance);
        logger.info('Queued desired runtime cancelled', { instanceId });
      }
      return instance;
    }

    // Apply immediately from a settled state. If we lose a race to a new
    // turn, the reconciler throws on its status gate — fall through and queue.
    if (this.canApplyNow(instance)) {
      instance.desiredRuntime = undefined;
      try {
        return await this.deps.applyChange(instanceId, desired);
      } catch (error) {
        const live = this.deps.getInstance(instanceId);
        // Same reasoning as the deferred path: a loan rejection is retry-later,
        // so queue it rather than throwing the transient message at the caller.
        if (!live || (this.canApplyNow(live) && !isAdapterOnLoanError(error))) {
          throw error;
        }
        // Became busy, or a loop took the adapter mid-flight — queue below.
      }
    }

    const live = this.deps.getInstance(instanceId) ?? instance;
    live.desiredRuntime = desired;
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
    return live;
  }

  /**
   * Called on every state transition. When an instance settles into an
   * input-waiting status with a queued desired runtime, schedule the apply.
   */
  onSettled(instance: Instance): void {
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
    if (!instance || instance.desiredRuntime === undefined) return;
    if (!this.canApplyNow(instance)) return;
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
    if (this.scheduled.has(instanceId)) {
      return;
    }
    this.scheduled.add(instanceId);
    setImmediate(() => {
      void this.apply(instanceId);
    });
  }

  private async apply(instanceId: string): Promise<void> {
    this.scheduled.delete(instanceId);
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
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
    // Clear BEFORE applying: the reconciler transitions through initializing →
    // idle, and the idle transition re-enters onSettled — a still-set desired
    // runtime would schedule a second apply.
    instance.desiredRuntime = undefined;
    this.deps.publishPendingState(instance);
    try {
      await this.deps.applyChange(instanceId, desired);
    } catch (error) {
      // The status checked above is re-checked by the reconciler *after* it
      // acquires the session mutex, and another holder (a restart, say) can own
      // that mutex for seconds. Losing that race is transient, not a failed
      // swap — re-park the request so the next settle retries it, exactly as
      // the immediate path does. This cannot spin: a gate rejection performs no
      // state transition, and `onSettled` only fires from one, so a retry needs
      // a genuine external transition back into an allowed status.
      const live = this.deps.getInstance(instanceId);
      // A loan rejection is *always* retry-later, never a failed swap — and it
      // must not depend on the loan still being held when we get here. A short
      // iteration can start and finish inside this window, which would
      // otherwise make `canApplyNow` true again and drop the user's change with
      // a permanent-failure notice quoting a transient condition.
      if (live && (isAdapterOnLoanError(error) || !this.canApplyNow(live))) {
        live.desiredRuntime = desired;
        this.deps.publishPendingState(live);
        logger.info('Deferred runtime change lost the status race; re-queued', {
          instanceId,
          status: live.status,
          reason: isAdapterOnLoanError(error) ? 'adapter-on-loan' : 'status',
          desiredRuntime: desired,
        });
        return;
      }

      // Unlike the YOLO queue we do NOT retry: a failed swap is usually
      // permanent (target CLI missing), and silent retry loops would respawn
      // repeatedly. Surface it in the transcript instead.
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Deferred runtime change failed; dropping the queued request', {
        instanceId,
        desired,
        error: message,
      });
      if (live) {
        this.deps.notifyApplyFailure(live, {
          id: generateId(),
          timestamp: Date.now(),
          type: 'system',
          content: `Queued runtime change could not be applied: ${message}`,
          metadata: { kind: 'pending-model-change-failed' },
        });
      }
    }
  }
}
