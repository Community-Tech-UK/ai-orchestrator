import { getClaudeCacheLifetime } from '../cli/adapters/claude-cache-lifetime';

/**
 * The cache lifetime a loop iteration's adapter has measured, as a spread-ready
 * fragment for `LoopChildResult`. Empty when the adapter is not a Claude adapter
 * or no reply has reported its cache writes yet; the survival rules then assume one hour.
 */
export function loopCacheLifetimeFields(adapter: unknown): { cacheLifetimeMs?: number } {
  if (typeof adapter !== 'object' || adapter === null) return {};
  const lifetime = getClaudeCacheLifetime(adapter);
  return lifetime ? { cacheLifetimeMs: lifetime.lifetimeMs } : {};
}
