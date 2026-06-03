import { Injectable, DestroyRef, computed, inject, signal } from '@angular/core';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';
import type { ModelDisplayInfo } from '../../../../shared/types/provider.types';
import type {
  CatalogStatus,
  UnifiedModelEntry,
} from '../../../../shared/types/unified-model-catalog.types';

/**
 * UnifiedCatalogStore — renderer-side reactive view of the main-process unified
 * model catalog (static + models.dev + CLI-discovered).
 *
 * This is the "consume half" data layer for A1: it reads `MODELS_UNIFIED_CATALOG`
 * and live-refreshes whenever the main process pushes `models:catalog-updated`.
 * Pickers can read `displayModelsForProvider()` / `models()` from inside their
 * reactive computeds and re-render automatically on refresh; `lastBuiltAt()`
 * backs a live-refresh pill.
 *
 * NOTE (deliberately not yet wired into the live picker): swapping the picker's
 * source from `DynamicModelCatalogService` to this store would surface
 * models.dev-only entries into the static-provider pickers and replace curated
 * display names with ids — a UX change that needs visual verification. This
 * store is the verified building block for that swap.
 */
@Injectable({ providedIn: 'root' })
export class UnifiedCatalogStore {
  private readonly providerIpc = inject(ProviderIpcService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly _models = signal<UnifiedModelEntry[]>([]);
  private readonly _status = signal<CatalogStatus | null>(null);

  private loaded = false;
  private inflight: Promise<void> | null = null;

  /** All catalog entries across providers. */
  readonly models = this._models.asReadonly();
  /** Per-source refresh timestamps (for a live-refresh pill). */
  readonly status = this._status.asReadonly();
  /** When the catalog was last rebuilt (ms epoch), or null if never. */
  readonly lastBuiltAt = computed(() => this._status()?.catalogLastBuiltAt ?? null);

  constructor() {
    // Live-refresh: re-pull the catalog whenever the main process rebuilds it.
    const unsubscribe = this.providerIpc.onModelsCatalogUpdated(() => {
      void this.refresh();
    });
    this.destroyRef.onDestroy(unsubscribe);
  }

  /** Fetch once if not already loaded and no fetch is in flight. */
  ensureLoaded(): void {
    if (this.loaded || this.inflight) return;
    void this.refresh();
  }

  /** (Re)fetch the unified catalog from the main process. Coalesces concurrent calls. */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const res = await this.providerIpc.getUnifiedModelCatalog();
        if (res.success && res.data) {
          this._models.set(res.data.models);
          this._status.set(res.data.status);
          this.loaded = true;
        }
      } catch {
        // Keep whatever we have; a later catalog-updated push retries.
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  /** Entries for a provider namespace (normalised), reactive. */
  modelsForProvider(provider: string): UnifiedModelEntry[] {
    const norm = provider.trim().toLowerCase();
    return this._models().filter((m) => m.provider === norm);
  }

  /** Picker-shaped rows for a provider. Name falls back to id (curated names live in the static list). */
  displayModelsForProvider(provider: string): ModelDisplayInfo[] {
    return this.modelsForProvider(provider).map(toDisplayInfo);
  }
}

function toDisplayInfo(entry: UnifiedModelEntry): ModelDisplayInfo {
  return {
    id: entry.id,
    name: entry.id,
    tier: entry.tier,
    ...(entry.family ? { family: entry.family } : {}),
  };
}
