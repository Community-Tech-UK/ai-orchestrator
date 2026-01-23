/**
 * Provider State Service - Shared state for selected provider and model
 * Used to coordinate between dashboard provider selector and instance creation
 * Persists selections to settings for use across sessions
 */

import { Injectable, signal, computed, inject, effect } from '@angular/core';
import { ElectronIpcService } from './electron-ipc.service';
import type { CliType } from '../../../../shared/types/settings.types';

export type ProviderType = 'claude' | 'openai' | 'gemini' | 'copilot' | 'auto';

@Injectable({ providedIn: 'root' })
export class ProviderStateService {
  private ipc = inject(ElectronIpcService);
  private initialized = false;

  /** Currently selected provider */
  readonly selectedProvider = signal<ProviderType>('claude');

  /** Currently selected model (used for Copilot) */
  readonly selectedModel = signal<string>('claude-sonnet-4-5');

  /** Whether Copilot is the selected provider */
  readonly isCopilot = computed(() => this.selectedProvider() === 'copilot');

  constructor() {
    // Load initial values from settings
    this.loadFromSettings();

    // Set up effect to save provider changes (after initialization)
    effect(() => {
      const provider = this.selectedProvider();
      if (this.initialized) {
        this.ipc.setSetting('defaultCli', provider);
      }
    });

    // Set up effect to save model changes (after initialization)
    effect(() => {
      const model = this.selectedModel();
      if (this.initialized) {
        this.ipc.setSetting('defaultCopilotModel', model);
      }
    });

    // Listen for settings changes from other sources
    this.ipc.onSettingsChanged((data: unknown) => {
      const change = data as { key?: string; value?: unknown; settings?: Record<string, unknown> };
      if (change.key === 'defaultCli' && change.value) {
        this.selectedProvider.set(change.value as ProviderType);
      } else if (change.key === 'defaultCopilotModel' && change.value) {
        this.selectedModel.set(change.value as string);
      } else if (change.settings) {
        // Bulk settings update
        if (change.settings['defaultCli']) {
          this.selectedProvider.set(change.settings['defaultCli'] as ProviderType);
        }
        if (change.settings['defaultCopilotModel']) {
          this.selectedModel.set(change.settings['defaultCopilotModel'] as string);
        }
      }
    });
  }

  /**
   * Load initial values from settings
   */
  private async loadFromSettings(): Promise<void> {
    try {
      const response = await this.ipc.getSettings() as { success: boolean; data?: Record<string, unknown> };
      if (response.success && response.data) {
        const settings = response.data;
        if (settings['defaultCli']) {
          this.selectedProvider.set(settings['defaultCli'] as ProviderType);
        }
        if (settings['defaultCopilotModel']) {
          this.selectedModel.set(settings['defaultCopilotModel'] as string);
        }
      }
    } catch (error) {
      console.error('[ProviderStateService] Failed to load settings:', error);
    } finally {
      // Mark as initialized so effects start saving
      this.initialized = true;
    }
  }

  /**
   * Set the selected provider
   */
  setProvider(provider: ProviderType): void {
    this.selectedProvider.set(provider);
  }

  /**
   * Set the selected model
   */
  setModel(model: string): void {
    this.selectedModel.set(model);
  }

  /**
   * Get the provider for instance creation (converts 'auto' to undefined)
   */
  getProviderForCreation(): ProviderType | undefined {
    const provider = this.selectedProvider();
    return provider === 'auto' ? undefined : provider;
  }

  /**
   * Get the model for instance creation (only for Copilot)
   */
  getModelForCreation(): string | undefined {
    return this.isCopilot() ? this.selectedModel() : undefined;
  }
}
