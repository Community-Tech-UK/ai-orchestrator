import type { ProviderContextEvent } from '@contracts/types/provider-runtime-events';

/** Measured counters. Absent premiumRequests means unavailable, never zero. */
export type CopilotNumericUsage = NonNullable<ProviderContextEvent['copilotUsage']>;

export function copilotNeedsContextRecycle(usage: CopilotNumericUsage | undefined): boolean {
  return !!usage && usage.compactions > 0 && typeof usage.postCompactionTokens === 'number'
    && Number.isFinite(usage.postCompactionTokens) && usage.postCompactionTokens >= 0
    && typeof usage.tokenLimit === 'number' && Number.isFinite(usage.tokenLimit) && usage.tokenLimit > 0
    && usage.postCompactionTokens / usage.tokenLimit > 0.9;
}
