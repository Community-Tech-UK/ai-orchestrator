import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import type { MobileQuotaAccountDto, MobileQuotaProviderDto, MobileQuotaStateDto } from '../../core/models';

export interface UsageAccountView extends MobileQuotaAccountDto {
  /** The account's one-number summary, or null when no window has a known percentage. */
  readonly headlinePercent: number | null;
}

export interface UsageProviderView extends MobileQuotaProviderDto {
  readonly accounts: UsageAccountView[];
}

type UsageEvidence = Pick<MobileQuotaAccountDto, 'freshness' | 'validUntil' | 'windows' | 'exhausted'>;

/** Re-ages host evidence with phone-elapsed time; exhaustion needs fresh, unexpired evidence. */
function current<T extends UsageEvidence>(item: T, now: number, online: boolean): T {
  const fresh = online && item.freshness === 'fresh' && item.validUntil !== null && item.validUntil > now;
  const windows = item.windows.map(window => ({ ...window,
    exhausted: fresh && window.exhausted && window.resetsAt !== null && window.resetsAt > now,
  }));
  return { ...item, windows,
    freshness: item.freshness === 'unavailable' ? 'unavailable' : fresh ? 'fresh' : 'stale',
    exhausted: windows.some(window => window.exhausted),
  };
}

function headlinePercent(account: MobileQuotaAccountDto): number | null {
  const chosen = account.windows.find(window => window.id === account.summaryWindowId && window.percentUsed !== null);
  if (chosen) return chosen.percentUsed;
  const known = account.windows.flatMap(window => window.percentUsed === null ? [] : [window.percentUsed]);
  return known.length ? Math.max(...known) : null;
}

/** Hosts built before account usage send only the existing sign-in, at provider level. */
function accountsOf(provider: MobileQuotaProviderDto): MobileQuotaAccountDto[] {
  if (provider.accounts?.length) return provider.accounts;
  const { freshness, updatedAt, validUntil, exhausted, windows } = provider;
  return [{ id: 'legacy', label: null, freshness, updatedAt, validUntil, exhausted, windows }];
}

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
  readonly providers = computed<UsageProviderView[]>(() => {
    const value = this.value();
    if (!value || value.hostId !== this.hosts.activeHost()?.id || value.hostId !== this.gateway.dataHostId()) return [];
    // Use elapsed phone time plus server time, avoiding phone/host clock skew.
    const now = value.data.serverTime + Math.max(0, this.now() - value.receivedAt);
    const online = this.online();
    return value.data.providers.map(provider => {
      const accounts = accountsOf(provider).map(account => {
        const aged = current(account, now, online);
        return { ...aged, headlinePercent: headlinePercent(aged) };
      });
      // Harness moves work to another account when one runs out, so a
      // provider is only out of usage once every account it may use is.
      const usable = accounts.filter(account => !account.disabled);
      return { ...current(provider, now, online), accounts,
        exhausted: usable.length > 0 && usable.every(account => account.exhausted),
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
