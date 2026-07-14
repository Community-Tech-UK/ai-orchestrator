/**
 * General Settings Tab Component - General application preferences
 */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingRowComponent } from './setting-row.component';
import type { AppSettings } from '../../../../shared/types/settings.types';
import { getPrimaryModelForProvider } from '../../../../shared/types/provider.types';
import { AppUpdateSettingsComponent } from './app-update-settings.component';
import { CompactModelPickerComponent } from '../models/compact-model-picker.component';
import type { PendingSelection, PickerProvider } from '../models/compact-model-picker.types';

type DefaultModelProvider = Exclude<PickerProvider, 'local-model'>;

const DEFAULT_MODEL_PROVIDERS: DefaultModelProvider[] = [
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'copilot',
  'cursor',
  'grok',
];

@Component({
  selector: 'app-general-settings-tab',
  standalone: true,
  imports: [SettingRowComponent, AppUpdateSettingsComponent, CompactModelPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="settings-list-card default-model" aria-label="Default provider and model">
      <div class="default-model__info">
        <span class="default-model__label">Default provider and model</span>
        <p class="default-model__description">
          New sessions use this choice. Auto picks an installed CLI. Pinned remembers
          a separate model for each provider.
        </p>
      </div>
      <div class="default-model__control">
        <div class="default-model__modes" role="group" aria-label="Default model routing">
          <button
            type="button"
            class="default-model__mode"
            [class.is-active]="defaultProvider() === 'auto'"
            [attr.aria-pressed]="defaultProvider() === 'auto'"
            aria-label="Automatically choose the default provider"
            (click)="useAutomaticProvider()"
          >
            Auto
          </button>
          <button
            type="button"
            class="default-model__mode"
            [class.is-active]="defaultProvider() !== 'auto'"
            [attr.aria-pressed]="defaultProvider() !== 'auto'"
            aria-label="Pin the default provider and model"
            (click)="pinDefaultProvider()"
          >
            Pinned
          </button>
        </div>
        @if (defaultProvider() === 'auto') {
          <span class="default-model__hint">An installed provider will be chosen automatically.</span>
        } @else {
          <app-compact-model-picker
            mode="pending-create"
            [providers]="defaultModelProviders"
            [selection]="defaultModelSelection()"
            (selectionChange)="onDefaultModelPicked($event)"
          />
        }
      </div>
    </section>

    <section class="settings-list-card" aria-label="General settings">
      @for (setting of genericGeneralSettings(); track setting.key) {
        <app-setting-row
          class="settings-list-item"
          [setting]="setting"
          [value]="store.get(setting.key)"
          (valueChange)="onSettingChange($event)"
        />
      }
    </section>
    <app-update-settings />
  `,
  styleUrl: './general-settings-tab.component.scss'
})
export class GeneralSettingsTabComponent {
  store = inject(SettingsStore);
  readonly defaultModelProviders = DEFAULT_MODEL_PROVIDERS;

  readonly genericGeneralSettings = computed(() =>
    this.store.generalSettings().filter(
      (setting) => setting.key !== 'defaultCli' && setting.key !== 'defaultModel',
    ),
  );

  readonly defaultProvider = computed<DefaultModelProvider | 'auto'>(() => {
    const provider = this.store.settings().defaultCli;
    if (provider === 'openai') return 'codex';
    return DEFAULT_MODEL_PROVIDERS.includes(provider as DefaultModelProvider)
      ? provider as DefaultModelProvider
      : 'auto';
  });

  readonly defaultModelSelection = computed<PendingSelection>(() => {
    const provider = this.defaultProvider();
    const concreteProvider: DefaultModelProvider = provider === 'auto' ? 'claude' : provider;
    const settings = this.store.settings();
    const remembered = settings.defaultModelByProvider?.[concreteProvider];
    const legacy = provider === concreteProvider ? settings.defaultModel : undefined;
    return {
      provider: concreteProvider,
      model: remembered || legacy || getPrimaryModelForProvider(concreteProvider) || null,
      reasoning: null,
    };
  });

  useAutomaticProvider(): void {
    void this.store.update({ defaultCli: 'auto' });
  }

  pinDefaultProvider(): void {
    if (this.defaultProvider() !== 'auto') return;
    const selection = this.defaultModelSelection();
    if (selection.provider === 'local-model' || !selection.model) return;
    this.persistDefaultSelection(selection.provider, selection.model);
  }

  onDefaultModelPicked(selection: PendingSelection): void {
    if (selection.provider === 'local-model' || !selection.model) return;
    this.persistDefaultSelection(selection.provider, selection.model);
  }

  onSettingChange(event: { key: string; value: unknown }): void {
    this.store.set(event.key as keyof AppSettings, event.value as AppSettings[keyof AppSettings]);
  }

  private persistDefaultSelection(provider: DefaultModelProvider, model: string): void {
    void this.store.update({
      defaultCli: provider,
      defaultModel: model,
      defaultModelByProvider: {
        ...(this.store.settings().defaultModelByProvider ?? {}),
        [provider]: model,
      },
    });
  }
}
