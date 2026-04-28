/**
 * Provider Selector Component - Dropdown to select CLI provider
 *
 * Displays available CLI providers (Claude, Codex, Gemini, Copilot, Cursor) and
 * allows switching between them for new instances. For Copilot, also allows
 * model selection.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  OnInit,
  output,
  signal
} from '@angular/core';
import { CliStore } from '../../core/state/cli.store';

export type ProviderType = 'claude' | 'codex' | 'gemini' | 'copilot' | 'cursor' | 'auto';

export interface ProviderOption {
  id: ProviderType;
  name: string;
  description: string;
  color: string;
  icon: string;
  available: boolean;
}

@Component({
  selector: 'app-provider-selector',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="provider-selector" [class.open]="isOpen()">
      <button
        class="selected-provider"
        [style.border-color]="selectedProvider().color"
        (click)="toggleDropdown()"
        title="Select CLI provider for new instances"
      >
        <span class="provider-icon" [style.color]="selectedProvider().color">
          @switch (selectedProvider().icon) {
            @case ('anthropic') {
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 1.75c.48 0 .87.39.87.87v4.04a.87.87 0 1 1-1.74 0V2.62c0-.48.39-.87.87-.87Z"/>
                <path d="M17.88 3.33c.41.24.55.77.32 1.19l-2.02 3.5a.87.87 0 1 1-1.5-.87l2.02-3.5a.87.87 0 0 1 1.18-.32Z"/>
                <path d="M21.82 7.47c.24.41.1.95-.32 1.18L18 10.67a.87.87 0 0 1-.87-1.5l3.5-2.02a.87.87 0 0 1 1.19.32Z"/>
                <path d="M22.25 12c0 .48-.39.87-.87.87h-4.04a.87.87 0 1 1 0-1.74h4.04c.48 0 .87.39.87.87Z"/>
                <path d="M20.67 17.88a.87.87 0 0 1-1.18.32l-3.5-2.02a.87.87 0 1 1 .87-1.5l3.5 2.02c.41.24.55.77.31 1.18Z"/>
                <path d="M16.53 21.82a.87.87 0 0 1-1.18-.32l-2.02-3.5a.87.87 0 1 1 1.5-.87l2.02 3.5c.24.41.1.95-.32 1.19Z"/>
                <path d="M12 22.25a.87.87 0 0 1-.87-.87v-4.04a.87.87 0 1 1 1.74 0v4.04c0 .48-.39.87-.87.87Z"/>
                <path d="M7.47 20.67a.87.87 0 0 1-.32-1.18l2.02-3.5a.87.87 0 1 1 1.5.87l-2.02 3.5a.87.87 0 0 1-1.18.31Z"/>
                <path d="M3.33 16.53a.87.87 0 0 1 .32-1.18l3.5-2.02a.87.87 0 1 1 .87 1.5l-3.5 2.02a.87.87 0 0 1-1.19-.32Z"/>
                <path d="M1.75 12c0-.48.39-.87.87-.87h4.04a.87.87 0 1 1 0 1.74H2.62a.87.87 0 0 1-.87-.87Z"/>
                <path d="M3.33 7.47a.87.87 0 0 1 1.18-.32l3.5 2.02a.87.87 0 1 1-.87 1.5l-3.5-2.02a.87.87 0 0 1-.31-1.18Z"/>
                <path d="M7.47 3.33c.41-.24.95-.1 1.18.32l2.02 3.5a.87.87 0 1 1-1.5.87l-2.02-3.5a.87.87 0 0 1 .32-1.19Z"/>
                <circle cx="12" cy="12" r="1.65"/>
              </svg>
            }
            @case ('openai') {
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.985 5.985 0 0 0 .517 4.91 6.046 6.046 0 0 0 6.51 2.9A6.065 6.065 0 0 0 19.02 19.81a5.985 5.985 0 0 0 3.998-2.9 6.046 6.046 0 0 0-.736-7.09z"/>
              </svg>
            }
            @case ('google') {
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
            }
            @case ('github') {
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
              </svg>
            }
            @case ('cursor') {
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2 L20 7 L20 17 L12 22 L4 17 L4 7 Z"/>
              </svg>
            }
            @default {
              <span class="icon-symbol">&#9679;</span>
            }
          }
        </span>
        <span class="provider-name">{{ selectedProvider().name }}</span>
        <span class="dropdown-arrow">{{
          isOpen() ? '&#9650;' : '&#9660;'
        }}</span>
      </button>

      @if (isOpen()) {
        <div class="dropdown-menu" (click)="$event.stopPropagation()" (keydown.enter)="$event.stopPropagation()" (keydown.space)="$event.stopPropagation()" tabindex="0" role="button">
          @for (provider of availableProviders(); track provider.id) {
            <button
              class="provider-option"
              [class.selected]="provider.id === selectedProvider().id"
              [class.disabled]="!provider.available"
              [style.border-left-color]="provider.color"
              (click)="selectProvider(provider)"
              [disabled]="!provider.available"
            >
              <span class="provider-icon" [style.color]="provider.color">
                @switch (provider.icon) {
                  @case ('anthropic') {
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 1.75c.48 0 .87.39.87.87v4.04a.87.87 0 1 1-1.74 0V2.62c0-.48.39-.87.87-.87Z"/>
                      <path d="M17.88 3.33c.41.24.55.77.32 1.19l-2.02 3.5a.87.87 0 1 1-1.5-.87l2.02-3.5a.87.87 0 0 1 1.18-.32Z"/>
                      <path d="M21.82 7.47c.24.41.1.95-.32 1.18L18 10.67a.87.87 0 0 1-.87-1.5l3.5-2.02a.87.87 0 0 1 1.19.32Z"/>
                      <path d="M22.25 12c0 .48-.39.87-.87.87h-4.04a.87.87 0 1 1 0-1.74h4.04c.48 0 .87.39.87.87Z"/>
                      <path d="M20.67 17.88a.87.87 0 0 1-1.18.32l-3.5-2.02a.87.87 0 1 1 .87-1.5l3.5 2.02c.41.24.55.77.31 1.18Z"/>
                      <path d="M16.53 21.82a.87.87 0 0 1-1.18-.32l-2.02-3.5a.87.87 0 1 1 1.5-.87l2.02 3.5c.24.41.1.95-.32 1.19Z"/>
                      <path d="M12 22.25a.87.87 0 0 1-.87-.87v-4.04a.87.87 0 1 1 1.74 0v4.04c0 .48-.39.87-.87.87Z"/>
                      <path d="M7.47 20.67a.87.87 0 0 1-.32-1.18l2.02-3.5a.87.87 0 1 1 1.5.87l-2.02 3.5a.87.87 0 0 1-1.18.31Z"/>
                      <path d="M3.33 16.53a.87.87 0 0 1 .32-1.18l3.5-2.02a.87.87 0 1 1 .87 1.5l-3.5 2.02a.87.87 0 0 1-1.19-.32Z"/>
                      <path d="M1.75 12c0-.48.39-.87.87-.87h4.04a.87.87 0 1 1 0 1.74H2.62a.87.87 0 0 1-.87-.87Z"/>
                      <path d="M3.33 7.47a.87.87 0 0 1 1.18-.32l3.5 2.02a.87.87 0 1 1-.87 1.5l-3.5-2.02a.87.87 0 0 1-.31-1.18Z"/>
                      <path d="M7.47 3.33c.41-.24.95-.1 1.18.32l2.02 3.5a.87.87 0 1 1-1.5.87l-2.02-3.5a.87.87 0 0 1 .32-1.19Z"/>
                      <circle cx="12" cy="12" r="1.65"/>
                    </svg>
                  }
                  @case ('openai') {
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.985 5.985 0 0 0 .517 4.91 6.046 6.046 0 0 0 6.51 2.9A6.065 6.065 0 0 0 19.02 19.81a5.985 5.985 0 0 0 3.998-2.9 6.046 6.046 0 0 0-.736-7.09z"/>
                    </svg>
                  }
                  @case ('google') {
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                      <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                      <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                      <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                  }
                  @case ('github') {
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/>
                    </svg>
                  }
                  @case ('cursor') {
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 2 L20 7 L20 17 L12 22 L4 17 L4 7 Z"/>
                    </svg>
                  }
                  @default {
                    <span class="icon-symbol">&#9679;</span>
                  }
                }
              </span>
              <div class="provider-info">
                <span class="provider-name">{{ provider.name }}</span>
                <span class="provider-description">
                  {{ provider.available ? provider.description : 'Not installed' }}
                </span>
              </div>
            </button>
          }
        </div>
      }
    </div>

    @if (isOpen()) {
      <div class="backdrop" (click)="closeDropdown()" (keydown.enter)="closeDropdown()" (keydown.space)="closeDropdown()" tabindex="0" role="button"></div>
    }
  `,
  styles: [
    `
      :host {
        position: relative;
        display: inline-block;
      }

      .provider-selector {
        position: relative;
        z-index: var(--z-dropdown);
      }

      .provider-selector.open {
        z-index: var(--z-overlay);
      }

      .selected-provider {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        height: 36px;
        box-sizing: border-box;
        background: var(--bg-secondary);
        border: 1px solid;
        border-radius: 6px;
        color: var(--text-primary);
        cursor: pointer;
        transition: all var(--transition-fast);
        font-size: 13px;
      }

      .selected-provider:hover {
        background: var(--bg-tertiary);
      }

      .provider-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
      }

      .icon-symbol {
        display: inline-block;
        width: 16px;
        text-align: center;
      }

      .provider-name {
        font-weight: 500;
      }

      .dropdown-arrow {
        font-size: 10px;
        opacity: 0.6;
      }

      .dropdown-menu {
        position: absolute;
        top: 100%;
        left: 0;
        right: 0;
        min-width: 200px;
        margin-top: 4px;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 8px;
        box-shadow: var(--shadow-lg);
        overflow: hidden;
        z-index: 1;
      }

      .provider-option {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        padding: 10px 12px;
        background: transparent;
        border: none;
        border-left: 3px solid transparent;
        color: var(--text-primary);
        cursor: pointer;
        text-align: left;
        transition: all var(--transition-fast);
      }

      .provider-option:hover:not(.disabled) {
        background: var(--bg-tertiary);
      }

      .provider-option.selected {
        background: var(--bg-tertiary);
      }

      .provider-option.disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .provider-info {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .provider-info .provider-name {
        font-size: 13px;
      }

      .provider-description {
        font-size: 11px;
        color: var(--text-secondary);
      }

      .backdrop {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: var(--z-sticky);
      }
    `
  ]
})
export class ProviderSelectorComponent implements OnInit {
  private cliStore = inject(CliStore);

  provider = input<ProviderType | null>(null);

  // Outputs
  providerSelected = output<ProviderType>();

  // Local state
  protected isOpen = signal(false);
  protected selectedProviderId = signal<ProviderType>('claude');

  // Show badge when Copilot is selected (indicates model can be chosen in main area)
  protected showCopilotBadge = computed(() => this.selectedProviderId() === 'copilot');

  // All provider options
  protected allProviders: ProviderOption[] = [
    {
      id: 'claude',
      name: 'Claude',
      description: 'Anthropic Claude Code CLI',
      color: '#D97706',
      icon: 'anthropic',
      available: true,
    },
    {
      id: 'codex',
      name: 'Codex',
      description: 'OpenAI Codex CLI',
      color: '#10A37F',
      icon: 'openai',
      available: true,
    },
    {
      id: 'gemini',
      name: 'Gemini',
      description: 'Google Gemini CLI',
      color: '#4285F4',
      icon: 'google',
      available: true,
    },
    {
      id: 'copilot',
      name: 'Copilot',
      description: 'GitHub Copilot CLI',
      color: '#6e40c9',
      icon: 'github',
      available: true,
    },
    {
      id: 'cursor',
      name: 'Cursor CLI',
      description: 'Cursor CLI (cursor-agent)',
      color: '#000000',
      icon: 'cursor',
      available: true,
    },
  ];

  // Computed: available providers with availability check
  protected availableProviders = computed(() => {
    const detectedClis = this.cliStore.availableClis();
    return this.allProviders.map(provider => ({
      ...provider,
      available: detectedClis.some(cli =>
        cli.name === provider.id ||
        // Map 'copilot' provider to 'copilot' CLI detection
        (provider.id === 'copilot' && cli.name === 'copilot')
      ),
    }));
  });

  // Computed: selected provider object
  protected selectedProvider = computed(() => {
    const id = this.selectedProviderId();
    return this.availableProviders().find(p => p.id === id) || this.availableProviders()[0];
  });

  constructor() {
    effect(() => {
      const requested = this.provider();
      if (!requested) return;

      const availableProviders = this.availableProviders();
      const matchingProvider = availableProviders.find(
        provider => provider.id === requested && provider.available
      );

      if (matchingProvider && matchingProvider.id !== this.selectedProviderId()) {
        this.selectedProviderId.set(matchingProvider.id);
      }
    });
  }

  ngOnInit(): void {
    const requested = this.provider();
    const availableProviders = this.availableProviders();
    const selected = (requested
      ? availableProviders.find(provider => provider.id === requested && provider.available)
      : undefined) || availableProviders.find(provider => provider.available);

    if (selected) {
      this.selectedProviderId.set(selected.id);
      if (requested !== selected.id) {
        this.providerSelected.emit(selected.id);
      }
    }
  }

  toggleDropdown(): void {
    this.isOpen.update((v) => !v);
  }

  closeDropdown(): void {
    this.isOpen.set(false);
  }

  selectProvider(provider: ProviderOption): void {
    if (!provider.available) return;
    this.selectedProviderId.set(provider.id);
    this.providerSelected.emit(provider.id);
    this.closeDropdown();
  }

  // Public method to get current selection
  getSelectedProvider(): ProviderType {
    return this.selectedProviderId();
  }
}
