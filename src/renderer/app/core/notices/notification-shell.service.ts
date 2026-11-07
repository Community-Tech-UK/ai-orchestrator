import { DestroyRef, Injectable, effect, inject, untracked } from '@angular/core';
import { IpcFacadeService } from '../services/ipc';
import { ToastService } from '../services/toast.service';
import { InstanceStore } from '../state/instance.store';
import { NotificationCenterStore } from '../state/notification-center.store';
import { ToolLoopAlertStore } from '../state/tool-loop-alert.store';
import { SessionNavigator } from '../services/session-navigator.service';

interface ToolLoopEvent {
  instanceId: string;
  severity: 'warn' | 'critical';
  toolName: string;
  windowDescription: string;
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
    this.unsubscribe = this.ipc.on('instance:doom-loop', data => {
      const event = data as ToolLoopEvent;
      const critical = event.severity === 'critical';
      if (critical) this.criticalToastIds.add(event.instanceId);
      this.toast.show(`${critical ? 'Tool loop (critical)' : 'Tool loop warning'}: ${event.toolName} · ${event.windowDescription}`,
        critical ? 'error' : 'warning', { key: `tool-loop:${event.instanceId}`,
          action: { label: 'Show session', run: () => this.navigator.openSession(event.instanceId) } });
    }) ?? null;
  }

  stop(): void { this.unsubscribe?.(); this.unsubscribe = null; }
}
