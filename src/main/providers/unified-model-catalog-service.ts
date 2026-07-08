/**
 * UnifiedModelCatalogService
 *
 * Merges every model-metadata source layer into one provider-neutral catalog:
 *
 *   Priority 1 (highest): CLI-discovered models  — live provider CLI lists
 *   Priority 2:           user-custom models    — provider-specific settings
 *   Priority 3:           catalog overrides     — user-data / remote JSON entries
 *   Priority 4:           models.dev registry   — fetched + cached every 6 h
 *   Priority 5 (lowest):  static curated data   — PROVIDER_MODEL_LIST / MODEL_PRICING
 *
 * Static `tier` and `family` are always overlaid on live entries when the live
 * source does not supply them (mirrors the renderer's `mergeStaticMetadata`).
 *
 * Emits `catalog-updated` whenever any underlying source refreshes.  Multiple
 * rapid source refreshes within DEBOUNCE_MS are coalesced into one event.
 *
 * Singleton pattern: lazy `getInstance()` + `getUnifiedModelCatalog()` +
 * `_resetForTesting()`.
 */

import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import {
  PROVIDER_MODEL_LIST,
  MAX_MODEL_ID_LENGTH,
  clearKnownModelCatalogSnapshotForTesting,
  replaceKnownModelCatalogSnapshot,
  type ModelDisplayInfo,
} from '../../shared/types/provider.types';
import { getModelsDevService, type ModelsDevService } from './models-dev-service';
import { getModelRate, DEFAULT_MODEL_RATE, hasOverlayRate } from '../../shared/data/model-pricing';
import type { CatalogOverrideEntry } from './catalog-override-source';
import type {
  UnifiedModelEntry,
  CatalogStatus,
  CatalogSource,
} from '../../shared/types/unified-model-catalog.types';
import type { AppSettings } from '../../shared/types/settings.types';
import type { LocalModelInventoryEntry } from '../../shared/types/local-model-runtime.types';

export type { UnifiedModelEntry, CatalogStatus, CatalogSource };

const logger = getLogger('UnifiedModelCatalog');

/** Coalesce rapid multi-source refreshes into a single `catalog-updated` event. */
const DEBOUNCE_MS = 250;

/** Stable key for the internal catalog map: `<provider>:<id>`. */
function catalogKey(provider: string, id: string): string {
  return `${provider}:${id}`;
}

/** Event name emitted when the catalog content changes. */
export const CATALOG_UPDATED_EVENT = 'catalog-updated' as const;

const CATALOG_SOURCE_PRIORITY: Record<CatalogSource, number> = {
  'static': 1,
  'models-dev': 2,
  'catalog-override': 3,
  'user-custom': 4,
  'cli-discovered': 5,
  'local-model': 6,
};

export interface CatalogUpdatedPayload {
  /** Number of entries in the rebuilt catalog. */
  totalEntries: number;
  /** Sources that triggered this rebuild. */
  sources: CatalogSource[];
}

interface CatalogSettingsManager {
  get<K extends keyof AppSettings>(key: K): AppSettings[K];
  on(event: 'setting-changed', listener: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void): unknown;
  off?(event: 'setting-changed', listener: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void): unknown;
  removeListener?(event: 'setting-changed', listener: (key: keyof AppSettings, value: AppSettings[keyof AppSettings]) => void): unknown;
}

interface CatalogOverrideEventSource {
  getEntries(): CatalogOverrideEntry[];
  on(event: 'updated', listener: () => void): unknown;
  off?(event: 'updated', listener: () => void): unknown;
  removeListener?(event: 'updated', listener: () => void): unknown;
}

export class UnifiedModelCatalogService extends EventEmitter {
  private static instance: UnifiedModelCatalogService | null = null;

  private readonly modelsDevSvc: ModelsDevService;

  /** Catalog keyed by `provider:id` for O(1) lookup. */
  private catalog = new Map<string, UnifiedModelEntry>();

  /** CLI-discovered models keyed by provider namespace. */
  private cliModels = new Map<string, ModelDisplayInfo[]>();
  /** User-entered model ids keyed by provider namespace. */
  private customModelsByProvider: Record<string, string[]> = {};
  /** User-data / remote catalog override entries. */
  private catalogOverrideEntries: CatalogOverrideEntry[] = [];
  /** Sanitized local model inventory rows from this coordinator and workers. */
  private localModelEntries: LocalModelInventoryEntry[] = [];

  /** Timestamps tracking per-source refresh. */
  private modelsDevLastRefreshedAt: number | null = null;
  private cliDiscoveryLastRefreshedAt: Record<string, number> = {};
  private customModelsLastRefreshedAt: number | null = null;
  private catalogOverrideLastRefreshedAt: number | null = null;
  private localModelLastRefreshedAt: number | null = null;
  private catalogLastBuiltAt: number | null = null;

  /** Pending debounce timer handle. */
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  /** Sources queued for the next debounced catalog-updated event. */
  private pendingSources = new Set<CatalogSource>();
  /** Detaches the active settings listener, if app bootstrap has attached one. */
  private detachSettingsListener: (() => void) | null = null;
  /** Detaches the active catalog override listener, if app bootstrap has attached one. */
  private detachCatalogOverrideListener: (() => void) | null = null;

  private constructor(modelsDevSvc: ModelsDevService) {
    super();
    this.modelsDevSvc = modelsDevSvc;
    // Populate from static data immediately so the catalog is never empty.
    this.rebuildCatalog([]);
  }

  static getInstance(): UnifiedModelCatalogService {
    if (!UnifiedModelCatalogService.instance) {
      UnifiedModelCatalogService.instance = new UnifiedModelCatalogService(
        getModelsDevService(),
      );
    }
    return UnifiedModelCatalogService.instance;
  }

  static _resetForTesting(): void {
    if (UnifiedModelCatalogService.instance) {
      UnifiedModelCatalogService.instance.removeAllListeners();
      if (UnifiedModelCatalogService.instance.debounceTimer !== null) {
        clearTimeout(UnifiedModelCatalogService.instance.debounceTimer);
      }
      UnifiedModelCatalogService.instance.detachSettingsListener?.();
      UnifiedModelCatalogService.instance.detachCatalogOverrideListener?.();
      UnifiedModelCatalogService.instance = null;
    }
    clearKnownModelCatalogSnapshotForTesting();
  }

  // ============================================================
  // Public read API
  // ============================================================

  /** All entries across every provider. */
  getAllModels(): UnifiedModelEntry[] {
    return Array.from(this.catalog.values());
  }

  /** All entries for a specific provider namespace (e.g. `claude`, `copilot`). */
  getModelsByProvider(provider: string): UnifiedModelEntry[] {
    const norm = provider.trim().toLowerCase();
    return Array.from(this.catalog.values()).filter((e) => e.provider === norm);
  }

  /**
   * Look up a model by its canonical `id` (provider-namespaced lookup is not
   * required — the id is unique within the catalog because ids already embed
   * the provider context in practice, and each provider namespace is kept in
   * a separate bucket).  When the same id appears under multiple providers,
   * this returns the highest-priority entry.
   */
  getModel(id: string): UnifiedModelEntry | undefined {
    // Direct map lookup by composite key isn't possible without knowing the
    // provider; scan is O(n) but catalog sizes are small (< 200 entries).
    let best: UnifiedModelEntry | undefined;
    for (const entry of this.catalog.values()) {
      if (entry.id !== id) continue;
      if (!best || CATALOG_SOURCE_PRIORITY[entry.source] > CATALOG_SOURCE_PRIORITY[best.source]) {
        best = entry;
      }
    }
    return best;
  }

  /** Per-source last-refresh timestamps (for a future live-refresh status pill). */
  getCatalogStatus(): CatalogStatus {
    return {
      modelsDevLastRefreshedAt: this.modelsDevLastRefreshedAt,
      cliDiscoveryLastRefreshedAt: { ...this.cliDiscoveryLastRefreshedAt },
      catalogLastBuiltAt: this.catalogLastBuiltAt,
    };
  }

  // ============================================================
  // Source-refresh callbacks — call these from background jobs
  // ============================================================

  /**
   * Notify the catalog that models.dev has been refreshed.
   * Rebuilds the catalog and schedules a debounced `catalog-updated` event.
   * Should be called after a successful `ModelsDevService.refresh()`.
   */
  onModelsDevRefreshed(): void {
    this.modelsDevLastRefreshedAt = Date.now();
    logger.debug('models.dev refresh notified; scheduling catalog rebuild');
    this.scheduleRebuild('models-dev');
  }

  /**
   * Notify the catalog that CLI discovery has completed for a provider.
   * `models` is the fresh list from the CLI (e.g. from `cursor-agent --list-models`).
   */
  onCliDiscoveryRefreshed(provider: string, models: ModelDisplayInfo[]): void {
    const norm = provider.trim().toLowerCase();
    if (models.length === 0) {
      logger.debug('CLI discovery returned no models; keeping existing catalog state', {
        provider: norm,
      });
      return;
    }
    this.cliModels.set(norm, models);
    this.cliDiscoveryLastRefreshedAt[norm] = Date.now();
    logger.debug('CLI discovery notified', { provider: norm, count: models.length });
    this.scheduleRebuild('cli-discovered');
  }

  /**
   * Attach the catalog to settings changes. App bootstrap owns this wiring so
   * constructing the catalog in tests does not implicitly construct Electron
   * settings. The current settings snapshot is consumed immediately.
   */
  attachSettingsManager(settingsManager: CatalogSettingsManager): void {
    this.detachSettingsListener?.();

    this.onCustomModelsChanged(settingsManager.get('customModelsByProvider'), { immediate: true });

    const listener = (
      key: keyof AppSettings,
      value: AppSettings[keyof AppSettings],
    ) => {
      if (key === 'customModelsByProvider') {
        this.onCustomModelsChanged(value);
      }
    };
    settingsManager.on('setting-changed', listener);
    this.detachSettingsListener = () => {
      if (typeof settingsManager.off === 'function') {
        settingsManager.off('setting-changed', listener);
      } else {
        settingsManager.removeListener?.('setting-changed', listener);
      }
    };
  }

  /** Update the provider-specific custom-model source and schedule a rebuild. */
  onCustomModelsChanged(
    customModelsByProvider: unknown,
    options: { immediate?: boolean } = {},
  ): void {
    this.customModelsByProvider = normalizeCustomModelsByProvider(customModelsByProvider);
    this.customModelsLastRefreshedAt = Date.now();
    logger.debug('Custom model settings notified', {
      providers: Object.keys(this.customModelsByProvider).length,
    });
    if (options.immediate) {
      this.rebuildImmediately('user-custom');
      return;
    }
    this.scheduleRebuild('user-custom');
  }

  /** Attach the optional user-data / remote catalog override source. */
  attachCatalogOverrideSource(source: CatalogOverrideEventSource): void {
    this.detachCatalogOverrideListener?.();

    this.onCatalogOverrideChanged(source.getEntries(), { immediate: true });

    const listener = () => {
      this.onCatalogOverrideChanged(source.getEntries());
    };
    source.on('updated', listener);
    this.detachCatalogOverrideListener = () => {
      if (typeof source.off === 'function') {
        source.off('updated', listener);
      } else {
        source.removeListener?.('updated', listener);
      }
    };
  }

  /** Update catalog override entries and schedule a rebuild. */
  onCatalogOverrideChanged(
    entries: CatalogOverrideEntry[],
    options: { immediate?: boolean } = {},
  ): void {
    this.catalogOverrideEntries = normalizeCatalogOverrideEntries(entries);
    this.catalogOverrideLastRefreshedAt = Date.now();
    logger.debug('Catalog override source notified', {
      entries: this.catalogOverrideEntries.length,
    });
    if (options.immediate) {
      this.rebuildImmediately('catalog-override');
      return;
    }
    this.scheduleRebuild('catalog-override');
  }

  onLocalModelInventoryRefreshed(
    entries: LocalModelInventoryEntry[],
    options: { immediate?: boolean } = {},
  ): void {
    this.localModelEntries = entries;
    this.localModelLastRefreshedAt = Date.now();
    logger.debug('Local model inventory notified', {
      entries: this.localModelEntries.length,
    });
    if (options.immediate) {
      this.rebuildImmediately('local-model');
      return;
    }
    this.scheduleRebuild('local-model');
  }

  // ============================================================
  // Internal: debounce + rebuild
  // ============================================================

  private scheduleRebuild(source: CatalogSource): void {
    this.pendingSources.add(source);

    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const sources = Array.from(this.pendingSources) as CatalogSource[];
      this.pendingSources.clear();
      this.rebuildCatalog(sources);
    }, DEBOUNCE_MS);

    // Allow the process to exit cleanly even while a rebuild is pending.
    if (this.debounceTimer && typeof this.debounceTimer === 'object' && 'unref' in this.debounceTimer) {
      (this.debounceTimer as NodeJS.Timeout).unref();
    }
  }

  private rebuildImmediately(source: CatalogSource): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    const sources = Array.from(new Set([...this.pendingSources, source])) as CatalogSource[];
    this.pendingSources.clear();
    this.rebuildCatalog(sources);
  }

  /**
   * Rebuild the in-memory catalog from all sources.
   * Static data is the base; models.dev context-window/pricing overlays on top;
   * user-custom adds provider-specific ids; CLI-discovered models take highest
   * precedence, with static tier/family backfilled.
   */
  private rebuildCatalog(triggerSources: CatalogSource[]): void {
    const next = new Map<string, UnifiedModelEntry>();
    const now = Date.now();

    // ---- Layer 1: static curated data (lowest precedence) ----
    for (const [providerKey, models] of Object.entries(PROVIDER_MODEL_LIST)) {
      const provider = providerKey.trim().toLowerCase();
      for (const m of models) {
        const entry = this.buildStaticEntry(m, provider, now);
        next.set(catalogKey(provider, m.id), entry);
      }
    }

    // ---- Layer 2: models.dev overlay (pricing + context windows + new entries) ----
    // First, enrich existing static entries with models.dev data.
    for (const [key, entry] of next) {
      const contextWindow = this.modelsDevSvc.getContextWindow(entry.id);
      const { pricing: rate, fromLiveOverlay, pricingSource } = this.getEnrichedPricingWithSource(entry.id);
      // Source is upgraded to 'models-dev' only when live data (context window
      // from ModelsDevService, or live pricing overlay — not static MODEL_PRICING)
      // actually contributed to this entry.
      const liveEnrichment = contextWindow !== undefined || fromLiveOverlay;
      if (contextWindow !== undefined || rate !== undefined) {
        next.set(key, {
          ...entry,
          contextWindow: contextWindow ?? entry.contextWindow,
          pricing: rate ?? entry.pricing,
          pricingSource: rate !== undefined ? pricingSource : entry.pricingSource,
          source: liveEnrichment && entry.source === 'static' ? 'models-dev' : entry.source,
          discoveredAt: liveEnrichment
            ? (this.modelsDevLastRefreshedAt ?? entry.discoveredAt)
            : entry.discoveredAt,
        });
      }
    }

    // Second, add models.dev-only entries (those absent from the static catalog).
    // models.dev uses external provider namespaces (e.g. `anthropic`, `google`);
    // map supported namespaces to the app's provider ids so newly published
    // upstream models can appear in the same picker/catalog bucket as the
    // provider runtime. Unknown namespaces are kept verbatim for discovery.
    const modelsDevEntries = this.modelsDevSvc.listEntries();
    for (const devEntry of modelsDevEntries) {
      const provider = normalizeModelsDevProviderNamespace(devEntry.provider);
      const key = catalogKey(provider, devEntry.id);
      if (next.has(key)) {
        // Already exists from static — skip; it was enriched in the loop above.
        continue;
      }
      // Also check whether this id lives under a DIFFERENT provider key in the
      // static catalog (e.g. models.dev calls it `anthropic` but static uses
      // `claude`). If so, skip — the static entry took precedence.
      const alreadyPresent = Array.from(next.values()).some((e) => e.id === devEntry.id);
      if (alreadyPresent) {
        continue;
      }

      const pricing: UnifiedModelEntry['pricing'] = {
        inputPerMillion: devEntry.rate.input,
        outputPerMillion: devEntry.rate.output,
      };
      const entry: UnifiedModelEntry = {
        id: devEntry.id,
        provider,
        tier: 'balanced', // no tier info from models.dev; consumer may override
        pricing,
        pricingSource: 'models-dev',
        contextWindow: devEntry.contextWindow,
        maxOutputTokens: devEntry.maxOutputTokens,
        source: 'models-dev',
        discoveredAt: this.modelsDevLastRefreshedAt ?? now,
      };
      next.set(key, entry);
    }

    // ---- Layer 3: catalog overrides ----
    const staticModelCache = new Map<string, Map<string, ModelDisplayInfo>>();
    for (const override of this.catalogOverrideEntries) {
      const provider = override.provider;
      const id = override.id;
      const key = catalogKey(provider, id);
      const existing = next.get(key);
      const staticById = getStaticModelsById(provider, staticModelCache);
      const known = staticById.get(id);
      const { pricing, pricingSource } = this.getEnrichedPricingWithSource(id);
      const overridePricing = override.pricing;
      const entry: UnifiedModelEntry = {
        id,
        provider,
        ...(override.name ? { name: override.name } : existing?.name ? { name: existing.name } : {}),
        tier: override.tier ?? known?.tier ?? existing?.tier ?? 'balanced',
        family: override.family ?? known?.family ?? existing?.family,
        pricing: overridePricing ?? pricing ?? existing?.pricing,
        pricingSource: overridePricing ? 'catalog-override' : (pricingSource ?? existing?.pricingSource),
        contextWindow: override.contextWindow ?? this.modelsDevSvc.getContextWindow(id) ?? existing?.contextWindow,
        maxOutputTokens: override.maxOutputTokens ?? existing?.maxOutputTokens,
        source: 'catalog-override',
        discoveredAt: override.discoveredAt || this.catalogOverrideLastRefreshedAt || now,
      };
      next.set(key, entry);
    }

    // ---- Layer 4: user custom models ----
    for (const [provider, modelIds] of Object.entries(this.customModelsByProvider)) {
      const staticById = new Map(
        (PROVIDER_MODEL_LIST[provider] ?? []).map((m) => [m.id, m]),
      );
      const discoveredAt = this.customModelsLastRefreshedAt ?? now;

      for (const id of modelIds) {
        const key = catalogKey(provider, id);
        const existing = next.get(key);
        const known = staticById.get(id);
        const { pricing, pricingSource } = this.getEnrichedPricingWithSource(id);
        const entry: UnifiedModelEntry = {
          id,
          provider,
          ...(existing?.name ? { name: existing.name } : {}),
          tier: known?.tier ?? existing?.tier ?? 'balanced',
          family: known?.family ?? existing?.family,
          pricing: pricing ?? existing?.pricing,
          pricingSource: pricingSource ?? existing?.pricingSource,
          contextWindow: this.modelsDevSvc.getContextWindow(id) ?? existing?.contextWindow,
          maxOutputTokens: existing?.maxOutputTokens,
          source: 'user-custom',
          isCustom: true,
          discoveredAt,
        };
        next.set(key, entry);
      }
    }

    // ---- Layer 5: CLI-discovered models (highest precedence) ----
    for (const [provider, models] of this.cliModels) {
      this.removeProviderFallbackEntries(next, provider);
      const staticById = new Map(
        (PROVIDER_MODEL_LIST[provider] ?? []).map((m) => [m.id, m]),
      );
      const discoveredAt = this.cliDiscoveryLastRefreshedAt[provider] ?? now;

      for (const m of models) {
        // Overlay static tier/family when the CLI doesn't supply them.
        const known = staticById.get(m.id);
        const tier = m.tier ?? known?.tier ?? 'balanced';
        const family = m.family ?? known?.family;
        const contextWindow = this.modelsDevSvc.getContextWindow(m.id);
        const { pricing, pricingSource } = this.getEnrichedPricingWithSource(m.id);

        const entry: UnifiedModelEntry = {
          id: m.id,
          name: m.name,
          provider,
          tier,
          family,
          pricing,
          pricingSource,
          contextWindow,
          source: 'cli-discovered',
          discoveredAt,
        };
        next.set(catalogKey(provider, m.id), entry);
      }
    }

    // ---- Layer 6: Local model inventory (distinct provider namespace) ----
    for (const [key, entry] of next) {
      if (entry.provider === 'local-model') {
        next.delete(key);
      }
    }
    for (const entry of this.localModelEntries) {
      next.set(catalogKey('local-model', entry.selectorId), {
        id: entry.selectorId,
        provider: 'local-model',
        name: entry.displayName,
        tier: 'balanced',
        family: entry.endpointProvider === 'ollama' ? 'Ollama' : 'OpenAI-compatible',
        contextWindow: entry.loadedContextLength ?? entry.advertisedContextLength,
        source: 'local-model',
        discoveredAt: entry.discoveredAt || this.localModelLastRefreshedAt || now,
      });
    }

    this.catalog = next;
    replaceKnownModelCatalogSnapshot(next.values());
    this.catalogLastBuiltAt = Date.now();

    logger.info('Unified model catalog rebuilt', {
      entries: next.size,
      triggerSources,
    });

    if (triggerSources.length > 0) {
      const payload: CatalogUpdatedPayload = {
        totalEntries: next.size,
        sources: triggerSources,
      };
      this.emit(CATALOG_UPDATED_EVENT, payload);
    }
  }

  // ============================================================
  // Helpers
  // ============================================================

  private buildStaticEntry(
    m: ModelDisplayInfo,
    provider: string,
    now: number,
  ): UnifiedModelEntry {
    const { pricing, pricingSource } = this.getEnrichedPricingWithSource(m.id);
    return {
      id: m.id,
      provider,
      tier: m.tier,
      family: m.family,
      pricing,
      pricingSource,
      source: 'static',
      discoveredAt: now,
    };
  }

  /**
   * Try to resolve pricing for a model id.
   *
   * Returns the pricing value (if any), a flag indicating whether the pricing
   * came from the **live** models.dev overlay, and the precise `pricingSource`
   * label. Callers use `fromLiveOverlay` to decide whether to upgrade the entry's
   * `source` tag, and `pricingSource` to record precise pricing attribution.
   *
   * Never returns the generic DEFAULT_MODEL_RATE — we only attach pricing when
   * an explicit entry is known so unknown models don't silently get a Sonnet-class
   * rate stuck on them.
   */
  private getEnrichedPricingWithSource(id: string): {
    pricing: UnifiedModelEntry['pricing'] | undefined;
    fromLiveOverlay: boolean;
    pricingSource: CatalogSource | undefined;
  } {
    // Check the live overlay first (models.dev synced rates).
    // getModelRate returns DEFAULT_MODEL_RATE by reference when there's no match;
    // a non-identical result means a live overlay or static entry exists.
    const rate = getModelRate(id);
    if (rate !== DEFAULT_MODEL_RATE) {
      // Determine whether this rate came from the live overlay or the static table.
      // Check the overlay first: a model can appear in BOTH the overlay and
      // MODEL_PRICING — the overlay always wins (see getModelRate precedence),
      // so if the overlay has it, the pricing is 'models-dev'-sourced.
      const fromLiveOverlay = hasOverlayRate(id);
      const pricingSource: CatalogSource = fromLiveOverlay ? 'models-dev' : 'static';
      return {
        pricing: { inputPerMillion: rate.input, outputPerMillion: rate.output },
        fromLiveOverlay,
        pricingSource,
      };
    }
    return { pricing: undefined, fromLiveOverlay: false, pricingSource: undefined };
  }

  private removeProviderFallbackEntries(
    catalog: Map<string, UnifiedModelEntry>,
    provider: string,
  ): void {
    for (const [key, entry] of catalog) {
      if (
        entry.provider === provider
        && (entry.source === 'static' || entry.source === 'models-dev')
      ) {
        catalog.delete(key);
      }
    }
  }
}

// ============================================================
// Module-level singleton accessors
// ============================================================

export function getUnifiedModelCatalog(): UnifiedModelCatalogService {
  return UnifiedModelCatalogService.getInstance();
}

function normalizeCustomModelsByProvider(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const result: Record<string, string[]> = {};
  for (const [rawProvider, rawModels] of Object.entries(value)) {
    const provider = rawProvider.trim().toLowerCase();
    if (!provider || !Array.isArray(rawModels)) {
      continue;
    }

    const seen = new Set<string>();
    const models: string[] = [];
    for (const rawModel of rawModels) {
      if (typeof rawModel !== 'string') {
        continue;
      }
      const model = rawModel.trim();
      if (!model || model.length > MAX_MODEL_ID_LENGTH || seen.has(model)) {
        continue;
      }
      seen.add(model);
      models.push(model);
    }
    if (models.length > 0) {
      result[provider] = models;
    }
  }
  return result;
}

function normalizeCatalogOverrideEntries(entries: CatalogOverrideEntry[]): CatalogOverrideEntry[] {
  const result = new Map<string, CatalogOverrideEntry>();
  for (const entry of entries) {
    const provider = entry.provider.trim().toLowerCase();
    const id = entry.id.trim();
    if (!provider || !id || entry.source !== 'catalog-override') {
      continue;
    }
    result.set(catalogKey(provider, id), {
      ...entry,
      provider,
      id,
      ...(entry.name ? { name: entry.name.trim() } : {}),
      ...(entry.family ? { family: entry.family.trim() } : {}),
    });
  }
  return Array.from(result.values());
}

function getStaticModelsById(
  provider: string,
  cache: Map<string, Map<string, ModelDisplayInfo>>,
): Map<string, ModelDisplayInfo> {
  const cached = cache.get(provider);
  if (cached) {
    return cached;
  }
  const byId = new Map((PROVIDER_MODEL_LIST[provider] ?? []).map((model) => [model.id, model]));
  cache.set(provider, byId);
  return byId;
}

function normalizeModelsDevProviderNamespace(provider: string): string {
  const normalized = provider.trim().toLowerCase();

  switch (normalized) {
    case 'anthropic':
      return 'claude';
    case 'google':
      return 'gemini';
    case 'openai':
      return 'codex';
    case 'github-copilot':
      return 'copilot';
    default:
      return normalized;
  }
}
