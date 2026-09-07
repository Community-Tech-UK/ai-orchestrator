/**
 * N2 — a doom-loop detection that outlives its toast.
 *
 * `app.component.ts` shows a toast when `instance:doom-loop` arrives. That is
 * the right surface for someone watching the screen and useless for the case
 * that costs money: an agent repeating the same tool call while nobody is
 * looking. A toast is gone in seconds and leaves no mark on the session it was
 * about, so the list gives no hint that one row is burning tokens in a circle.
 *
 * This keeps the detection addressable for as long as it is true, so the row
 * badge and the notification-centre actions have something honest to read.
 *
 * **Reaping.** There is no "resolved" event to key off — the detector simply
 * stops re-emitting once a tool's result hash changes, and silence is not a
 * signal. So an alert is cleared when the instance leaves an active turn
 * (`isActiveTurnStatus`). That is the one boundary that is actually true:
 * whatever was looping *during* a turn is over once the turn itself is. Holding
 * the alert past that would leave a stale badge on a session that has moved on,
 * and offering "Interrupt now" for a turn that already ended is worse than
 * offering nothing.
 *
 * Only `critical` is retained. A `warning` is the detector saying "this might
 * be a loop"; it has its toast, and badging every one would train the operator
 * to ignore the badge — which costs exactly when a real one appears.
 */
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';

import { IpcFacadeService } from '../services/ipc';
import { InstanceStore } from './instance.store';
import { isActiveTurnStatus } from './instance/instance-messaging-queue-utils';

/**
 * Structural mirror of `ToolLoopDetectionEvent`
 * (`src/main/orchestration/doom-loop-detector.ts`). Main-process types are not
 * imported into the renderer bundle; `app.component.ts` declares the same shape
 * for the same reason.
 */
interface ToolLoopEventPayload {
  instanceId: string;
  detector: 'repeat-no-progress' | 'ping-pong' | 'runaway';
  severity: 'warn' | 'critical';
  toolName: string;
  count: number;
  windowDescription: string;
}

export interface ToolLoopAlert {
  instanceId: string;
  toolName: string;
  detector: string;
  count: number;
  windowDescription: string;
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

  constructor() {
    // Multiple preload listeners on one channel are supported, so this
    // subscribes independently rather than being threaded through the toast.
    const cleanup = this.ipc.on('instance:doom-loop', (data) => {
      const event = data as ToolLoopEventPayload;
      if (event.severity !== 'critical') return;
      const next = new Map(this.alerts());
      next.set(event.instanceId, {
        instanceId: event.instanceId,
        toolName: event.toolName,
        detector: event.detector,
        count: event.count,
        windowDescription: event.windowDescription,
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

  /** Drop an alert the operator has explicitly acted on. */
  acknowledge(instanceId: string): void {
    if (!this.alerts().has(instanceId)) return;
    const next = new Map(this.alerts());
    next.delete(instanceId);
    this.alerts.set(next);
  }
}
