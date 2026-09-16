/**
 * Cross-Session Messaging Settings Tab
 *
 * Global controls for the cross-session messaging feature (see
 * `src/main/instance/cross-session-messaging.ts`), plus the per-instance
 * "allow incoming session messages" consent list. Settings themselves are
 * intentionally read-only to agents (see `settings-control-policy.ts`) —
 * only this human-facing UI can change them.
 */

import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { InstanceQueries } from '../../core/state/instance/instance.queries';
import { IpcFacadeService } from '../../core/services/ipc';
import { ToastService } from '../../core/services/toast.service';
import { SettingsCardComponent } from './ui/settings-card.component';
import { InlineHelpComponent } from '../../shared/help/inline-help.component';

@Component({
  selector: 'app-cross-session-messaging-settings-tab',
  standalone: true,
  imports: [SettingsCardComponent, InlineHelpComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './cross-session-messaging-settings-tab.component.html',
  styleUrl: './cross-session-messaging-settings-tab.component.scss',
})
export class CrossSessionMessagingSettingsTabComponent {
  protected readonly store = inject(SettingsStore);
  private readonly instanceQueries = inject(InstanceQueries);
  private readonly ipc = inject(IpcFacadeService);
  private readonly toast = inject(ToastService);

  protected readonly settings = computed(() => this.store.get('interSessionMessaging'));
  protected readonly liveInstances = computed(() =>
    this.instanceQueries.instances().filter((instance) => instance.status !== 'terminated'),
  );

  private readonly pendingToggles = signal<ReadonlySet<string>>(new Set());
  protected isTogglePending(instanceId: string): boolean {
    return this.pendingToggles().has(instanceId);
  }

  async toggleEnabled(): Promise<void> {
    const current = this.settings();
    await this.store.set('interSessionMessaging', { ...current, enabled: !current.enabled });
  }

  async toggleAllowCrossProject(): Promise<void> {
    const current = this.settings();
    await this.store.set('interSessionMessaging', {
      ...current,
      allowCrossProject: !current.allowCrossProject,
    });
  }

  async setMaxHops(value: string): Promise<void> {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    const current = this.settings();
    await this.store.set('interSessionMessaging', { ...current, maxHops: parsed });
  }

  async setRateLimitPerMinute(value: string): Promise<void> {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return;
    const current = this.settings();
    await this.store.set('interSessionMessaging', {
      ...current,
      rateLimitPerMinute: parsed,
    });
  }

  async toggleInstanceConsent(instanceId: string, allow: boolean): Promise<void> {
    this.pendingToggles.update((set) => new Set(set).add(instanceId));
    try {
      const response = await this.ipc.instance.toggleAllowIncomingSessionMessages(instanceId, allow);
      if (!response.success) {
        this.toast.show(response.error?.message ?? 'Failed to update consent', 'error');
      }
    } finally {
      this.pendingToggles.update((set) => {
        const next = new Set(set);
        next.delete(instanceId);
        return next;
      });
    }
  }
}
