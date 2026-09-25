import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { Capacitor } from '@capacitor/core';
import { HostStore } from './host-store';
import { GatewayClient } from './gateway-client.service';
import { HapticsService } from './haptics.service';

/**
 * Registers for APNs and forwards the device token to each paired host so the
 * Mac gateway can push "needs you" alerts (§4.4). Tapping an alert deep-links to
 * the relevant session; the global approval sheet then shows the prompt.
 *
 * No-ops on the web/dev build (Capacitor.isNativePlatform() === false), so the
 * paste/manual flows keep working without a device.
 */
@Injectable({ providedIn: 'root' })
export class PushService {
  private readonly hostStore = inject(HostStore);
  private readonly gateway = inject(GatewayClient);
  private readonly haptics = inject(HapticsService);
  private readonly router = inject(Router);

  private started = false;
  private apnsToken: string | null = null;
  private readonly _routingIssue = signal<'ended-session' | 'unknown-host' | 'host-unavailable' | null>(null);
  private pendingNotificationTap: Record<string, unknown> | null = null;
  readonly endedSession = computed(() => this._routingIssue() === 'ended-session');
  readonly unknownHost = computed(() => this._routingIssue() === 'unknown-host');
  readonly hostUnavailable = computed(() => this._routingIssue() === 'host-unavailable');

  constructor() {
    // Whenever the active host changes (or is first set), make sure it has our token.
    effect(() => {
      this.hostStore.activeHost();
      void this.syncTokenToActiveHost();
    });
  }

  async init(): Promise<void> {
    if (this.started || !Capacitor.isNativePlatform()) {
      return;
    }
    this.started = true;
    try {
      const { PushNotifications } = await import('@capacitor/push-notifications');
      const perm = await PushNotifications.requestPermissions();
      if (perm.receive !== 'granted') {
        return;
      }
      await PushNotifications.addListener('registration', (token) => {
        this.apnsToken = token.value;
        void this.syncTokenToActiveHost();
      });
      await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        const data = action.notification.data as Record<string, unknown>;
        // Custom notification actions (registered natively in AppDelegate):
        // one-tap Approve/Deny without opening the app UI.
        if (action.actionId === 'APPROVE' || action.actionId === 'DENY') {
          void this.respondFromAction(action.actionId, data);
          return;
        }
        void this.handleNotificationTap(data);
      });
      await PushNotifications.register();
    } catch {
      /* push plugin unavailable — alerts simply won't arrive */
    }
  }

  private async syncTokenToActiveHost(): Promise<void> {
    const host = this.hostStore.activeHost();
    if (!host || !this.apnsToken) {
      return;
    }
    try {
      await this.gateway.registerApnsToken(host.id, this.apnsToken);
    } catch {
      /* will retry on the next host change / token refresh */
    }
  }

  /** Approve/Deny tapped on the notification itself — respond and stay out of the way. */
  private async respondFromAction(
    actionId: 'APPROVE' | 'DENY',
    data: Record<string, unknown>,
  ): Promise<void> {
    const instanceId = typeof data['instanceId'] === 'string' ? data['instanceId'] : '';
    const requestId = typeof data['requestId'] === 'string' ? data['requestId'] : '';
    const hostDeviceId = typeof data['hostDeviceId'] === 'string' ? data['hostDeviceId'] : undefined;
    const host = typeof data['host'] === 'string' ? data['host'] : undefined;
    if (!instanceId || !requestId) return;
    try {
      await this.gateway.respondFromPush(hostDeviceId, host, instanceId, {
        requestId,
        decisionAction: actionId === 'APPROVE' ? 'allow' : 'deny',
        decisionScope: 'once',
      });
      this.haptics.success();
    } catch {
      // Couldn't reach the host (Tailscale down / prompt expired) — fall back
      // to opening the session so the user can act from the approval sheet.
      this.haptics.error();
      void this.handleNotificationTap(data);
    }
  }

  async handleNotificationTap(data: Record<string, unknown>): Promise<void> {
    const instanceId = typeof data['instanceId'] === 'string' ? data['instanceId'] : '';
    if (!instanceId) {
      this.pendingNotificationTap = null;
      await this.router.navigate(['/projects']);
      return;
    }
    this.pendingNotificationTap = data;
    const hostDeviceId = typeof data['hostDeviceId'] === 'string' ? data['hostDeviceId'] : undefined;
    const hostName = typeof data['host'] === 'string' ? data['host'] : undefined;
    const legacyMatches = hostDeviceId || !hostName
      ? []
      : this.hostStore.hosts().filter((host) => host.name.toLowerCase() === hostName.toLowerCase());
    const targetHost = hostDeviceId
      ? this.hostStore.hosts().find((host) => host.id === hostDeviceId)
      : legacyMatches.length === 1
        ? legacyMatches[0]
        : undefined;
    if (!targetHost) {
      this._routingIssue.set('unknown-host');
      return;
    }
    let instances;
    try {
      if (this.hostStore.activeHost()?.id !== targetHost.id) {
        await this.hostStore.setActive(targetHost.id);
      }
      instances = await this.gateway.liveInstances();
    } catch {
      this._routingIssue.set('host-unavailable');
      return;
    }
    const instance = instances.find((item) => item.id === instanceId);
    if (!instance) {
      this._routingIssue.set('ended-session');
      return;
    }
    this._routingIssue.set(null);
    this.pendingNotificationTap = null;
    const key = instance.workingDirectory || '__no_workspace__';
    await this.router.navigate(['/projects', key, 'sessions', instanceId]);
  }

  dismissRoutingIssue(): void {
    this._routingIssue.set(null);
    this.pendingNotificationTap = null;
  }

  async retryNotificationRouting(): Promise<void> {
    const data = this.pendingNotificationTap;
    if (data) await this.handleNotificationTap(data);
  }

  openEndedSessionHistory(): void {
    this._routingIssue.set(null);
    this.pendingNotificationTap = null;
    void this.router.navigate(['/history']);
  }

  openEndedSessionProjects(): void {
    this._routingIssue.set(null);
    this.pendingNotificationTap = null;
    void this.router.navigate(['/projects']);
  }
}
