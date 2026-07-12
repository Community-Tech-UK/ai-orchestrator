/**
 * Orchestration Settings Tab Component - Orchestration-related settings
 */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingRowComponent } from './setting-row.component';
import type { AppSettings } from '../../../../shared/types/settings.types';
import { getModelsForProvider, type ModelDisplayInfo } from '../../../../shared/types/provider.types';
import { UnifiedCatalogStore } from '../models/unified-catalog.store';
import { resolveReviewerModels } from './reviewer-model-options';

/** Providers that can run a loop. Mirrors LoopProvider in loop.types.ts. */
const LOOP_PROVIDER_DEFINITIONS: readonly { id: string; label: string }[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'OpenAI Codex CLI' },
  { id: 'gemini', label: 'Gemini CLI' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'cursor', label: 'Cursor CLI' },
  { id: 'grok', label: 'Grok Build' },
] as const;

interface LoopProviderView {
  id: string;
  label: string;
  models: ModelDisplayInfo[];
}

@Component({
  selector: 'app-orchestration-settings-tab',
  standalone: true,
  imports: [SettingRowComponent],
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
            <!--
              [selected] on each option, not [value] on the select: binding the
              value property alone sets it before the @for options exist, so the
              browser silently resets it to the first option and the picker lies
              about what loops will actually run.
            -->
            <select
              class="loop-models__select"
              [attr.aria-label]="provider.label + ' loop model'"
              (change)="onLoopModelChange(provider.id, $event)"
            >
              <option value="" [selected]="modelFor(provider.id) === ''">Session default</option>
              @for (model of provider.models; track model.id) {
                <option [value]="model.id" [selected]="model.id === modelFor(provider.id)">
                  {{ model.name }}
                </option>
              }
            </select>
          </li>
        }
      </ol>
    </section>
  `,
  styleUrl: './orchestration-settings-tab.component.scss'
})
export class OrchestrationSettingsTabComponent {
  store = inject(SettingsStore);
  private unifiedCatalog = inject(UnifiedCatalogStore);

  constructor() {
    this.unifiedCatalog.ensureLoaded();
  }

  readonly loopProviders = computed<LoopProviderView[]>(() =>
    LOOP_PROVIDER_DEFINITIONS.map((provider) => ({
      ...provider,
      models: resolveReviewerModels(
        this.unifiedCatalog.displayModelsForProvider(provider.id),
        getModelsForProvider(provider.id),
      ),
    })),
  );

  /** Current loop model for a provider, or '' when following the session default. */
  modelFor(provider: string): string {
    return this.store.get('loopModelByProvider')?.[provider] ?? '';
  }

  onLoopModelChange(provider: string, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    const next = { ...(this.store.get('loopModelByProvider') ?? {}) };
    if (!value) {
      // Empty = follow the provider's interactive default (pre-existing behaviour).
      delete next[provider];
    } else {
      next[provider] = value;
    }
    void this.store.set('loopModelByProvider', next);
  }

  onSettingChange(event: { key: string; value: unknown }): void {
    this.store.set(event.key as keyof AppSettings, event.value as string | number | boolean);
  }
}
