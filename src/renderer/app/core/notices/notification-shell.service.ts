import { DestroyRef, Injectable, effect, inject, untracked } from '@angular/core';
import { IpcFacadeService } from '../services/ipc';
import { ToastService } from '../services/toast.service';
import { InstanceStore } from '../state/instance.store';
import { NotificationCenterStore } from '../state/notification-center.store';
import { ToolLoopAlertStore } from '../state/tool-loop-alert.store';
import { SessionNavigator } from '../services/session-navigator.service';
import { describeToolLoop, type ToolLoopSummaryInput } from '../../../../shared/tool-loop-summary';

interface ToolLoopEvent extends ToolLoopSummaryInput {
  instanceId: string;
  /** Harness is stopping the turn itself (`InstanceDoomLoopEventSchema`). */
  harnessStopping: boolean;
}

/** App-wide notification listeners survive navigation to every secondary page. */
@Injectable({ providedIn: 'root' })
export class NotificationShellService {
  private readonly ipc = inject(IpcFacadeService);
  private readonly toast = inject(ToastService);
  private readonly alerts = inject(ToolLoopAlertStore);
  private readonly instances = inject(InstanceStore);
  private readonly center = inject(NotificationCenterStore);
  private readonly navigator = inject(SessionNavigator);
  private unsubscribe: (() => void) | null = null;
  private readonly criticalToastIds = new Set<string>();

  constructor() {
    effect(() => {
      const live = this.alerts.liveIds();
      for (const id of this.criticalToastIds) {
        if (live.has(id)) continue;
        untracked(() => this.toast.dismissKey(`tool-loop:${id}`));
        this.criticalToastIds.delete(id);
      }
    });
    effect(() => {
      const id = this.instances.selectedInstanceId();
      // Seen-on-selecting only: untracked so a notification delta (which the store records through
      // its records signal) can never re-trigger this effect and mark brand-new records seen while
      // the user has not selected anything.
      if (id) untracked(() => this.center.markSessionSeen(id));
    });
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  start(): void {
    this.center.init();
    if (this.unsubscribe) return;
    // Main forwards only the detections worth a person's attention
    // (`shouldTellUserAboutToolLoop`), so every event here gets a toast.
    this.unsubscribe = this.ipc.on('instance:doom-loop', data => {
      const event = data as ToolLoopEvent;
      // Harness stopping the turn itself leaves nothing to decide: say so, and
      // let the toast time out instead of staying until the alert clears.
      const stopping = event.harnessStopping;
      if (stopping) this.criticalToastIds.delete(event.instanceId);
      else this.criticalToastIds.add(event.instanceId);
      // Name the session: the toast is often seen from a different one.
      const name = this.instances.getInstance(event.instanceId)?.displayName || 'A session';
      this.toast.show(`${name} may be stuck. ${describeToolLoop(event)}${stopping ? ' Harness is stopping it.' : ''}`,
        stopping ? 'warning' : 'error', { key: `tool-loop:${event.instanceId}`,
          action: { label: 'Show session', run: () => this.navigator.openSession(event.instanceId) } });
    }) ?? null;
  }

  stop(): void { this.unsubscribe?.(); this.unsubscribe = null; }
}
