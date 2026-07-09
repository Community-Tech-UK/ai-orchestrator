import { Injectable, effect, inject } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { GatewayClient } from './gateway-client.service';
import { HostStore } from './host-store';
import { isLiveActivityCandidate, liveActivityStatusLabel, needsAttention } from './status';
import type { MobileInstanceDto } from './models';

interface LiveActivityPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  start(options: {
    instanceId: string;
    sessionName: string;
    projectName: string;
    status: string;
    detail: string;
  }): Promise<{ id?: string }>;
  update(options: { status: string; detail: string }): Promise<void>;
  end(): Promise<void>;
  addListener(
    eventName: 'activityPushToken',
    listenerFunc: (data: { instanceId: string; token: string }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

const LiveActivity = registerPlugin<LiveActivityPlugin>('LiveActivity');

interface ActivityState {
  instanceId: string;
  status: string;
  detail: string;
}

/**
 * Drives the lock-screen Live Activity for the "hero" session — the busiest /
 * most-recently-active session that's working or waiting on the user. While
 * the app runs it updates the activity directly; the per-activity APNs push
 * token is forwarded to the Mac gateway so status changes keep the lock
 * screen fresh after iOS suspends the app.
 *
 * Requires the HarnessWidgets extension (docs/mobile-app/
 * live-activities-setup.md); until that target exists the plugin rejects and
 * this service disables itself silently.
 */
@Injectable({ providedIn: 'root' })
export class LiveActivityService {
  private readonly gateway = inject(GatewayClient);
  private readonly hostStore = inject(HostStore);

  private enabled = false;
  private current: ActivityState | null = null;
  private busy = false;

  constructor() {
    // Created here (constructor = injection context); inert until init()
    // flips `enabled` after the plugin probe succeeds.
    effect(() => {
      const instances = this.gateway.snapshot()?.instances ?? [];
      if (this.enabled) void this.reconcile(instances);
    });
  }

  async init(): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    try {
      const { available } = await LiveActivity.isAvailable();
      if (!available) return;
      await LiveActivity.addListener('activityPushToken', ({ instanceId, token }) => {
        void this.registerToken(instanceId, token);
      });
      this.enabled = true;
      void this.reconcile(this.gateway.snapshot()?.instances ?? []);
    } catch {
      // Plugin missing (widget target not added yet) — stay disabled.
    }
  }

  /** Pick the session worth a lock-screen presence, if any. */
  private hero(instances: MobileInstanceDto[]): MobileInstanceDto | null {
    const candidates = instances
      .filter(isLiveActivityCandidate)
      .sort((a, b) => {
        // Needs-you beats working; then most recent activity.
        const attention = Number(needsAttention(b.status)) - Number(needsAttention(a.status));
        if (attention !== 0) return attention;
        return b.lastActivity - a.lastActivity;
      });
    return candidates[0] ?? null;
  }

  private statusLabel(instance: MobileInstanceDto): string {
    return liveActivityStatusLabel(instance);
  }

  private async reconcile(instances: MobileInstanceDto[]): Promise<void> {
    if (this.busy) return; // effects re-fire on the next snapshot anyway
    this.busy = true;
    try {
      const hero = this.hero(instances);
      if (!hero) {
        if (this.current) {
          this.current = null;
          await LiveActivity.end();
        }
        return;
      }
      const next: ActivityState = {
        instanceId: hero.id,
        status: this.statusLabel(hero),
        detail: hero.projectName || '',
      };
      if (!this.current || this.current.instanceId !== next.instanceId) {
        this.current = next;
        await LiveActivity.start({
          instanceId: hero.id,
          sessionName: hero.displayName,
          projectName: hero.projectName || '',
          status: next.status,
          detail: next.detail,
        });
      } else if (this.current.status !== next.status || this.current.detail !== next.detail) {
        this.current = next;
        await LiveActivity.update({ status: next.status, detail: next.detail });
      }
    } catch {
      /* ActivityKit denied (user setting) or transient failure — retry on next change */
    } finally {
      this.busy = false;
    }
  }

  private async registerToken(instanceId: string, token: string): Promise<void> {
    const host = this.hostStore.activeHost();
    if (!host) return;
    try {
      await this.gateway.registerLiveActivityToken(host.id, instanceId, token);
    } catch {
      /* gateway offline — the in-app updates still work */
    }
  }
}
