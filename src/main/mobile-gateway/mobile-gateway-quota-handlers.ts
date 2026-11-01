import type { ProviderId, ProviderQuotaSnapshot, ProviderQuotaState } from '../../shared/types/provider-quota.types';
import type {
  MobileQuotaAccountDto,
  MobileQuotaProviderDto,
  MobileQuotaStateDto,
  MobileServerEvent,
} from '../../shared/types/mobile-gateway.types';
import {
  quotaAccountSections,
  quotaSummaryWindow,
  type QuotaAccountProfile,
} from '../../shared/utils/provider-quota-account-sections';
import type { ServerResponse } from 'http';
import { sendJsonResponse } from './mobile-gateway-http-utils';
import type { EmitterLike } from './mobile-gateway-events';

export interface GatewayQuotaSource extends EmitterLike {
  getAll(): ProviderQuotaState;
}
const PROVIDERS: readonly ProviderId[] = ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor', 'grok', 'opencode'];
const FRESH_MS = 5 * 60_000;
const MAX_WINDOWS = 16;
const MAX_ACCOUNTS = 16;
const timestamp = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

type UsageProjection = Omit<MobileQuotaAccountDto, 'id' | 'label' | 'disabled'>;

function projectUsage(snapshot: ProviderQuotaSnapshot | null, now: number): UsageProjection {
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
  const summary = snapshot ? quotaSummaryWindow(snapshot) : null;
  return {
    updatedAt, validUntil, freshness, windows, exhausted: windows.some(window => window.exhausted),
    ...(summary ? { summaryWindowId: summary.id.slice(0, 80) } : {}),
    ...(snapshot?.plan ? { plan: snapshot.plan.slice(0, 40) } : {}),
    ...(snapshot?.needsReauth ? { needsReauth: true as const } : {}),
  };
}

/** An account Harness can move work onto: switched on and signed in. */
function isUsable(account: MobileQuotaAccountDto): boolean {
  return !account.disabled && !account.needsReauth;
}

/**
 * Null when the desktop quota chip would hide the provider too: CLI not
 * installed, quota not applicable, or nothing ever measured.
 */
function projectProvider(
  provider: ProviderId,
  state: ProviderQuotaState,
  profiles: readonly QuotaAccountProfile[] | null,
  now: number,
): MobileQuotaProviderDto | null {
  const snapshot = state.snapshots[provider];
  if (snapshot?.cliNotInstalled || snapshot?.notApplicable) return null;
  const sections = quotaAccountSections(provider, snapshot, state.accountSnapshots ?? [], profiles);
  if (sections.length === 0) return null;
  // The provider-level fields keep describing the existing sign-in, as older phone builds expect.
  const { updatedAt, validUntil, freshness, windows, exhausted } = projectUsage(snapshot, now);
  return {
    provider, updatedAt, validUntil, freshness, windows, exhausted,
    accounts: sections.slice(0, MAX_ACCOUNTS).map(section => ({
      id: section.id.slice(0, 80),
      label: section.label?.slice(0, 80) ?? null,
      ...(profiles?.find(profile => profile.id === section.id)?.enabled === false ? { disabled: true as const } : {}),
      ...projectUsage(section.snapshot, now),
    })),
  };
}

/**
 * Owns a bounded projection and its subscription; never probes. Accounts carry
 * only the operator's own names for them and their plan, never sign-in
 * identities, probe errors or credentials.
 */
export class MobileGatewayQuotaHandlers {
  private source: GatewayQuotaSource | null = null;
  private lastProjection = '';
  private readonly notified = new Map<string, number>();
  private readonly updated = () => this.publish();

  constructor(private readonly deps: {
    getSource(): GatewayQuotaSource;
    /** Account-pool profiles, for account names and order. */
    getAccountProfiles(): readonly QuotaAccountProfile[];
    broadcast(event: MobileServerEvent): void;
    sendExhaustedPush(): void;
  }) {}

  read(): MobileQuotaStateDto {
    const now = Date.now();
    const state = this.deps.getSource().getAll();
    const profiles = this.accountProfiles();
    return {
      serverTime: now,
      providers: PROVIDERS.flatMap(provider => projectProvider(provider, state, profiles, now) ?? []),
    };
  }

  private accountProfiles(): readonly QuotaAccountProfile[] | null {
    // Settings can be unreadable (as quota probing also allows); unknown
    // profiles still show every account, named by its profile id.
    try {
      return this.deps.getAccountProfiles();
    } catch {
      return null;
    }
  }

  /** GET /api/quota. Returns false when the request is not this route. */
  handle(res: ServerResponse, segments: string[], method: string): boolean {
    if (segments[1] !== 'quota' || segments.length !== 2 || method !== 'GET') return false;
    sendJsonResponse(res, 200, this.read());
    return true;
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
      const accounts = provider.accounts ?? [];
      let newlyExhausted = false;
      for (const account of accounts) {
        for (const window of account.windows) {
          if (window.resetsAt === null) continue;
          const key = this.edgeKey(provider.provider, account.id, window.id);
          const previousReset = this.notified.get(key);
          if (!window.exhausted) {
            // A moving estimate is not a reset. Require a fresh, known recovery
            // in a later window; stale/unknown/access-only changes never rearm.
            if (previousReset !== undefined && account.freshness === 'fresh' &&
                window.percentUsed !== null && window.percentUsed < 100 &&
                window.resetsAt > previousReset) this.notified.delete(key);
            continue;
          }
          // Keep the edge latched throughout exhaustion, even when a rolling
          // reset estimate slides forward or is corrected backwards.
          if (previousReset !== undefined) continue;
          this.notified.set(key, window.resetsAt);
          if (isUsable(account)) newlyExhausted = true;
        }
      }
      // Harness moves work to another account when one runs out, so only a
      // provider with no usable account left is worth a push. A fresh reading
      // is authoritative; extra accounts are probed less often than evidence
      // stays fresh, so a stale one counts as out until its latched reset.
      const usable = accounts.filter(isUsable);
      const outOfUsage = usable.length > 0 && usable.every(account => account.windows.some(window => {
        if (window.exhausted || account.freshness === 'fresh') return window.exhausted;
        const latchedReset = this.notified.get(this.edgeKey(provider.provider, account.id, window.id));
        return latchedReset !== undefined && latchedReset > state.serverTime;
      }));
      if (notify && newlyExhausted && outOfUsage) this.deps.sendExhaustedPush();
    }
  }

  private edgeKey(provider: string, accountId: string, windowId: string): string {
    return JSON.stringify([provider, accountId, windowId]);
  }
}
