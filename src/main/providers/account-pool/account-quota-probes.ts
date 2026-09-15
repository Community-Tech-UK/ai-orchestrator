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
 * The legacy profile keeps the existing provider-level probes untouched.
 */

import type { PooledProvider, ProviderAccountProfile } from '../../../shared/types/provider-account.types';
import type { ProviderId, ProviderQuotaSnapshot } from '../../../shared/types/provider-quota.types';
import { resolveAccountProfileHome } from '../../cli/adapters/account-pool/provider-account-home-resolver';
import {
  getProviderQuotaService,
  type ProviderQuotaProbe,
} from '../../core/system/provider-quota-service';
import { ClaudeCredentialsReader } from '../../core/system/provider-quota/claude-credentials-reader';
import { ClaudeUsageEndpointProbe } from '../../core/system/provider-quota/claude-usage-endpoint-probe';
import { getLogger } from '../../logging/logger';
import { codexProbeQuotaSnapshot, probeCodexAccount } from './codex-account-probe';
import { getProviderAccountBindingService } from './provider-account-binding-service';
import { getProviderAccountStore, onProviderAccountsChanged } from './provider-account-store';

const logger = getLogger('AccountQuotaProbes');

/** Matches the idle refresh cadence wired in ipc-main-handler (`startIdleRefresh(60_000)`). */
export const CLAUDE_ACCOUNT_PROBE_BASE_INTERVAL_MS = 60_000;
export const CODEX_ACCOUNT_PROBE_MIN_INTERVAL_MS = 15 * 60_000;

/** Skips a probe cycle (resolves null) until its minimum interval has elapsed. */
export class ThrottledAccountQuotaProbe implements ProviderQuotaProbe {
  readonly provider: ProviderId;
  readonly accountProfileId: string;
  private lastRunAt = 0;

  constructor(
    private readonly inner: ProviderQuotaProbe,
    private readonly minIntervalMs: () => number,
    private readonly now: () => number = Date.now,
  ) {
    this.provider = inner.provider;
    this.accountProfileId = inner.accountProfileId ?? '';
  }

  async probe(opts: { signal: AbortSignal }): Promise<ProviderQuotaSnapshot | null> {
    const now = this.now();
    if (this.lastRunAt > 0 && now - this.lastRunAt < this.minIntervalMs()) return null;
    this.lastRunAt = now;
    return this.inner.probe(opts);
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

function claudeProbeFor(profile: ProviderAccountProfile, profileCount: () => number): ProviderQuotaProbe | null {
  const resolved = resolveAccountProfileHome({ provider: 'claude', profileId: profile.id }, { createIfMissing: false });
  if (resolved.kind !== 'derived') return null;
  return new ThrottledAccountQuotaProbe(
    new ClaudeUsageEndpointProbe({
      accountProfileId: profile.id,
      credentialsReader: new ClaudeCredentialsReader({ configDir: resolved.home }),
    }),
    () => CLAUDE_ACCOUNT_PROBE_BASE_INTERVAL_MS * Math.max(1, profileCount()),
  );
}

export function buildAccountQuotaProbes(provider: PooledProvider, profiles: ProviderAccountProfile[]): ProviderQuotaProbe[] {
  const derived = profiles.filter((profile) => profile.enabled && !profile.isLegacy);
  const count = (): number => profiles.filter((profile) => profile.enabled).length;
  const probes: ProviderQuotaProbe[] = [];
  for (const profile of derived) {
    try {
      const probe = provider === 'claude'
        ? claudeProbeFor(profile, count)
        : new ThrottledAccountQuotaProbe(new CodexAccountQuotaProbe(profile.id), () => CODEX_ACCOUNT_PROBE_MIN_INTERVAL_MS);
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
  for (const provider of ['claude', 'codex'] as const) {
    service.unregisterAccountProbes(provider);
    let profiles: ProviderAccountProfile[] = [];
    try {
      profiles = store.listProfiles(provider);
    } catch {
      profiles = [];
    }
    for (const probe of buildAccountQuotaProbes(provider, profiles)) {
      service.registerProbe(probe);
    }
  }
}

let unsubscribe: (() => void) | null = null;

/** Register per-profile probes now and whenever the pools change. Idempotent. */
export function registerAccountQuotaProbes(): void {
  registerAll();
  unsubscribe ??= onProviderAccountsChanged(registerAll);
}

export function _resetAccountQuotaProbesForTesting(): void {
  unsubscribe?.();
  unsubscribe = null;
}
