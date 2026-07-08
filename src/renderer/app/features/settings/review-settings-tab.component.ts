/**
 * Review Settings Tab Component - Cross-model review settings
 */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingRowComponent } from './setting-row.component';
import type { AppSettings } from '../../../../shared/types/settings.types';
import { getModelsForProvider, type ModelDisplayInfo } from '../../../../shared/types/provider.types';
import { UnifiedCatalogStore } from '../models/unified-catalog.store';
import { resolveReviewerModels } from './reviewer-model-options';

/**
 * Reviewer CLIs that can run a cross-model review. Mirrors
 * `SUPPORTED_REVIEWER_CLIS` in
 * src/main/orchestration/cross-model-review-service.constants.ts. Kept as a
 * local copy because the renderer cannot import main-process modules; update
 * both if the supported set changes. Order here is only the default offer order
 * for the "add a reviewer" menu — the live priority order lives in the
 * `crossModelReviewProviders` setting.
 */
const REVIEWER_PROVIDERS: { id: string; label: string }[] = [
  { id: 'cursor', label: 'Cursor CLI' },
  { id: 'antigravity', label: 'Antigravity' },
  { id: 'codex', label: 'OpenAI Codex CLI' },
  { id: 'copilot', label: 'GitHub Copilot' },
];

function normalizeReviewerProviderId(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return normalized === 'gemini' ? 'antigravity' : normalized;
}

interface ReviewerProviderView {
  id: string;
  label: string;
  models: ModelDisplayInfo[];
}

@Component({
  selector: 'app-review-settings-tab',
  standalone: true,
  imports: [SettingRowComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="settings-list-card" aria-label="Cross-model review settings">
      @for (setting of genericReviewSettings(); track setting.key) {
        <app-setting-row
          class="settings-list-item"
          [setting]="setting"
          [value]="store.get(setting.key)"
          (valueChange)="onSettingChange($event)"
        />
      }
    </section>

    <section class="settings-list-card reviewer-priority" aria-label="Reviewer priority">
      <header class="reviewer-priority__header">
        <div class="reviewer-priority__heading">
          <h3 class="reviewer-priority__title">Reviewer priority</h3>
          <p class="reviewer-priority__hint">
            Reviewers run in this order. The top
            <strong>{{ reviewersPerCheck() }}</strong>
            available {{ reviewersPerCheck() === 1 ? 'reviewer runs' : 'reviewers run' }} on
            each check; the rest are fallbacks if one is unavailable. Drag the
            arrows to reorder, and pick the model each reviewer uses.
          </p>
        </div>
      </header>

      @if (orderedProviders().length === 0) {
        <p class="reviewer-priority__empty">
          No reviewers selected — cross-model review auto-picks whichever
          supported CLIs are installed. Add one below to take control.
        </p>
      } @else {
        <ol class="reviewer-list">
          @for (provider of orderedProviders(); track provider.id; let i = $index) {
            <li class="reviewer-list__item" [class.is-fallback]="!isActive(i)">
              <div class="reviewer-list__rank" aria-hidden="true">{{ i + 1 }}</div>

              <div class="reviewer-list__reorder">
                <button
                  type="button"
                  class="reorder-btn"
                  [disabled]="i === 0"
                  [attr.aria-label]="'Move ' + provider.label + ' up'"
                  (click)="move(i, -1)"
                >
                  ↑
                </button>
                <button
                  type="button"
                  class="reorder-btn"
                  [disabled]="i === orderedProviders().length - 1"
                  [attr.aria-label]="'Move ' + provider.label + ' down'"
                  (click)="move(i, 1)"
                >
                  ↓
                </button>
              </div>

              <div class="reviewer-list__info">
                <span class="reviewer-list__name">{{ provider.label }}</span>
                <span class="reviewer-list__badge" [class.is-active]="isActive(i)">
                  {{ isActive(i) ? 'Active' : 'Fallback' }}
                </span>
              </div>

              <select
                class="reviewer-list__model"
                [attr.aria-label]="provider.label + ' model'"
                [value]="modelFor(provider.id)"
                (change)="onModelChange(provider.id, $event)"
              >
                <option value="">Auto (let provider decide)</option>
                @for (model of provider.models; track model.id) {
                  <option [value]="model.id">{{ model.name }}</option>
                }
              </select>

              <button
                type="button"
                class="reviewer-list__remove"
                [attr.aria-label]="'Remove ' + provider.label"
                (click)="remove(provider.id)"
              >
                ✕
              </button>
            </li>
          }
        </ol>
      }

      @if (availableProviders().length > 0) {
        <div class="reviewer-add">
          <span class="reviewer-add__label">Add reviewer</span>
          <div class="reviewer-add__chips">
            @for (provider of availableProviders(); track provider.id) {
              <button type="button" class="reviewer-add__chip" (click)="add(provider.id)">
                + {{ provider.label }}
              </button>
            }
          </div>
        </div>
      }
    </section>
  `,
  styleUrl: './review-settings-tab.component.scss',
})
export class ReviewSettingsTabComponent {
  store = inject(SettingsStore);
  private unifiedCatalog = inject(UnifiedCatalogStore);

  private readonly providerById = computed(
    () => new Map<string, ReviewerProviderView>(
      REVIEWER_PROVIDERS.map((provider) => [
        provider.id,
        {
          ...provider,
          models: resolveReviewerModels(
            this.unifiedCatalog.displayModelsForProvider(provider.id),
            getModelsForProvider(provider.id),
          ),
        },
      ]),
    ),
  );

  constructor() {
    this.unifiedCatalog.ensureLoaded();
  }

  /** All review settings except the reviewer list, which has a bespoke control. */
  readonly genericReviewSettings = computed(() =>
    this.store.reviewSettings().filter((setting) => setting.key !== 'crossModelReviewProviders'),
  );

  /** Configured reviewers, in priority order, limited to supported CLIs. */
  readonly orderedProviders = computed<ReviewerProviderView[]>(() =>
    this.configuredProviders()
      .map((id) => this.providerById().get(id))
      .filter((provider): provider is ReviewerProviderView => provider !== undefined),
  );

  /** Supported reviewers not yet in the priority list, in default offer order. */
  readonly availableProviders = computed(() => {
    const enabled = new Set(this.configuredProviders());
    return REVIEWER_PROVIDERS.filter((provider) => !enabled.has(provider.id));
  });

  /** How many reviewers run per check — drives the Active/Fallback split. */
  readonly reviewersPerCheck = computed(() => {
    const raw = Number(this.store.get('crossModelReviewMaxReviewers'));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 1;
  });

  isActive(index: number): boolean {
    return index < this.reviewersPerCheck();
  }

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

  /** Move a reviewer up (-1) or down (+1) in the priority order. */
  move(index: number, delta: -1 | 1): void {
    const order = this.configuredProviders();
    const target = index + delta;
    if (target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    void this.store.set('crossModelReviewProviders', next);
  }

  /** Append a reviewer to the end of the priority list (lowest priority). */
  add(provider: string): void {
    const order = this.configuredProviders();
    if (order.includes(provider)) return;
    void this.store.set('crossModelReviewProviders', [...order, provider]);
  }

  /** Remove a reviewer from the priority list (back to auto for that CLI). */
  remove(provider: string): void {
    const next = this.configuredProviders().filter((id) => id !== provider);
    void this.store.set('crossModelReviewProviders', next);
  }

  /**
   * The configured reviewer order, limited to currently-supported CLIs and
   * de-duplicated. Filtering here keeps the rendered list, the reorder indices,
   * and every persisted write aligned, and quietly drops legacy/unsupported
   * entries (e.g. a stored 'claude' that the backend never honoured anyway).
   */
  private configuredProviders(): string[] {
    const value = this.store.get('crossModelReviewProviders');
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const providerById = this.providerById();
    const providers: string[] = [];
    for (const rawId of value) {
      if (typeof rawId !== 'string') continue;
      const id = normalizeReviewerProviderId(rawId);
      if (seen.has(id) || !providerById.has(id)) continue;
      seen.add(id);
      providers.push(id);
    }
    return providers;
  }
}
