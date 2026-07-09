/**
 * Model usage memory — hybrid recency/frequency ranking for the model picker.
 *
 * Persists to `AppSettings.modelUsageByKey` so rankings survive restarts and
 * stay aligned with other per-provider defaults.
 */

import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import type { ModelUsageEntry } from '../../../../shared/types/settings.types';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingsIpcService } from '../../core/services/ipc/settings-ipc.service';
import {
  compareModelUsageKeys,
  isModelUsageByKey,
  modelUsageKey,
  modelUsageScore,
  recordModelUsage,
} from './model-usage-memory';

@Injectable({ providedIn: 'root' })
export class ModelUsageMemoryService {
  private readonly settingsStore = inject(SettingsStore);
  private readonly settingsIpc = inject(SettingsIpcService);
  private initialized = false;

  private readonly _usageByKey = signal<Record<string, ModelUsageEntry>>({});
  readonly usageByKey = this._usageByKey.asReadonly();

  constructor() {
    effect(() => {
      const settings = this.settingsStore.settings();
      if (!this.initialized) {
        if (isModelUsageByKey(settings.modelUsageByKey)) {
          this._usageByKey.set({ ...settings.modelUsageByKey });
        }
        this.initialized = true;
        return;
      }

      // Keep in sync when settings reload from disk / other windows, but do
      // not clobber a newer in-memory write that has not round-tripped yet.
      if (!isModelUsageByKey(settings.modelUsageByKey)) return;
      const incoming = settings.modelUsageByKey;
      const current = untracked(() => this._usageByKey());
      if (usageMapsEqual(current, incoming)) return;
      this._usageByKey.set({ ...incoming });
    });

    this.settingsIpc.onSettingsChanged((data: unknown) => {
      const change = data as { key?: string; value?: unknown; settings?: Record<string, unknown> };
      if (change.key === 'modelUsageByKey' && isModelUsageByKey(change.value)) {
        this._usageByKey.set({ ...change.value });
        return;
      }
      if (change.settings && isModelUsageByKey(change.settings['modelUsageByKey'])) {
        this._usageByKey.set({ ...change.settings['modelUsageByKey'] });
      }
    });
  }

  /** Record a successful model selection (`provider` + concrete `modelId`). */
  record(provider: string, modelId: string, nowMs: number = Date.now()): void {
    if (!provider || !modelId) return;

    const key = modelUsageKey(provider, modelId);
    const next = recordModelUsage(this._usageByKey(), key, nowMs);
    this._usageByKey.set(next);
    if (this.initialized) {
      this.settingsIpc.setSetting('modelUsageByKey', next);
    }
  }

  score(provider: string, modelId: string, nowMs: number = Date.now()): number {
    return modelUsageScore(this._usageByKey()[modelUsageKey(provider, modelId)], nowMs);
  }

  /**
   * Sort helper for picker rows. Higher hybrid score first; catalogIndex
   * breaks remaining ties (stable catalog order).
   */
  compareKeys(
    aKey: string,
    bKey: string,
    catalogIndex: (key: string) => number,
    nowMs: number = Date.now(),
  ): number {
    return compareModelUsageKeys(aKey, bKey, this._usageByKey(), catalogIndex, nowMs);
  }
}

function usageMapsEqual(
  a: Record<string, ModelUsageEntry>,
  b: Record<string, ModelUsageEntry>,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    const left = a[key];
    const right = b[key];
    if (!right || left.count !== right.count || left.lastUsedAt !== right.lastUsedAt) {
      return false;
    }
  }
  return true;
}
