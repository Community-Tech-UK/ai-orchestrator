/**
 * Provider State Service - Shared state for selected provider and model
 *
 * Coordinates between dashboard provider selector and instance creation,
 * and persists selections to settings so they survive app restarts.
 *
 * ## Per-provider model memory
 *
 * Each CLI provider remembers its own last-selected model. Switching from
 * Copilot+Opus to Claude+Sonnet and back to Copilot will restore Opus,
 * not reset to the provider's primary model. The map is persisted in
 * `AppSettings.defaultModelByProvider`; the legacy `defaultModel` field
 * is kept in sync for backward compatibility with code that still reads it.
 */

import { Injectable, signal, computed, inject, effect, untracked } from '@angular/core';
import { getPrimaryModelForProvider, normalizeModelForProvider } from '../../../../shared/types/provider.types';
import { SettingsStore } from '../state/settings.store';
import { SettingsIpcService } from './ipc/settings-ipc.service';

export type ProviderType = 'claude' | 'codex' | 'gemini' | 'copilot' | 'cursor' | 'auto';

function normalizeProvider(value: unknown): ProviderType {
  if (value === 'openai') return 'codex';
  if (value === 'claude' || value === 'codex' || value === 'gemini' || value === 'copilot' || value === 'cursor' || value === 'auto') {
    return value;
  }
  return 'claude';
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object') return false;
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (typeof v !== 'string') return false;
  }
  return true;
}

@Injectable({ providedIn: 'root' })
export class ProviderStateService {
  private settingsStore = inject(SettingsStore);
  private settingsIpc = inject(SettingsIpcService);
  private initialized = false;
  private readonly defaultModel = getPrimaryModelForProvider('claude') ?? 'opus';

  /** Currently selected provider */
  readonly selectedProvider = signal<ProviderType>('claude');

  /** Currently selected model (concrete model id, never 'auto') */
  readonly selectedModel = signal<string>(this.defaultModel);

  /**
   * Last model the user picked for each provider. Lets `setProvider` restore
   * the user's previous selection instead of forcing the provider's primary
   * every time. Persisted to `AppSettings.defaultModelByProvider`.
   */
  private readonly _lastModelByProvider = signal<Record<string, string>>({});
  readonly lastModelByProvider = this._lastModelByProvider.asReadonly();

  /** Whether Copilot is the selected provider */
  readonly isCopilot = computed(() => this.selectedProvider() === 'copilot');

  constructor() {
    // Hydrate from persisted settings once (settings are async-loaded; the
    // store starts on DEFAULT_SETTINGS, so the first non-default emit is our
    // signal that disk values are available).
    effect(() => {
      const settings = this.settingsStore.settings();
      if (this.initialized) return;

      const providerByProvider = isStringRecord(settings.defaultModelByProvider)
        ? { ...settings.defaultModelByProvider }
        : {};
      this._lastModelByProvider.set(providerByProvider);

      const provider = settings.defaultCli
        ? normalizeProvider(settings.defaultCli)
        : untracked(() => this.selectedProvider());
      const seedModel = this.lookupModelForProvider(provider, settings.defaultModel);
      this.applySelection(provider, seedModel);

      this.initialized = true;
    });

    // Persist provider changes
    effect(() => {
      const provider = this.selectedProvider();
      if (this.initialized) {
        this.settingsIpc.setSetting('defaultCli', provider);
      }
    });

    // Persist model changes — both as the per-provider memory AND as the
    // legacy `defaultModel` field for backward compat.
    effect(() => {
      const model = this.selectedModel();
      if (!this.initialized) return;
      const provider = untracked(() => this.selectedProvider());
      this.settingsIpc.setSetting('defaultModel', model);
      if (provider !== 'auto' && model) {
        this._lastModelByProvider.update((map) => {
          if (map[provider] === model) return map;
          const next = { ...map, [provider]: model };
          // Push the updated map to settings as well (single source of truth).
          this.settingsIpc.setSetting('defaultModelByProvider', next);
          return next;
        });
      }
    });

    // Listen for settings changes from other contexts (multi-window, future
    // remote-config sync, etc.) so this service doesn't go stale.
    this.settingsIpc.onSettingsChanged((data: unknown) => {
      const change = data as { key?: string; value?: unknown; settings?: Record<string, unknown> };
      if (change.key === 'defaultCli' && change.value) {
        this.applySelection(normalizeProvider(change.value), this.selectedModel());
      } else if (change.key === 'defaultModel' && change.value) {
        this.applySelection(this.selectedProvider(), change.value as string);
      } else if (change.key === 'defaultModelByProvider' && isStringRecord(change.value)) {
        this._lastModelByProvider.set({ ...change.value });
      } else if (change.settings) {
        if (isStringRecord(change.settings['defaultModelByProvider'])) {
          this._lastModelByProvider.set({ ...change.settings['defaultModelByProvider'] });
        }
        this.applySelection(
          change.settings['defaultCli']
            ? normalizeProvider(change.settings['defaultCli'])
            : this.selectedProvider(),
          typeof change.settings['defaultModel'] === 'string'
            ? (change.settings['defaultModel'] as string)
            : this.selectedModel(),
        );
      }
    });
  }

  /**
   * Set the selected provider. When switching to a different provider, the
   * model is restored from per-provider memory if available, otherwise the
   * provider's primary model is used. Switching to 'auto' preserves the
   * current model so the auto-router has something to fall back to.
   */
  setProvider(provider: ProviderType): void {
    const current = this.selectedProvider();
    if (provider === current) {
      // No-op: keep model selection intact.
      return;
    }

    if (provider === 'auto') {
      // Preserve the current model — auto-router uses it as a hint.
      this.applySelection(provider, this.selectedModel());
      return;
    }

    const remembered = this.lookupModelForProvider(provider, undefined);
    this.applySelection(provider, remembered);
  }

  /**
   * Set the selected model. Normalizes against the current provider's
   * accepted model list. The persistence effect above writes to both
   * `defaultModel` and `defaultModelByProvider[provider]`.
   */
  setModel(model: string): void {
    this.selectedModel.set(this.resolveModel(this.selectedProvider(), model));
  }

  /**
   * Get the last-remembered model for a specific provider, or the primary
   * model if no memory exists. Useful for components that want to preview
   * what the model picker will show without actually switching.
   */
  getLastModelForProvider(provider: ProviderType): string | undefined {
    if (provider === 'auto') {
      return undefined;
    }
    return this.lookupModelForProvider(provider, undefined);
  }

  /**
   * Record a model selection against a specific provider without changing
   * the currently-selected provider/model. Used by the new-session draft
   * composer when the user picks a model for a provider that isn't the
   * current global selection (e.g. drafting a Copilot session while the
   * dashboard is still on Claude).
   */
  rememberModelForProvider(provider: ProviderType, model: string): void {
    if (provider === 'auto' || !model) {
      return;
    }

    this._lastModelByProvider.update((map) => {
      if (map[provider] === model) return map;
      const next = { ...map, [provider]: model };
      if (this.initialized) {
        this.settingsIpc.setSetting('defaultModelByProvider', next);
      }
      return next;
    });
  }

  /**
   * Get the provider for instance creation (converts 'auto' to undefined).
   */
  getProviderForCreation(): ProviderType | undefined {
    const provider = this.selectedProvider();
    return provider === 'auto' ? undefined : provider;
  }

  /**
   * Get the model for instance creation (for all providers).
   */
  getModelForCreation(): string | undefined {
    const provider = this.selectedProvider();
    return provider === 'auto'
      ? undefined
      : this.resolveModel(provider, this.selectedModel());
  }

  private applySelection(provider: ProviderType, model?: string | null): void {
    this.selectedProvider.set(provider);
    this.selectedModel.set(this.resolveModel(provider, model));
  }

  private resolveModel(provider: ProviderType, model?: string | null): string {
    if (provider === 'auto') {
      return model?.trim() || this.selectedModel() || this.defaultModel;
    }

    return normalizeModelForProvider(
      provider,
      model,
      getPrimaryModelForProvider(provider) ?? this.defaultModel,
    ) ?? this.defaultModel;
  }

  /**
   * Pick the best model for `provider`. Tries:
   *   1. Caller-supplied `requested` (used by hydration to honor settings.defaultModel)
   *   2. Last-used model for this provider
   *   3. Provider's primary model
   *
   * The returned id is always a concrete model id, never 'auto' (callers
   * targeting 'auto' should bypass this and pass through the user's choice).
   */
  private lookupModelForProvider(provider: ProviderType, requested?: string): string {
    if (provider === 'auto') {
      return requested?.trim() || this.selectedModel() || this.defaultModel;
    }

    const remembered = this._lastModelByProvider()[provider];
    const candidate = (requested?.trim()) || remembered || getPrimaryModelForProvider(provider) || this.defaultModel;
    return normalizeModelForProvider(
      provider,
      candidate,
      getPrimaryModelForProvider(provider) ?? this.defaultModel,
    ) ?? this.defaultModel;
  }
}
