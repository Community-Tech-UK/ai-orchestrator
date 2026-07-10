/**
 * YOLO-mode toggle queue.
 *
 * YOLO is a spawn-time CLI flag (`--dangerously-skip-permissions`) that only
 * takes effect by respawning the session, which is refused mid-turn. Before
 * this queue, a toggle requested while the instance was busy was simply thrown
 * away (the UI swallowed the error), so users toggled YOLO "on" yet the running
 * process kept denying tool calls.
 *
 * This helper parks a toggle requested while busy in {@link Instance.pendingYoloMode}
 * and applies it automatically the moment the instance settles (idle/ready).
 * Extracted from InstanceLifecycle to keep that file within its size budget.
 */

import { getLogger } from '../../logging/logger';
import type {
  Instance,
  InstanceStatus,
  ContextUsage,
} from '../../../shared/types/instance.types';

const logger = getLogger('YoloModeQueue');

export interface YoloToggledPayload {
  instanceId: string;
  yoloMode: boolean;
  pendingYoloMode?: boolean;
}

export interface YoloModeQueueDeps {
  getInstance(instanceId: string): Instance | undefined;
  /** Respawn the session so the new permission posture takes effect. */
  setYoloMode(instanceId: string, desiredYoloMode: boolean): Promise<Instance>;
  /** Enqueue a renderer state update (mirrors lifecycle's batched updates). */
  queueUpdate(instanceId: string, status: InstanceStatus, contextUsage?: ContextUsage): void;
  /** Emit the `yolo-toggled` event forwarded to the renderer. */
  emitYoloToggled(payload: YoloToggledPayload): void;
}

/** States from which a respawn (and thus a YOLO apply) is safe. */
function isSettled(status: InstanceStatus): boolean {
  return status === 'idle' || status === 'ready';
}

export class YoloModeQueue {
  /** Instances with a deferred apply already scheduled (dedupe guard). */
  private readonly scheduled = new Set<string>();

  constructor(private readonly deps: YoloModeQueueDeps) {}

  /**
   * Queue-aware YOLO toggle. Flips immediately when settled; otherwise parks the
   * desired value for auto-apply on the next idle. The state a click flips is
   * `pendingYoloMode ?? yoloMode`, so a second click while pending cancels it.
   */
  async requestToggle(instanceId: string): Promise<Instance> {
    const instance = this.deps.getInstance(instanceId);
    if (!instance) {
      throw new Error(`Instance ${instanceId} not found`);
    }

    const effectiveTarget = instance.pendingYoloMode ?? instance.yoloMode;
    const desired = !effectiveTarget;

    // Apply immediately from a settled state. If we lose a race to a new turn,
    // setYoloMode throws on its busy check — fall through and queue instead.
    if (isSettled(instance.status)) {
      instance.pendingYoloMode = undefined;
      try {
        return await this.deps.setYoloMode(instanceId, desired);
      } catch (error) {
        const live = this.deps.getInstance(instanceId);
        if (!live || live.status !== 'busy') {
          throw error;
        }
        // Became busy mid-flight — queue below.
      }
    }

    const live = this.deps.getInstance(instanceId) ?? instance;
    // If the desired value already matches the live mode, the user cancelled a
    // pending change; otherwise park it for auto-apply on the next idle.
    live.pendingYoloMode = desired === live.yoloMode ? undefined : desired;
    this.deps.queueUpdate(instanceId, live.status, live.contextUsage);
    this.deps.emitYoloToggled({
      instanceId,
      yoloMode: live.yoloMode,
      pendingYoloMode: live.pendingYoloMode,
    });
    logger.info('YOLO toggle queued (instance not settled)', {
      instanceId,
      status: live.status,
      pendingYoloMode: live.pendingYoloMode,
    });
    return live;
  }

  /**
   * Called on every state transition. When an instance settles with a queued
   * YOLO change, schedule the apply. Safe to call unconditionally.
   */
  onSettled(instance: Instance): void {
    if (
      isSettled(instance.status) &&
      instance.pendingYoloMode !== undefined &&
      instance.pendingYoloMode !== instance.yoloMode
    ) {
      this.schedule(instance.id);
    }
  }

  /**
   * Schedule the deferred apply on a fresh macrotask. This MUST NOT run inline
   * within a state transition: the apply acquires the session mutex, and
   * transitions can run while that mutex is held — re-entering synchronously
   * would self-deadlock. `setImmediate` defers past the current call stack.
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
    const desired = instance.pendingYoloMode;
    if (desired === undefined || desired === instance.yoloMode) {
      instance.pendingYoloMode = undefined;
      return;
    }
    if (!isSettled(instance.status)) {
      // Raced with a new turn; a later settled transition will reschedule.
      return;
    }
    try {
      await this.deps.setYoloMode(instanceId, desired);
    } catch (error) {
      logger.warn('Deferred YOLO apply failed; will retry on next idle', {
        instanceId,
        desired,
        error: error instanceof Error ? error.message : String(error),
      });
      // Keep pendingYoloMode so the next settled transition retries.
    }
  }
}
