/**
 * General Settings Tab Component - General application preferences
 */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingsTieredRowListComponent } from './settings-tiered-row-list.component';
import { SettingsProfileRowComponent } from './settings-profile-row.component';
import { InlineHintComponent } from '../../shared/hint/inline-hint.component';
import { activeProfile } from '../../../../shared/types/settings-profiles';
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
  imports: [
    AppUpdateSettingsComponent,
    CompactModelPickerComponent,
    SettingsProfileRowComponent,
    InlineHintComponent, SettingsTieredRowListComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- UX4.2: this compound picker IS the row for both keys, so it carries
         their search anchors; there is no generic row to land on. -->
    <section
      class="settings-list-card default-model"
      aria-label="Default provider and model"
      data-setting-key="defaultCli"
    >
      <div class="default-model__info">
        <span class="default-model__label">Default provider and model</span>
        <p class="default-model__description">
          New sessions use this choice. Auto picks an installed CLI. Pinned remembers
          a separate model for each provider.
        </p>
      </div>
      <div class="default-model__control" data-setting-key="defaultModel">
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

    <section class="settings-list-card default-model" aria-label="Default automation model">
      <div class="default-model__info">
        <span class="default-model__label">Default automation model</span>
        <p class="default-model__description">
          Automations whose Model is set to Auto use this. It is kept separate from the
          session default above, so it never changes when you switch models in a chat.
        </p>
      </div>
      <div class="default-model__control">
        <div class="default-model__modes" role="group" aria-label="Default automation model routing">
          <button
            type="button"
            class="default-model__mode"
            [class.is-active]="automationProvider() === 'auto'"
            [attr.aria-pressed]="automationProvider() === 'auto'"
            aria-label="Let each automation fall back to the provider default"
            (click)="useAutomaticAutomationProvider()"
          >
            Auto
          </button>
          <button
            type="button"
            class="default-model__mode"
            [class.is-active]="automationProvider() !== 'auto'"
            [attr.aria-pressed]="automationProvider() !== 'auto'"
            aria-label="Pin the default automation provider and model"
            (click)="pinAutomationProvider()"
          >
            Pinned
          </button>
        </div>
        @if (automationProvider() === 'auto') {
          <span class="default-model__hint">Leave unset and Auto automations inherit your last-used model per provider — the same value that leaks between chats. Pin one to keep them stable.</span>
        } @else {
          <app-compact-model-picker
            mode="pending-create"
            [providers]="defaultModelProviders"
            [selection]="automationModelSelection()"
            (selectionChange)="onAutomationModelPicked($event)"
          />
        }
      </div>
    </section>

    <section class="settings-list-card" aria-label="Run profile">
      <!-- UX5: earned, not shown on every visit — it appears only once the user
           has enough instances for profiles to be worth explaining. -->
      <app-inline-hint hintId="settings-overview-profiles" [condition]="hasNotFoundProfiles()" />
      <app-settings-profile-row class="settings-list-item" />
    </section>

    <section class="settings-list-card" aria-label="General settings">
      <app-settings-tiered-row-list
        [settings]="genericGeneralSettings()"
        [valueFor]="readSetting"
        (valueChange)="onSettingChange($event)"
      />
    </section>
    <app-update-settings />
  `,
  styleUrl: './general-settings-tab.component.scss'
})
export class GeneralSettingsTabComponent {
  store = inject(SettingsStore);

  /** Read a value by key. A bound arrow so the template can pass it as a value. */
  protected readonly readSetting = (key: string): unknown =>
    this.store.get(key as keyof AppSettings);
  readonly defaultModelProviders = DEFAULT_MODEL_PROVIDERS;

  /**
   * UX5 gate: mention profiles only to someone still on the interactive
   * defaults, i.e. who has not found them. Once you are on Overnight — or have
   * hand-tuned a custom mix — the hint has nothing left to tell you, so it
   * stops appearing without ever needing to be dismissed.
   */
  protected readonly hasNotFoundProfiles = computed(
    () => activeProfile(this.store.settings()) === 'interactive',
  );

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

  readonly automationProvider = computed<DefaultModelProvider | 'auto'>(() => {
    const provider = this.store.settings().automationDefaultCli;
    if (provider === 'openai') return 'codex';
    return DEFAULT_MODEL_PROVIDERS.includes(provider as DefaultModelProvider)
      ? provider as DefaultModelProvider
      : 'auto';
  });

  readonly automationModelSelection = computed<PendingSelection>(() => {
    const provider = this.automationProvider();
    const concreteProvider: DefaultModelProvider = provider === 'auto' ? 'claude' : provider;
    const model = this.store.settings().automationDefaultModel;
    return {
      provider: concreteProvider,
      model: model || getPrimaryModelForProvider(concreteProvider) || null,
      reasoning: null,
    };
  });

  useAutomaticAutomationProvider(): void {
    void this.store.update({ automationDefaultCli: 'auto', automationDefaultModel: '' });
  }

  pinAutomationProvider(): void {
    if (this.automationProvider() !== 'auto') return;
    const selection = this.automationModelSelection();
    if (selection.provider === 'local-model' || !selection.model) return;
    this.persistAutomationSelection(selection.provider, selection.model);
  }

  onAutomationModelPicked(selection: PendingSelection): void {
    if (selection.provider === 'local-model' || !selection.model) return;
    this.persistAutomationSelection(selection.provider, selection.model);
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

  private persistAutomationSelection(provider: DefaultModelProvider, model: string): void {
    void this.store.update({
      automationDefaultCli: provider,
      automationDefaultModel: model,
    });
  }
}
