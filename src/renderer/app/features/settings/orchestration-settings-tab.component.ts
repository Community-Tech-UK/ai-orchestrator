/**
 * Orchestration Settings Tab Component - Orchestration-related settings
 */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingRowComponent } from './setting-row.component';
import type { AppSettings } from '../../../../shared/types/settings.types';
import { CompactModelPickerComponent } from '../models/compact-model-picker.component';
import type { PendingSelection, PickerProvider } from '../models/compact-model-picker.types';
import { getDefaultModelForCli } from '../../../../shared/types/provider.types';

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
  imports: [SettingRowComponent, CompactModelPickerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="settings-list-card" aria-label="Orchestration settings">
      @for (setting of store.orchestrationSettings(); track setting.key) {
        <app-setting-row
          class="settings-list-item"
          [setting]="setting"
          [value]="store.get(setting.key)"
          (valueChange)="onSettingChange($event)"
        />
      }
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
            <div class="loop-models__picker">
              <span class="loop-models__source">
                {{ modelFor(provider.id) ? 'Pinned override' : 'Session default' }}
              </span>
              <app-compact-model-picker
                mode="pending-create"
                [providers]="[provider.id]"
                [selection]="selectionFor(provider.id)"
                (selectionChange)="onLoopModelPicked(provider.id, $event)"
              />
              <button
                type="button"
                class="loop-models__reset"
                [disabled]="!modelFor(provider.id)"
                [attr.aria-label]="'Use session default for ' + provider.label + ' loops'"
                (click)="resetLoopModel(provider.id)"
              >
                Use default
              </button>
            </div>
          </li>
        }
      </ol>
    </section>
  `,
  styleUrl: './orchestration-settings-tab.component.scss'
})
export class OrchestrationSettingsTabComponent {
  store = inject(SettingsStore);

  readonly loopProviders = computed<LoopProviderView[]>(() =>
    LOOP_PROVIDER_DEFINITIONS.map((provider) => ({ ...provider })),
  );

  /** Current loop model for a provider, or '' when following the session default. */
  modelFor(provider: PickerProvider): string {
    return this.store.get('loopModelByProvider')?.[provider] ?? '';
  }

  selectionFor(provider: PickerProvider): PendingSelection {
    return {
      provider,
      model: this.modelFor(provider) || getDefaultModelForCli(provider) || null,
      reasoning: null,
    };
  }

  onLoopModelPicked(provider: PickerProvider, selection: PendingSelection): void {
    if (selection.provider !== provider || !selection.model) return;
    const next = { ...(this.store.get('loopModelByProvider') ?? {}) };
    next[provider] = selection.model;
    void this.store.set('loopModelByProvider', next);
  }

  resetLoopModel(provider: PickerProvider): void {
    const next = { ...(this.store.get('loopModelByProvider') ?? {}) };
    delete next[provider];
    void this.store.set('loopModelByProvider', next);
  }

  onSettingChange(event: { key: string; value: unknown }): void {
    this.store.set(event.key as keyof AppSettings, event.value as string | number | boolean);
  }
}
