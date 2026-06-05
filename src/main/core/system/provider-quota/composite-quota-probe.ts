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

  constructor(
    private readonly native: ProviderQuotaProbe,
    private readonly source: Pick<UsageMonitorSource, 'readProvider'> = new UsageMonitorSource(),
  ) {
    this.provider = native.provider;
  }

  async probe(opts: { signal: AbortSignal }): Promise<ProviderQuotaSnapshot | null> {
    const nativeSnap = await this.native.probe(opts);

    // Native poll is the source of truth when it has real windows.
    if (nativeSnap && nativeSnap.ok && nativeSnap.windows.length > 0) {
      return nativeSnap;
    }

    // Fall back to the standalone monitor for providers the native poll can't
    // populate yet. Best-effort: any failure leaves the native snapshot.
    let fallback: ProviderQuotaSnapshot | null = null;
    try {
      fallback = await this.source.readProvider(this.provider);
    } catch {
      fallback = null;
    }
    if (fallback && fallback.windows.length > 0) {
      return fallback;
    }

    return nativeSnap;
  }
}
