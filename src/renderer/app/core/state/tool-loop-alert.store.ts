/**
 * N2 — a doom-loop detection that outlives its toast.
 *
 * `NotificationShellService` shows a toast when `instance:doom-loop` arrives. That is
 * the right surface for someone watching the screen and useless for the case
 * that costs money: an agent repeating the same tool call while nobody is
 * looking. A toast is gone in seconds and leaves no mark on the session it was
 * about, so the list gives no hint that one row is burning tokens in a circle.
 *
 * This keeps the detection addressable for as long as it is true, so the row
 * badge, the bar above the session's message box, the Needs you card and the
 * notification-centre actions have something honest to read.
 *
 * **Reaping.** There is no "resolved" event to key off — the detector simply
 * stops re-emitting once a tool's result hash changes, and silence is not a
 * signal. So an alert is cleared when the instance leaves an active turn
 * (`isActiveTurnStatus`): hidden at once by `live`, then deleted, so the next
 * turn starts clean instead of reviving an old warning (the detector also
 * starts each turn afresh). That is the one boundary that is actually true:
 * whatever was looping *during* a turn is over once the turn itself is. Holding
 * the alert past that would leave a stale badge on a session that has moved on,
 * and offering "Stop this turn" for a turn that already ended is worse than
 * offering nothing.
 *
 * Main sends only detections worth a person's attention
 * (`shouldTellUserAboutToolLoop` in `tool-loop-notice.ts`): a detector's first
 * "might be repeating" warning, or a long turn that is merely busy, never
 * arrives here, so every alert that does is one worth badging.
 */
import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';

import { IpcFacadeService } from '../services/ipc';
import { InstanceStore } from './instance.store';
import { isActiveTurnStatus } from './instance/instance-messaging-queue-utils';
import type { ToolLoopDetector } from '../../../../shared/tool-loop-summary';

/**
 * Structural mirror of `InstanceDoomLoopEventSchema`
 * (`packages/contracts/src/schemas/instance-renderer-events.schemas.ts`).
 * Main-process types are not imported into the renderer bundle.
 */
interface ToolLoopEventPayload {
  instanceId: string;
  detector: ToolLoopDetector;
  severity: 'critical';
  toolName: string;
  count: number;
  windowDescription: string;
  /** Harness is stopping the turn itself, so there is nothing to decide. */
  harnessStopping: boolean;
}

export interface ToolLoopAlert {
  instanceId: string;
  toolName: string;
  detector: ToolLoopDetector;
  count: number;
  detectedAt: number;
}

@Injectable({ providedIn: 'root' })
export class ToolLoopAlertStore {
  private readonly ipc = inject(IpcFacadeService);
  private readonly instances = inject(InstanceStore);

  private readonly alerts = signal<ReadonlyMap<string, ToolLoopAlert>>(new Map<string, ToolLoopAlert>());

  /**
   * Live alerts, already filtered by the reaping rule. Computed rather than
   * eagerly pruned so a status change surfaces immediately without depending on
   * a separate event arriving to trigger the cleanup.
   */
  private readonly live = computed(() => {
    const byId = new Map<string, ToolLoopAlert>();
    for (const [id, alert] of this.alerts()) {
      const status = this.instances.instances().find((i) => i.id === id)?.status;
      if (isActiveTurnStatus(status)) byId.set(id, alert);
    }
    return byId;
  });

  readonly liveIds = computed(() => new Set(this.live().keys()));

  /** One stop per session at a time; a second click joins the first (see `stopTurn`). */
  private readonly pendingStops = new Map<string, Promise<boolean>>();
  private readonly stoppingIds = signal<ReadonlySet<string>>(new Set<string>());
  /** Sessions whose queue a refused "Stop this turn" held (it was not held before). */
  private readonly queueHeldByRefusedStop = new Set<string>();

  constructor() {
    // Delete alerts whose turn has ended; `live` already hides them. Forget
    // which queues a refused stop held once that turn is over, whether or not
    // its alert is still around: the queue stays held, as after Stop, and a
    // later turn's "Let it continue" must not release it.
    effect(() => {
      const instances = this.instances.instances();
      for (const id of this.queueHeldByRefusedStop) {
        if (!isActiveTurnStatus(instances.find((i) => i.id === id)?.status)) this.queueHeldByRefusedStop.delete(id);
      }
      const ended = [...this.alerts().keys()].filter((id) => !this.live().has(id));
      if (ended.length === 0) return;
      untracked(() => {
        const next = new Map(this.alerts());
        for (const id of ended) next.delete(id);
        this.alerts.set(next);
      });
    });
    // Multiple preload listeners on one channel are supported, so this
    // subscribes independently rather than being threaded through the toast.
    const cleanup = this.ipc.on('instance:doom-loop', (data) => {
      const event = data as ToolLoopEventPayload;
      if (event.harnessStopping) {
        // Offering "Stop this turn" now would send a second interrupt, which
        // main treats as "force it"; and "Let it continue" could not be honoured.
        this.dropAlert(event.instanceId);
        return;
      }
      const next = new Map(this.alerts());
      next.set(event.instanceId, {
        instanceId: event.instanceId,
        toolName: event.toolName,
        detector: event.detector,
        count: event.count,
        detectedAt: Date.now(),
      });
      this.alerts.set(next);
    });
    inject(DestroyRef).onDestroy(() => cleanup?.());
  }

  /** True when this specific row is currently looping. */
  hasCriticalAlert(instanceId: string | undefined): boolean {
    if (!instanceId) return false;
    return this.live().has(instanceId);
  }

  alertFor(instanceId: string | undefined): ToolLoopAlert | null {
    if (!instanceId) return null;
    return this.live().get(instanceId) ?? null;
  }

  /** True while a "Stop this turn" for this session is waiting on the interrupt. */
  isStopping(instanceId: string | undefined): boolean {
    return instanceId !== undefined && this.stoppingIds().has(instanceId);
  }

  /**
   * "Stop this turn". Holds the queue and then interrupts, in the same order as
   * the session's Stop button, so a queued message does not start the moment
   * the stuck turn ends; the held-queue bar offers Resume.
   *
   * A second call while one is running returns the first call's result rather
   * than sending another interrupt: main treats a second interrupt during an
   * interrupt as "force it" and kills the process, which a double click must
   * never do.
   *
   * If the turn refuses to stop, the alert stays so the choice is still
   * offered and the queue stays held, as after Stop. Unlike the Stop button
   * this does not force-restart the session; callers point the user at Stop
   * for that. Choosing "Let it continue" afterwards releases the queue again,
   * but only when this stop was what held it.
   */
  stopTurn(instanceId: string): Promise<boolean> {
    const pending = this.pendingStops.get(instanceId);
    if (pending) return pending;
    // `.finally` always runs on a later microtask, so the entry is in place before it is removed.
    const stop = this.interruptHoldingQueue(instanceId).finally(() => {
      this.pendingStops.delete(instanceId);
      this.setStopping(instanceId, false);
    });
    this.pendingStops.set(instanceId, stop);
    this.setStopping(instanceId, true);
    return stop;
  }

  private async interruptHoldingQueue(instanceId: string): Promise<boolean> {
    const alreadyHeld = this.instances.isQueueParked(instanceId);
    this.instances.parkQueueAfterInterrupt(instanceId);
    let stopped = false;
    try {
      stopped = await this.instances.interruptInstance(instanceId);
    } finally {
      if (stopped) {
        this.queueHeldByRefusedStop.delete(instanceId);
        this.dropAlert(instanceId);
      } else if (!alreadyHeld && this.instances.isQueueParked(instanceId)) {
        // Only when this stop is what held it (an empty queue is never held).
        this.queueHeldByRefusedStop.add(instanceId);
      }
    }
    return stopped;
  }

  private setStopping(instanceId: string, stopping: boolean): void {
    const next = new Set(this.stoppingIds());
    if (stopping) next.add(instanceId);
    else next.delete(instanceId);
    this.stoppingIds.set(next);
  }

  /**
   * "Let it continue": the turn carries on and this alert is not offered again
   * (the detector does not repeat it this turn). Releases a queue that a
   * refused "Stop this turn" held, since the user has now chosen not to stop.
   */
  letContinue(instanceId: string): void {
    if (this.queueHeldByRefusedStop.delete(instanceId)) this.instances.resumeParkedQueue(instanceId);
    this.dropAlert(instanceId);
  }

  private dropAlert(instanceId: string): void {
    if (!this.alerts().has(instanceId)) return;
    const next = new Map(this.alerts());
    next.delete(instanceId);
    this.alerts.set(next);
  }
}
