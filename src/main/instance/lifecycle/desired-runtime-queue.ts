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
import type { DesiredRuntime } from './runtime-reconciler.types';
import type { Instance, OutputMessage } from '../../../shared/types/instance.types';

const logger = getLogger('DesiredRuntimeQueue');

export interface DesiredRuntimeQueueDeps {
  getInstance(instanceId: string): Instance | undefined;
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
    if (isModelSwitchAllowedStatus(instance.status)) {
      instance.desiredRuntime = undefined;
      try {
        return await this.deps.applyChange(instanceId, desired);
      } catch (error) {
        const live = this.deps.getInstance(instanceId);
        if (!live || isModelSwitchAllowedStatus(live.status)) {
          throw error;
        }
        // Became busy mid-flight — queue below.
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
    return live;
  }

  /**
   * Called on every state transition. When an instance settles into an
   * input-waiting status with a queued desired runtime, schedule the apply.
   */
  onSettled(instance: Instance): void {
    if (isModelSwitchAllowedStatus(instance.status) && instance.desiredRuntime !== undefined) {
      this.schedule(instance.id);
    }
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
    if (!isModelSwitchAllowedStatus(instance.status)) {
      // Raced with a new turn; a later settled transition will reschedule.
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
      // Unlike the YOLO queue we do NOT retry: a failed swap is usually
      // permanent (target CLI missing), and silent retry loops would respawn
      // repeatedly. Surface it in the transcript instead.
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Deferred runtime change failed; dropping the queued request', {
        instanceId,
        desired,
        error: message,
      });
      const live = this.deps.getInstance(instanceId);
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
