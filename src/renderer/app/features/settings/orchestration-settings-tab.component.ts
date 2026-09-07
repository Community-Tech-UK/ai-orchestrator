/**
 * Orchestration Settings Tab Component - Orchestration-related settings
 */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingsTieredRowListComponent } from './settings-tiered-row-list.component';
import { RoutingMatrixComponent } from './routing-matrix.component';
import type { AppSettings } from '../../../../shared/types/settings.types';
import type { PickerProvider } from '../models/compact-model-picker.types';
import { getDefaultModelForCli } from '../../../../shared/types/provider.types';
import { ProviderModelOverrideComponent } from './provider-model-override.component';

/** Providers that can run a loop. Mirrors LoopProvider in loop.types.ts. */
const LOOP_PROVIDER_DEFINITIONS: readonly { id: PickerProvider; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'OpenAI Codex CLI' },
  { id: 'gemini', label: 'Gemini CLI' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'cursor', label: 'Cursor CLI' },
  { id: 'grok', label: 'Grok Build' },
] as const;

interface LoopProviderView {
  id: PickerProvider;
  label: string;
}

@Component({
  selector: 'app-orchestration-settings-tab',
  standalone: true,
  imports: [ProviderModelOverrideComponent, RoutingMatrixComponent, SettingsTieredRowListComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="settings-list-card" aria-label="Orchestration settings">
      <app-settings-tiered-row-list
        [settings]="store.orchestrationSettings()"
        [valueFor]="readSetting"
        (valueChange)="onSettingChange($event)"
      />
    </section>

    <section class="settings-list-card" aria-label="Model routing">
      <!-- S4.2: orchestrationRoutingPolicyJson previously had no UI at all, so
           the only way to move an expensive gate onto a cheaper model was to
           hand-edit JSON through the settings CLI. -->
      <app-routing-matrix />
    </section>

    <section class="settings-list-card loop-models" aria-label="Loop models">
      <header class="loop-models__header">
        <h3 class="loop-models__title">Loop model</h3>
        <p class="loop-models__hint">
          The model each provider uses for automated loop iterations and
          orchestration steps. This is separate from the model a new chat starts
          on: loops are the highest-volume path in the app, so they get their own
          choice rather than silently inheriting the interactive default.
          <strong>Session default</strong> means "use whatever a new chat would use".
        </p>
      </header>

      <ol class="loop-models__list">
        @for (provider of loopProviders(); track provider.id) {
          <li class="loop-models__item">
            <span class="loop-models__name">{{ provider.label }}</span>
            <app-provider-model-override
              class="loop-models__picker"
              settingsKey="loopModelByProvider"
              [provider]="provider.id"
              unpinnedSourceLabel="Session default"
              resetLabel="Use default"
              [resetAriaLabel]="'Use session default for ' + provider.label + ' loops'"
              [unpinnedModel]="defaultModelFor(provider.id)"
            />
          </li>
        }
      </ol>
    </section>
  `,
  styleUrl: './orchestration-settings-tab.component.scss'
})
export class OrchestrationSettingsTabComponent {
  store = inject(SettingsStore);

  /** Read a value by key. A bound arrow so the template can pass it as a value. */
  protected readonly readSetting = (key: string): unknown =>
    this.store.get(key as keyof AppSettings);

  readonly loopProviders = computed<LoopProviderView[]>(() =>
    LOOP_PROVIDER_DEFINITIONS.map((provider) => ({ ...provider })),
  );

  /** What the picker shows for a provider with nothing pinned. */
  defaultModelFor(provider: PickerProvider): string | null {
    return getDefaultModelForCli(provider) || null;
  }

  onSettingChange(event: { key: string; value: unknown }): void {
    this.store.set(event.key as keyof AppSettings, event.value as string | number | boolean);
  }
}
