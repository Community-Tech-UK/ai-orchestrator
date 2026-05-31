import { Injectable, inject, signal } from '@angular/core';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';
import {
  getModelsForProvider,
  type ModelDisplayInfo,
} from '../../../../shared/types/provider.types';

/**
 * Providers whose model list is discovered from the installed CLI at runtime.
 * For everything else the curated static catalog (`getModelsForProvider`) is the
 * source of truth, so we don't waste an IPC round-trip re-fetching an identical
 * list.
 */
const DYNAMIC_PROVIDERS = new Set<string>(['copilot', 'cursor']);

/** Re-query a provider's CLI at most this often (main process also caches ~5min). */
const REFRESH_TTL_MS = 5 * 60_000;

/**
 * Shared, reactive cache of dynamically-discovered model lists.
 *
 * The compact model picker reads `modelsFor(provider)` from within its reactive
 * computeds; because that getter reads the internal signal, the picker re-renders
 * automatically once `ensureLoaded()` resolves a live list. A single root-scoped
 * instance means multiple open pickers share one cache and one in-flight request
 * per provider.
 */
@Injectable({ providedIn: 'root' })
export class DynamicModelCatalogService {
  private readonly providerIpc = inject(ProviderIpcService);

  /** provider → live model list (absent until first successful fetch). */
  private readonly catalog = signal<Record<string, ModelDisplayInfo[]>>({});

  /** provider → last fetch attempt timestamp (throttles retries via TTL). */
  private readonly attemptedAt = new Map<string, number>();

  /** provider → in-flight fetch, so concurrent pickers don't double-request. */
  private readonly inflight = new Map<string, Promise<void>>();

  /**
   * Return the best-known model list for a provider: the live list when one has
   * been fetched, otherwise the curated static catalog. Reads the internal
   * signal so callers inside Angular computeds stay reactive.
   */
  modelsFor(provider: string): ModelDisplayInfo[] {
    const live = this.catalog()[provider];
    return live && live.length > 0 ? live : getModelsForProvider(provider);
  }

  /**
   * Kick off a background refresh for a dynamic provider if the cached entry is
   * stale and no fetch is already running. No-op for static providers. Safe to
   * call on every menu open.
   */
  ensureLoaded(provider: string): void {
    if (!DYNAMIC_PROVIDERS.has(provider)) return;

    const now = Date.now();
    const last = this.attemptedAt.get(provider) ?? 0;
    if (now - last < REFRESH_TTL_MS) return;
    if (this.inflight.has(provider)) return;

    // Stamp the attempt up-front so a failing/missing CLI throttles retries too.
    this.attemptedAt.set(provider, now);
    const run = this.fetch(provider).finally(() => this.inflight.delete(provider));
    this.inflight.set(provider, run);
  }

  private async fetch(provider: string): Promise<void> {
    try {
      const response = await this.providerIpc.listModelsForProvider(provider);
      if (response.success && response.data && response.data.length > 0) {
        const merged = mergeStaticMetadata(provider, response.data);
        this.catalog.update((current) => ({ ...current, [provider]: merged }));
      }
    } catch {
      // Keep whatever we have (static fallback); the next open retries after TTL.
    }
  }
}

/**
 * Overlay curated `pinned` / `family` / `tier` metadata from the static catalog
 * onto the live list, matched by id. The live list controls membership + order +
 * (fresh) display names; the static catalog keeps the picker's favorites defaults
 * and family grouping intact for ids we already know about.
 */
function mergeStaticMetadata(
  provider: string,
  dynamic: ModelDisplayInfo[],
): ModelDisplayInfo[] {
  const staticById = new Map(getModelsForProvider(provider).map((m) => [m.id, m]));
  return dynamic.map((d) => {
    const known = staticById.get(d.id);
    if (!known) return d;
    return {
      ...d,
      tier: known.tier,
      family: known.family ?? d.family,
      pinned: known.pinned ?? d.pinned,
    };
  });
}
