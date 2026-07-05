import { Injectable, DestroyRef, computed, inject, signal } from '@angular/core';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';
import {
  getModelsForProvider,
  replaceKnownModelCatalogSnapshot,
  type ModelDisplayInfo,
} from '../../../../shared/types/provider.types';
import type {
  CatalogStatus,
  UnifiedModelEntry,
} from '../../../../shared/types/unified-model-catalog.types';

/**
 * UnifiedCatalogStore — renderer-side reactive view of the main-process unified
 * model catalog (static, models.dev, overrides, custom, and CLI-discovered).
 *
 * This is the "consume half" data layer for A1: it reads `MODELS_UNIFIED_CATALOG`
 * and live-refreshes whenever the main process pushes `models:catalog-updated`.
 * Pickers can read `displayModelsForProvider()` / `models()` from inside their
 * reactive computeds and re-render automatically on refresh; `lastBuiltAt()`
 * backs a live-refresh pill.
 *
 * WIRED: `CompactModelPickerComponent` and the legacy
 * `InstanceDetailComponent` header dropdown consume this store as their primary
 * model source, falling back to the previous static/dynamic lists only until
 * the catalog has loaded. `displayModelsForProvider()` overlays curated display
 * names from the static catalog by id so picker rows keep their polished labels
 * (models.dev-only ids get a humanised fallback name).
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
          replaceKnownModelCatalogSnapshot(res.data.models);
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

  /**
   * Picker-shaped rows for a provider, with curated display names / pinned /
   * family overlaid from the static catalog by id (so the picker keeps its
   * polished labels). Models the catalog knows but the static list doesn't get a
   * humanised name from their id.
   */
  displayModelsForProvider(provider: string): ModelDisplayInfo[] {
    const curated = new Map(getModelsForProvider(provider).map((m) => [m.id, m]));
    return this.modelsForProvider(provider).map((entry) => {
      const known = curated.get(entry.id);
      return {
        id: entry.id,
        name: known?.name ?? entry.name ?? humanizeModelId(entry.id),
        tier: entry.tier,
        ...(known?.pinned ? { pinned: known.pinned } : {}),
        ...(known?.family ?? entry.family ? { family: known?.family ?? entry.family } : {}),
      };
    });
  }
}

/** Best-effort readable label for a model id we have no curated name for. */
function humanizeModelId(id: string): string {
  return id
    .replace(/^claude-/, '')
    .replace(/-(\d{8})$/, '')
    .replace(/[-_]/g, ' ')
    .trim() || id;
}
