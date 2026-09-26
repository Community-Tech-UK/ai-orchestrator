/**
 * CompositeQuotaProbe — layers the optional `~/.usage/state.json` source on top
 * of a native probe while keeping the native poll authoritative.
 *
 * Precedence (per the plan):
 *   1. Run the native probe. If it returns an `ok` snapshot WITH windows, that
 *      is the source of truth — return it untouched.
 *   2. Otherwise (native unavailable, errored, or window-less because the
 *      provider doesn't expose numbers natively yet) fall back to the
 *      standalone monitor's `state.json` if it's present and fresh.
 *   3. If neither has windows, return whatever the native probe gave (so the
 *      chip still shows login/plan state and error reasons).
 *
 * This is a pure enhancement: with no `state.json` on disk it behaves exactly
 * like the wrapped native probe.
 */

import type {
  ProviderId,
  ProviderQuotaSnapshot,
} from '../../../../shared/types/provider-quota.types';
import type { ProviderQuotaProbe } from '../provider-quota-service';
import { UsageMonitorSource } from './usage-monitor-source';

export class CompositeQuotaProbe implements ProviderQuotaProbe {
  readonly provider: ProviderId;
  readonly accountProfileId?: string;
  readonly silenceAlerts?: boolean;

  constructor(
    private readonly native: ProviderQuotaProbe,
    private readonly source: Pick<UsageMonitorSource, 'readProvider'> = new UsageMonitorSource(),
  ) {
    this.provider = native.provider;
    this.accountProfileId = native.accountProfileId;
    this.silenceAlerts = native.silenceAlerts;
  }

  async probe(opts: { signal: AbortSignal; force?: boolean }): Promise<ProviderQuotaSnapshot | null> {
    const nativeSnap = await this.native.probe(opts);

    // Native poll is the source of truth when it has real windows.
    if (nativeSnap && nativeSnap.ok && nativeSnap.windows.length > 0) {
      return nativeSnap;
    }

    // Fall back to the standalone monitor for providers the native poll can't
    // populate yet. Best-effort: any failure leaves the native snapshot.
    let fallback: ProviderQuotaSnapshot | null = null;
    try {
      fallback = await this.source.readProvider(this.provider, this.accountProfileId);
    } catch {
      fallback = null;
    }
    if (fallback && fallback.windows.length > 0) {
      // Last-known monitor bars replace a window-less native result. Keep the
      // bars, but carry the native probe's reauth verdict onto them: showing
      // another snapshot's numbers as current while the login that produced
      // the source is expired is exactly the silent staleness this composite
      // must not create (the chip renders "X% ⚠" plus a reauth row from it).
      // An ordinary failure (network, shape change) stays silent — the bars
      // speak for themselves and no login needs attention.
      const merged = this.accountProfileId
        ? { ...fallback, accountProfileId: this.accountProfileId }
        : fallback;
      return nativeSnap?.needsReauth
        ? { ...merged, needsReauth: true, ...(nativeSnap.error ? { error: nativeSnap.error } : {}) }
        : merged;
    }

    return nativeSnap;
  }
}
