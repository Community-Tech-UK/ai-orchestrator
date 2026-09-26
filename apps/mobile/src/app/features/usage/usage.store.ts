import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import type { MobileQuotaProviderDto, MobileQuotaStateDto } from '../../core/models';

@Injectable({ providedIn: 'root' })
export class UsageStore {
  private readonly gateway = inject(GatewayClient);
  private readonly hosts = inject(HostStore);
  private readonly value = signal<{ hostId: string; data: MobileQuotaStateDto; receivedAt: number } | null>(null);
  private readonly now = signal(Date.now());
  private readonly loadState = signal<'loading' | 'loaded' | 'error'>('loading');
  private generation = 0;
  private readonly destroyed = inject(DestroyRef);
  readonly online = this.gateway.online;
  readonly hostName = computed(() => this.hosts.activeHost()?.name ?? 'Host');
  readonly status = this.loadState.asReadonly();
  readonly providers = computed<MobileQuotaProviderDto[]>(() => {
    const value = this.value();
    if (!value || value.hostId !== this.hosts.activeHost()?.id || value.hostId !== this.gateway.dataHostId()) return [];
    // Use elapsed phone time plus server time, avoiding phone/host clock skew.
    const now = value.data.serverTime + Math.max(0, this.now() - value.receivedAt);
    return value.data.providers.map(provider => {
      const fresh = this.online() && provider.freshness === 'fresh' && provider.validUntil !== null && provider.validUntil > now;
      const windows = provider.windows.map(window => ({ ...window,
        exhausted: fresh && window.exhausted && window.resetsAt !== null && window.resetsAt > now,
      }));
      return { ...provider, windows,
        freshness: provider.freshness === 'unavailable' ? 'unavailable' : fresh ? 'fresh' : 'stale',
        exhausted: windows.some(window => window.exhausted),
      };
    });
  });

  constructor() {
    const timer = setInterval(() => this.now.set(Date.now()), 1000);
    this.destroyed.onDestroy(() => { clearInterval(timer); this.generation++; });
    effect(() => {
      const host = this.hosts.activeHost();
      const ready = this.online() && this.gateway.dataHostId() === host?.id;
      untracked(() => {
        this.generation++;
        if (this.value()?.hostId !== host?.id) this.value.set(null);
        if (host && ready) void this.refresh();
      });
    });
    effect(() => {
      const event = this.gateway.quotaEvent();
      untracked(() => {
        if (!event || event.hostId !== this.hosts.activeHost()?.id || !this.online()) return;
        this.generation++;
        this.accept(event.hostId, event.data);
      });
    });
  }

  isExhausted(provider: string): boolean { return this.providers().some(item => item.provider === provider && item.exhausted); }

  async refresh(): Promise<void> {
    const host = this.hosts.activeHost();
    if (!host || !this.online()) return;
    const generation = ++this.generation;
    const current = () => !this.destroyed.destroyed && generation === this.generation && host === this.hosts.activeHost() && this.online();
    this.loadState.set('loading');
    try {
      const data = await this.gateway.quota();
      if (current()) this.accept(host.id, data);
    } catch {
      if (current()) { this.value.set(null); this.loadState.set('error'); }
    }
  }

  private accept(hostId: string, data: MobileQuotaStateDto): void {
    this.now.set(Date.now());
    this.value.set({ hostId, data, receivedAt: Date.now() });
    this.loadState.set('loaded');
  }
}
