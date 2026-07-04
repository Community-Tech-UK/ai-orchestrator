/**
 * Shared types for the UnifiedModelCatalogService.
 *
 * Kept in `src/shared/types/` so the main process can own the catalog while
 * a future renderer or IPC consumer can import the types without pulling in
 * Node-only dependencies.
 */

/** Which data source contributed an entry to the unified catalog. */
export type CatalogSource = 'cli-discovered' | 'models-dev' | 'user-custom' | 'catalog-override' | 'static';

/**
 * A single provider-neutral model entry in the unified catalog.
 *
 * Precedence when merging:
 *   1. CLI-discovered (live, highest) — from provider CLI model-list probes
 *   2. user-custom — provider-specific ids from settings
 *   3. catalog-override — user-data / remote JSON override
 *   4. models.dev — live fetch from the public registry
 *   5. static — curated `PROVIDER_MODEL_LIST` / `MODEL_PRICING` snapshot
 *
 * Where a higher-precedence source is present its fields win, except that
 * `tier` and `family` from the static catalog are always overlaid when the
 * live source does not supply them (mirrors the renderer's `mergeStaticMetadata`
 * semantics).
 */
export interface UnifiedModelEntry {
  /** Canonical model id as used by the provider's CLI / API. */
  id: string;
  /** Optional display label supplied by a live CLI source or catalog override. */
  name?: string;
  /** Normalised provider namespace (e.g. `claude`, `copilot`, `gemini`, `codex`). */
  provider: string;
  /**
   * Model family label for grouping in pickers (e.g. `Opus`, `GPT`, `Gemini Pro`).
   * Sourced from the static catalog; absent when neither static nor live source
   * provides one.
   */
  family?: string;
  /**
   * Speed/cost tier: `fast` | `balanced` | `powerful`.
   * Always present — falls back to `balanced` when no source classifies the model.
   */
  tier: 'fast' | 'balanced' | 'powerful';
  /**
   * Pricing in USD per 1M tokens, when known.
   * Sourced from the models.dev overlay or the static `MODEL_PRICING` table.
   */
  pricing?: {
    inputPerMillion: number;
    outputPerMillion: number;
  };
  /**
   * Where the winning pricing came from.
   *
   * The top-level `source` field reflects the highest-precedence source that
   * contributed the **entry** (e.g. `static` for a curated model, `models-dev`
   * when models.dev enriched a static entry or introduced a new one).
   * `pricingSource` is more precise: when a static-origin entry has its pricing
   * overridden by a live models.dev overlay, `source` may still read `static`
   * while `pricingSource` reads `models-dev`.
   *
   * Absent when `pricing` is absent.
   */
  pricingSource?: CatalogSource;
  /**
   * Maximum context window in tokens, when published.
   * Sourced (in priority order) from CLI discovery, models.dev, or static caps.
   */
  contextWindow?: number;
  /**
   * Maximum output tokens per response, when published.
   * Sourced from models.dev or static model-discovery catalog.
   */
  maxOutputTokens?: number;
  /** Highest-precedence source that contributed this entry. */
  source: CatalogSource;
  /** True when the entry came from the user's provider-specific custom list. */
  isCustom?: boolean;
  /**
   * Wall-clock timestamp (ms since epoch) when this entry was last refreshed
   * from its primary source.
   */
  discoveredAt: number;
}

/**
 * Per-source last-refresh timestamps returned by
 * `UnifiedModelCatalogService.getCatalogStatus()`.
 *
 * A value of `null` means that source has never successfully refreshed in this
 * process lifetime (the catalog uses static fallbacks until then).
 */
export interface CatalogStatus {
  /** Last successful models.dev sync (null = never synced this session). */
  modelsDevLastRefreshedAt: number | null;
  /**
   * Last successful CLI discovery per provider.
   * Keys are provider names (e.g. `copilot`, `cursor`).
   */
  cliDiscoveryLastRefreshedAt: Record<string, number>;
  /** Milliseconds since epoch when the catalog was last rebuilt from any source. */
  catalogLastBuiltAt: number | null;
}
