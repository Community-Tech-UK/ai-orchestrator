import type { ProviderId, ProviderQuotaSnapshot, ProviderQuotaState } from '../../shared/types/provider-quota.types';
import type { MobileQuotaProviderDto, MobileQuotaStateDto, MobileServerEvent } from '../../shared/types/mobile-gateway.types';
import type { EmitterLike } from './mobile-gateway-events';

export interface GatewayQuotaSource extends EmitterLike {
  getAll(): ProviderQuotaState;
}
const PROVIDERS: readonly ProviderId[] = ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok', 'opencode'];
const FRESH_MS = 5 * 60_000;
const MAX_WINDOWS = 16;
const timestamp = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

function projectProvider(provider: ProviderId, snapshot: ProviderQuotaSnapshot | null, now: number): MobileQuotaProviderDto {
  const updatedAt = timestamp(snapshot?.takenAt);
  const accessAt = timestamp(snapshot?.usageAccess?.observedAt ?? snapshot?.takenAt);
  const validUntil = updatedAt === null ? null : Math.min(updatedAt, accessAt ?? updatedAt) + FRESH_MS;
  const available = snapshot?.ok && !snapshot.needsReauth && !snapshot.cliNotInstalled && !snapshot.notApplicable;
  const freshness = !available || updatedAt === null ? 'unavailable'
    : updatedAt > now || validUntil === null || validUntil <= now ? 'stale' : 'fresh';
  const denied = snapshot?.usageAccess?.ordinaryUsageAllowed === false && snapshot.usageAccess.creditsAvailable === false;
  const windows = (snapshot?.windows ?? []).slice(0, MAX_WINDOWS).map(window => {
    const percent = Number.isFinite(window.limit) && window.limit > 0 && Number.isFinite(window.used) && window.used >= 0
      ? window.used / window.limit * 100 : null;
    const percentUsed = percent !== null && Number.isFinite(percent) ? Math.min(100, Math.round(percent * 10) / 10) : null;
    const resetsAt = timestamp(window.resetsAt);
    return {
      id: window.id.slice(0, 80), label: window.label.slice(0, 80), percentUsed, resetsAt,
      exhausted: freshness === 'fresh' && denied && percent !== null && percent >= 100 && resetsAt !== null && resetsAt > now,
    };
  });
  return { provider, updatedAt, validUntil, freshness, windows, exhausted: windows.some(window => window.exhausted) };
}

/** Owns a bounded, account-free projection and its subscription; never probes. */
export class MobileGatewayQuotaHandlers {
  private source: GatewayQuotaSource | null = null;
  private lastProjection = '';
  private readonly notified = new Map<string, number>();
  private readonly updated = () => this.publish();

  constructor(private readonly deps: {
    getSource(): GatewayQuotaSource;
    broadcast(event: MobileServerEvent): void;
    sendExhaustedPush(): void;
  }) {}

  read(): MobileQuotaStateDto {
    const now = Date.now();
    const state = this.deps.getSource().getAll();
    return { serverTime: now, providers: PROVIDERS.map(provider => projectProvider(provider, state.snapshots[provider], now)) };
  }

  attach(): void {
    if (this.source) return;
    this.source = this.deps.getSource();
    // Existing exhaustion is not a newly exhausted edge at gateway startup.
    const initial = this.read();
    this.lastProjection = JSON.stringify(initial.providers);
    this.recordEdges(initial, false);
    this.source.on('quota-updated', this.updated);
  }

  detach(): void {
    this.source?.removeListener('quota-updated', this.updated);
    this.source = null;
  }

  private publish(): void {
    const state = this.read();
    const signature = JSON.stringify(state.providers);
    if (signature === this.lastProjection) return;
    this.lastProjection = signature;
    this.deps.broadcast({ type: 'quota-state', data: state });
    this.recordEdges(state, true);
  }

  private recordEdges(state: MobileQuotaStateDto, notify: boolean): void {
    for (const provider of state.providers) {
      for (const window of provider.windows) {
        if (window.resetsAt === null) continue;
        const key = JSON.stringify([provider.provider, window.id]);
        const previousReset = this.notified.get(key);
        if (!window.exhausted) {
          // A moving estimate is not a reset. Require a fresh, known recovery
          // in a later window; stale/unknown/access-only changes never rearm.
          if (previousReset !== undefined && provider.freshness === 'fresh' &&
              window.percentUsed !== null && window.percentUsed < 100 &&
              window.resetsAt > previousReset) this.notified.delete(key);
          continue;
        }
        // Keep the edge latched throughout exhaustion, even when a rolling
        // reset estimate slides forward or is corrected backwards.
        if (previousReset !== undefined) continue;
        this.notified.set(key, window.resetsAt);
        if (notify) this.deps.sendExhaustedPush();
      }
    }
  }
}
