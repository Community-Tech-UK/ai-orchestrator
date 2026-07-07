import type { ProviderId, ProviderQuotaSnapshot } from '../../../../shared/types/provider-quota.types';
import type { ProviderQuotaProbe } from '../provider-quota-service';

export interface FallbackQuotaProbeOptions {
  /**
   * Preserve a primary probe's reauth flag when falling back to a cheaper
   * login-state probe. Disable only when the primary is known to read an older
   * credential surface than the fallback.
   */
  propagatePrimaryReauth?: boolean;
}

/**
 * Runs a percentage-producing primary probe first, then falls back to a cheaper
 * login/config probe when the primary cannot produce usable windows.
 */
export class FallbackQuotaProbe implements ProviderQuotaProbe {
  readonly provider: ProviderId;

  constructor(
    private readonly primary: ProviderQuotaProbe,
    private readonly fallback: ProviderQuotaProbe,
    private readonly options: FallbackQuotaProbeOptions = {},
  ) {
    this.provider = primary.provider;
  }

  async probe(opts: { signal: AbortSignal }): Promise<ProviderQuotaSnapshot | null> {
    const primarySnapshot = await this.primary.probe(opts);
    if (primarySnapshot && primarySnapshot.ok && primarySnapshot.windows.length > 0) {
      return primarySnapshot;
    }

    const fallbackSnapshot = await this.fallback.probe(opts);
    if (!fallbackSnapshot) return primarySnapshot;

    // The cheaper fallback (e.g. local login-state check) may report "signed in"
    // even when the primary could not refresh its quota token. Don't let that
    // mask an actionable reauth need surfaced by the primary.
    if (this.options.propagatePrimaryReauth !== false && primarySnapshot?.needsReauth && !fallbackSnapshot.needsReauth) {
      return { ...fallbackSnapshot, needsReauth: true };
    }
    return fallbackSnapshot;
  }
}
