/**
 * Active quota probes for non-legacy account-pool profiles (spec §10).
 *
 * - Claude (decision D6): the existing `/api/oauth/usage` probe, reading the
 *   profile's own Keychain item / `.credentials.json` read-only. Each account's
 *   probe runs at most once per (idle cadence × profile count), so adding
 *   accounts does not multiply the polling.
 * - Codex (decision D7): a short-lived `codex app-server` per profile answering
 *   `account/rateLimits/read` (and `account/read`, which also records the
 *   observed identity for the binding check). At most every 15 minutes per
 *   profile; live instances keep it fresh passively in between.
 *
 * Disabled profiles are probed as well: disabling only takes an account out of
 * routing, and the quota chip still shows it.
 *
 * The legacy profile keeps the existing provider-level probes untouched.
 */

import { POOLED_PROVIDERS, type PooledProvider, type ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import type { ProviderId, ProviderQuotaSnapshot } from '../../../shared/types/provider-quota.types';
import { resolveAccountProfileHome } from '../../cli/adapters/account-pool/provider-account-home-resolver';
import {
  getProviderQuotaService,
  type ProviderQuotaProbe,
} from '../../core/system/provider-quota-service';
import { ClaudeCredentialsReader } from '../../core/system/provider-quota/claude-credentials-reader';
import { ClaudeUsageEndpointProbe } from '../../core/system/provider-quota/claude-usage-endpoint-probe';
import { CompositeQuotaProbe } from '../../core/system/provider-quota/composite-quota-probe';
import { MimoConsoleCredentialsReader } from '../../core/system/provider-quota/mimo-console-credentials-reader';
import { MimoTokenPlanProbe } from '../../core/system/provider-quota/mimo-token-plan-probe';
import { UsageMonitorSource } from '../../core/system/provider-quota/usage-monitor-source';
import { getLogger } from '../../logging/logger';
import { codexProbeQuotaSnapshot, probeCodexAccount } from './codex-account-probe';
import { getProviderAccountBindingService } from './provider-account-binding-service';
import { getProviderAccountStore, onProviderAccountsChanged } from './provider-account-store';

const logger = getLogger('AccountQuotaProbes');

/** Matches the idle refresh cadence wired in ipc-main-handler (`startIdleRefresh(60_000)`). */
export const CLAUDE_ACCOUNT_PROBE_BASE_INTERVAL_MS = 60_000;
export const CODEX_ACCOUNT_PROBE_MIN_INTERVAL_MS = 15 * 60_000;
/** MiMo console reads are browser-session calls; match the Codex cadence. */
export const MIMO_ACCOUNT_PROBE_MIN_INTERVAL_MS = 15 * 60_000;

/** Skips a probe cycle (resolves null) until its minimum interval has elapsed. */
export class ThrottledAccountQuotaProbe implements ProviderQuotaProbe {
  readonly provider: ProviderId;
  readonly accountProfileId: string;
  readonly silenceAlerts: boolean;
  readonly quotaSource?: string;
  private lastRunAt = 0;

  constructor(
    private readonly inner: ProviderQuotaProbe,
    private readonly minIntervalMs: () => number,
    private readonly now: () => number = Date.now,
    silenceAlerts = false,
  ) {
    this.provider = inner.provider;
    this.accountProfileId = inner.accountProfileId ?? '';
    this.silenceAlerts = silenceAlerts;
    this.quotaSource = inner.quotaSource;
  }

  async probe(opts: { signal: AbortSignal; force?: boolean }): Promise<ProviderQuotaSnapshot | null> {
    const now = this.now();
    if (!opts.force && this.lastRunAt > 0 && now - this.lastRunAt < this.minIntervalMs()) {
      return null;
    }
    // Stamp at entry so overlapping refreshes stay serialized within the
    // window; a thrown attempt resets it so the service's retryWithBackoff can
    // retry immediately instead of being throttled into a silent null.
    this.lastRunAt = now;
    try {
      return await this.inner.probe(opts);
    } catch (err) {
      this.lastRunAt = 0;
      throw err;
    }
  }
}

class CodexAccountQuotaProbe implements ProviderQuotaProbe {
  readonly provider = 'codex' as const;

  constructor(readonly accountProfileId: string) {}

  async probe(): Promise<ProviderQuotaSnapshot | null> {
    const resolved = resolveAccountProfileHome({ provider: 'codex', profileId: this.accountProfileId }, { createIfMissing: false });
    if (resolved.kind !== 'derived') return null;
    const result = await probeCodexAccount(resolved.home);
    if (result.identity.email) {
      getProviderAccountBindingService().rememberObservedIdentity('codex', this.accountProfileId, {
        identity: result.identity.email,
        accountKey: result.identity.accountId,
        planLabel: result.identity.planType,
      });
    }
    const snapshot = codexProbeQuotaSnapshot(result);
    return snapshot ? { ...snapshot, takenAt: Date.now(), source: 'admin-api' } : null;
  }
}

/**
 * MiMo per-account allowance (Decision 8): the Token Plan console probe,
 * reading the MiMo console sign-in from the Chrome profile this account names
 * (only an explicit association, including `Default`). The legacy account keeps the provider-level probe and
 * the token-usage-monitor fallback untouched; this probe is silent while a
 * Chrome profile holds no MiMo console sign-in (an `ok: false`, "no allowance
 * data" snapshot — never numbers).
 */
class MimoAccountQuotaProbe implements ProviderQuotaProbe {
  readonly provider = 'opencode' as const;

  constructor(
    readonly accountProfileId: string,
    readonly quotaSource: string,
    private readonly inner: MimoTokenPlanProbe | null,
  ) {}

  async probe(opts: { signal: AbortSignal; force?: boolean }): Promise<ProviderQuotaSnapshot | null> {
    if (!this.inner) return {
      provider: 'opencode', takenAt: Date.now(), source: 'admin-api', ok: false,
      notApplicable: true, windows: [], error: 'No Chrome profile associated with this account',
    };
    return this.inner.probe(opts);
  }
}

function mimoProbeFor(profile: ProviderAccountProfile): ProviderQuotaProbe {
  return new ThrottledAccountQuotaProbe(
    new MimoAccountQuotaProbe(profile.id, profile.chromeProfile ?? '', profile.chromeProfile ? new MimoTokenPlanProbe({
      // The account IS a Token Plan account: unlike the legacy global probe
      // there is no configured-model gate to apply here.
      isTokenPlanModel: () => true,
      reader: new MimoConsoleCredentialsReader(
        { chromeProfile: profile.chromeProfile },
      ),
    }) : null),
    () => MIMO_ACCOUNT_PROBE_MIN_INTERVAL_MS,
    Date.now,
    !profile.enabled,
  );
}

function claudeProbeFor(
  profile: ProviderAccountProfile,
  profileCount: () => number,
  usageMonitor: Pick<UsageMonitorSource, 'readProvider'>,
): ProviderQuotaProbe | null {
  const resolved = resolveAccountProfileHome({ provider: 'claude', profileId: profile.id }, { createIfMissing: false });
  if (resolved.kind !== 'derived') return null;
  return new ThrottledAccountQuotaProbe(
    new CompositeQuotaProbe(
      new ClaudeUsageEndpointProbe({
        accountProfileId: profile.id,
        credentialsReader: new ClaudeCredentialsReader({ configDir: resolved.home }),
      }),
      usageMonitor,
    ),
    () => CLAUDE_ACCOUNT_PROBE_BASE_INTERVAL_MS * Math.max(1, profileCount()),
    Date.now,
    !profile.enabled,
  );
}

export function buildAccountQuotaProbes(
  provider: PooledProvider,
  profiles: ProviderAccountProfile[],
  usageMonitor: Pick<UsageMonitorSource, 'readProvider'> = new UsageMonitorSource(),
): ProviderQuotaProbe[] {
  // A disabled profile is only out of routing and failover; it is still signed
  // in, and its quota is what you check before re-enabling it. So it is probed
  // too (counted in the Claude cadence so it does not add polling), but its
  // probe silences quota alerts: nobody is using it, so it must not notify.
  const derived = profiles.filter((profile) => !profile.isLegacy);
  const count = (): number => profiles.length;
  const probes: ProviderQuotaProbe[] = [];
  for (const profile of derived) {
    try {
      const probe = provider === 'claude'
        ? claudeProbeFor(profile, count, usageMonitor)
        : provider === 'opencode'
          ? mimoProbeFor(profile)
          : new ThrottledAccountQuotaProbe(
            new CompositeQuotaProbe(new CodexAccountQuotaProbe(profile.id), usageMonitor),
            () => CODEX_ACCOUNT_PROBE_MIN_INTERVAL_MS,
            Date.now,
            !profile.enabled,
          );
      if (probe) probes.push(probe);
    } catch (error) {
      logger.warn('Could not build an account quota probe', {
        provider,
        profileId: profile.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return probes;
}

function registerAll(): void {
  const service = getProviderQuotaService();
  let store;
  try {
    store = getProviderAccountStore();
  } catch {
    return;
  }
  for (const provider of POOLED_PROVIDERS) {
    let profiles: ProviderAccountProfile[] = [];
    try {
      profiles = store.listProfiles(provider);
    } catch {
      profiles = [];
    }
    const built = buildAccountQuotaProbes(provider, profiles, monitorSource);
    service.replaceAccountProbes(provider, built);
  }
}

let unsubscribe: (() => void) | null = null;
let monitorSource: Pick<UsageMonitorSource, 'readProvider'> | undefined;

/** Register per-profile probes now and whenever the pools change. Idempotent. */
export function registerAccountQuotaProbes(
  source?: Pick<UsageMonitorSource, 'readProvider'>,
): void {
  if (source) monitorSource = source;
  registerAll();
  unsubscribe ??= onProviderAccountsChanged(registerAll);
}

export function _resetAccountQuotaProbesForTesting(): void {
  unsubscribe?.();
  unsubscribe = null;
  monitorSource = undefined;
}
