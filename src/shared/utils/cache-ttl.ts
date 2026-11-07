import type { CopilotModelCache } from '../types/cost-session.types';
import type { BillingMode } from './billing-mode';
export function resolveCacheTtlMs(instance: { provider: string; currentModel?: string }, billingMode: BillingMode,
  copilotCache: readonly CopilotModelCache[] = []): number | undefined {
  if (instance.provider === 'claude') return billingMode === 'plan' ? 60 * 60_000 : billingMode === 'api' ? 5 * 60_000 : undefined;
  if (instance.provider === 'copilot') {
    const cache = copilotCache.find(item => item.modelId === instance.currentModel);
    return cache && cache.ttlSeconds > 0 ? cache.ttlSeconds * 1000 : undefined;
  }
  return undefined;
}
