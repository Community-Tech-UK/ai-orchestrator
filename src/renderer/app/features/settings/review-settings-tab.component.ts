/**
 * Review Settings Tab Component - Cross-model review settings
 */

import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingRowComponent } from './setting-row.component';
import type { AppSettings } from '../../../../shared/types/settings.types';
import { getModelsForProvider } from '../../../../shared/types/provider.types';

/**
 * Reviewer CLIs that can run a cross-model review. Mirrors
 * `SUPPORTED_REVIEWER_CLIS` in
 * src/main/orchestration/cross-model-review-service.constants.ts. Kept as a
 * local copy because the renderer cannot import main-process modules; update
 * both if the supported set changes.
 */
const REVIEWER_PROVIDERS: { id: string; label: string }[] = [
  { id: 'gemini', label: 'Gemini CLI' },
  { id: 'codex', label: 'OpenAI Codex CLI' },
  { id: 'copilot', label: 'GitHub Copilot' },
  { id: 'cursor', label: 'Cursor CLI' },
];

@Component({
  selector: 'app-review-settings-tab',
  standalone: true,
  imports: [SettingRowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="settings-list-card" aria-label="Cross-model review settings">
      @for (setting of store.reviewSettings(); track setting.key) {
        <app-setting-row
          class="settings-list-item"
          [setting]="setting"
          [value]="store.get(setting.key)"
          (valueChange)="onSettingChange($event)"
        />
      }
    </section>

    <section class="settings-list-card reviewer-model-overrides" aria-label="Reviewer model overrides">
      <header class="reviewer-model-overrides__header">
        <div class="reviewer-model-overrides__title">Reviewer models</div>
        <p class="reviewer-model-overrides__hint">
          Pick the model each reviewer CLI uses. "Auto" lets that provider's CLI
          choose (e.g. Copilot auto-routes to a GPT model).
        </p>
      </header>

      @for (provider of reviewerProviders; track provider.id) {
        <div class="settings-list-item reviewer-model-row">
          <label class="reviewer-model-row__label" [attr.for]="'review-model-' + provider.id">
            {{ provider.label }}
          </label>
          <select
            class="reviewer-model-row__select"
            [id]="'review-model-' + provider.id"
            [value]="modelFor(provider.id)"
            (change)="onModelChange(provider.id, $event)"
          >
            <option value="">Auto (let provider decide)</option>
            @for (model of provider.models; track model.id) {
              <option [value]="model.id">{{ model.name }}</option>
            }
          </select>
        </div>
      }
    </section>
  `,
  styleUrl: './review-settings-tab.component.scss',
})
export class ReviewSettingsTabComponent {
  store = inject(SettingsStore);

  readonly reviewerProviders = REVIEWER_PROVIDERS.map((provider) => ({
    ...provider,
    models: getModelsForProvider(provider.id),
  }));

  onSettingChange(event: { key: string; value: unknown }): void {
    this.store.set(event.key as keyof AppSettings, event.value as string | number | boolean);
  }

  /** Current override model id for a reviewer, or '' when on auto. */
  modelFor(provider: string): string {
    return this.store.get('crossModelReviewModelByProvider')?.[provider] ?? '';
  }

  onModelChange(provider: string, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    const next = { ...(this.store.get('crossModelReviewModelByProvider') ?? {}) };
    if (!value) {
      // Empty = auto: drop the key so we fall back to CLI default routing.
      delete next[provider];
    } else {
      next[provider] = value;
    }
    void this.store.set('crossModelReviewModelByProvider', next);
  }
}
