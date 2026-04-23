/**
 * Provider State Service - Shared state for selected provider and model
 * Used to coordinate between dashboard provider selector and instance creation
 * Persists selections to settings for use across sessions
 */

import { Injectable, signal, computed, inject, effect } from '@angular/core';
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

@Injectable({ providedIn: 'root' })
export class ProviderStateService {
  private settingsStore = inject(SettingsStore);
  private settingsIpc = inject(SettingsIpcService);
  private initialized = false;
  private readonly defaultModel = getPrimaryModelForProvider('claude') ?? 'opus';

  /** Currently selected provider */
  readonly selectedProvider = signal<ProviderType>('claude');

  /** Currently selected model */
  readonly selectedModel = signal<string>(this.defaultModel);

  /** Whether Copilot is the selected provider */
  readonly isCopilot = computed(() => this.selectedProvider() === 'copilot');

  constructor() {
    // Load initial values from SettingsStore once settings are populated
    effect(() => {
      const settings = this.settingsStore.settings();
      if (!this.initialized) {
        this.applySelection(
          settings.defaultCli ? normalizeProvider(settings.defaultCli) : this.selectedProvider(),
          settings.defaultModel,
        );
        // Mark initialized once we've had a chance to read non-default settings
        // (settings are loaded asynchronously; the store starts with DEFAULT_SETTINGS)
        this.initialized = true;
      }
    });

    // Set up effect to save provider changes (after initialization)
    effect(() => {
      const provider = this.selectedProvider();
      if (this.initialized) {
        this.settingsIpc.setSetting('defaultCli', provider);
      }
    });

    // Set up effect to save model changes (after initialization)
    effect(() => {
      const model = this.selectedModel();
      if (this.initialized) {
        this.settingsIpc.setSetting('defaultModel', model);
      }
    });

    // Listen for settings changes from other sources
    this.settingsIpc.onSettingsChanged((data: unknown) => {
      const change = data as { key?: string; value?: unknown; settings?: Record<string, unknown> };
      if (change.key === 'defaultCli' && change.value) {
        this.applySelection(normalizeProvider(change.value), this.selectedModel());
      } else if (change.key === 'defaultModel' && change.value) {
        this.applySelection(this.selectedProvider(), change.value as string);
      } else if (change.settings) {
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
   * Set the selected provider
   */
  setProvider(provider: ProviderType): void {
    if (provider === this.selectedProvider()) {
      this.applySelection(provider, this.selectedModel());
      return;
    }

    this.applySelection(
      provider,
      provider === 'auto' ? this.selectedModel() : undefined,
    );
  }

  /**
   * Set the selected model
   */
  setModel(model: string): void {
    this.selectedModel.set(this.resolveModel(this.selectedProvider(), model));
  }

  /**
   * Get the provider for instance creation (converts 'auto' to undefined)
   */
  getProviderForCreation(): ProviderType | undefined {
    const provider = this.selectedProvider();
    return provider === 'auto' ? undefined : provider;
  }

  /**
   * Get the model for instance creation (for all providers)
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
}
