/**
 * Quota auto-refresh
 *
 * Wires CLI adapter lifecycle events to `ProviderQuotaService.refresh()` so
 * the chip stays current as the user actually uses each provider — without
 * the renderer having to drive polling manually.
 *
 * Currently triggers on:
 *   • `'spawned'` — first-time spawn populates the chip the moment the user
 *     starts using a provider.
 *   • `'complete'` — refreshes after every turn, debounced.
 *
 * Calls are debounced per (provider, event-class) so reconnects, retries
 * and rapid-fire turns don't fan out into N probe spawns.
 *
 * Currently-installed probes return stable data (login state + plan tier
 * don't change between turns), so this is mostly forward-looking: the day a
 * CLI exposes numerical remainders, this hook is what keeps the chip honest.
 */

import type { EventEmitter } from 'events';
import type { ProviderId } from '../../../../shared/types/provider-quota.types';
import type { ProviderType } from '../../../../shared/types/provider.types';
import { getProviderQuotaService } from '../provider-quota-service';
import { getLogger } from '../../../logging/logger';

const logger = getLogger('QuotaAutoRefresh');

const DEFAULT_DEBOUNCE_MS = 60_000;

/** Minimum API surface this module needs from a CLI adapter. */
type AdapterEvents = Pick<EventEmitter, 'on' | 'off'>;

/** Map a `ProviderType` (broad) to a `ProviderId` (the four we model). */
export function mapProviderTypeToQuotaId(type: ProviderType): ProviderId | null {
  switch (type) {
    case 'claude-cli':
    case 'anthropic-api':
      return 'claude';
    case 'openai':
    case 'openai-compatible':
      // The Codex CLI provider declares itself as openai/openai-compatible.
      // Other openai-compatible providers (raw API, ollama, etc.) don't have
      // a quota probe — caller can short-circuit by not invoking this hook.
      return 'codex';
    case 'google':
      return 'gemini';
    case 'copilot':
      return 'copilot';
    case 'ollama':
    case 'amazon-bedrock':
    case 'azure':
    case 'cursor':
      return null;
  }
}

export interface QuotaAutoRefreshOptions {
  /**
   * Debounce window in ms. Within this window per (provider, eventClass),
   * additional triggers are coalesced to a single refresh. Default: 60s.
   */
  debounceMs?: number;
  /**
   * Override for the singleton service. Tests inject a fake; production
   * code should leave undefined.
   */
  service?: { refresh(provider: ProviderId): Promise<unknown> };
}

/** Last-fire timestamps shared across all attachments for one provider. */
const lastFireByKey = new Map<string, number>();

/**
 * Attach quota auto-refresh to an adapter. Returns a teardown function.
 *
 * If `providerId` is null, this is a no-op — caller can pass the result of
 * `mapProviderTypeToQuotaId(...)` directly without checking.
 */
export function attachQuotaAutoRefresh(
  adapter: AdapterEvents,
  providerId: ProviderId | null,
  options: QuotaAutoRefreshOptions = {},
): () => void {
  if (!providerId) return () => { /* no-op */ };

  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const service = options.service ?? getProviderQuotaService();

  const fire = (eventClass: 'spawned' | 'complete') => {
    const key = `${providerId}:${eventClass}`;
    const last = lastFireByKey.get(key) ?? 0;
    const now = Date.now();
    if (now - last < debounceMs) return;
    lastFireByKey.set(key, now);
    service.refresh(providerId).catch((err) => {
      logger.debug(`Quota refresh after ${eventClass} failed for ${providerId}: ${(err as Error).message}`);
    });
  };

  const onSpawned = () => fire('spawned');
  const onComplete = () => fire('complete');

  adapter.on('spawned', onSpawned);
  adapter.on('complete', onComplete);

  return () => {
    adapter.off('spawned', onSpawned);
    adapter.off('complete', onComplete);
  };
}

/** Test helper — clears the cross-attachment debounce memo. */
export function _resetQuotaAutoRefreshForTesting(): void {
  lastFireByKey.clear();
}
