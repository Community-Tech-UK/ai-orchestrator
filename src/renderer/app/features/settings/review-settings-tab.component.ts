/**
 * Review Settings Tab Component - Cross-model review settings
 */

import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingRowComponent } from './setting-row.component';
import {
  CrossModelReviewIpcService,
  type ReviewerNotice,
} from '../../core/services/ipc/cross-model-review-ipc.service';
import type { AppSettings } from '../../../../shared/types/settings.types';
import { getModelsForProvider, type ModelDisplayInfo } from '../../../../shared/types/provider.types';
import { UnifiedCatalogStore } from '../models/unified-catalog.store';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';
import { resolveReviewerModels } from './reviewer-model-options';
import {
  REMOTE_REVIEWER_PROVIDER_DEFINITIONS,
  normalizeRemoteReviewerProvider,
  type RemoteReviewerProvider,
} from '../../../../shared/types/reviewer-provider.types';

interface ReviewerProviderView {
  id: RemoteReviewerProvider;
  label: string;
  models: ModelDisplayInfo[];
}

interface LocalReviewerModelView extends ModelDisplayInfo {
  reviewerEligible: boolean;
  reviewerIneligibleReason?: string;
  canQualify: boolean;
}

interface LocalQualificationState {
  status: 'verifying' | 'verified' | 'failed';
  reason?: string;
}

const LOCAL_REVIEW_SETTING_KEYS = new Set<keyof AppSettings>([
  'crossModelReviewLocalEnabled',
  'crossModelReviewLocalSelectorId',
  'crossModelReviewLocalTimeout',
  'crossModelReviewLocalMaxToolRounds',
]);

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
          No reviewers selected. Cross-model review auto-picks whichever
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
                @if (reviewerNotice(provider.id); as notice) {
                  <span
                    class="reviewer-list__health"
                    [class.is-ratelimited]="notice.kind === 'rate-limited'"
                    [title]="noticeTooltip(notice)"
                  >
                    {{ notice.kind === 'rate-limited' ? 'Rate-limited' : 'Unavailable' }}
                  </span>
                }
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

    <section class="settings-list-card reviewer-priority" aria-label="Local reviewer">
      <header class="reviewer-priority__header">
        <h3 class="reviewer-priority__title">Local reviewer</h3>
        <p class="reviewer-priority__hint">
          Choose a local model to run an additional check. The saved choice
          stays tied to that device, endpoint, and model.
        </p>
      </header>

      <div class="reviewer-add">
        <label class="reviewer-add__label" for="crossModelReviewLocalSelectorId">
          Local reviewer model
        </label>
        <select
          id="crossModelReviewLocalSelectorId"
          class="reviewer-list__model"
          aria-label="Local reviewer model"
          [value]="localModelSelectorId()"
          (change)="onLocalModelChange($event)"
        >
          <option value="">Choose a local model</option>
          @for (model of localReviewerModels(); track model.id) {
            <option
              [value]="model.id"
              [disabled]="!model.reviewerEligible"
              [selected]="model.id === localModelSelectorId()"
            >
              {{ model.name }}{{ model.reviewerIneligibleReason ? ' — ' + model.reviewerIneligibleReason : '' }}
            </option>
          }
        </select>
      </div>

      @for (model of localReviewerModels(); track model.id) {
        @if (model.canQualify) {
          <div class="reviewer-add local-qualification-row">
            <span>{{ model.name }}</span>
            <button
              type="button"
              class="reviewer-add__chip"
              [attr.data-qualify-selector]="model.id"
              [disabled]="qualificationState(model.id)?.status === 'verifying'"
              (click)="qualifyLocalReviewer(model)"
            >
              {{ qualificationState(model.id)?.status === 'verifying' ? 'Verifying…' : 'Verify tool use' }}
            </button>
            @if (qualificationState(model.id); as state) {
              <span role="status" aria-live="polite">
                @if (state.status === 'verified') {
                  Tool use verified. You can now select this model.
                } @else if (state.status === 'failed') {
                  Verification failed: {{ state.reason }}
                }
              </span>
            }
          </div>
        }
      }

      @if (!hasEligibleLocalReviewer()) {
        <p class="reviewer-priority__empty">
          No eligible local models are currently available.
        </p>
      }

      <div class="reviewer-add">
        <label class="reviewer-add__label" for="crossModelReviewLocalEnabled">
          <input
            id="crossModelReviewLocalEnabled"
            type="checkbox"
            [checked]="store.get('crossModelReviewLocalEnabled')"
            (change)="onLocalEnabledChange($event)"
          />
          Enable local reviewer
        </label>
      </div>

      <div class="reviewer-add">
        <label class="reviewer-add__label" for="crossModelReviewLocalTimeout">
          Local reviewer timeout (seconds)
        </label>
        <input
          id="crossModelReviewLocalTimeout"
          type="number"
          min="10"
          max="600"
          [value]="store.get('crossModelReviewLocalTimeout')"
          (change)="onLocalNumberChange('crossModelReviewLocalTimeout', $event)"
        />
      </div>

      <div class="reviewer-add">
        <label class="reviewer-add__label" for="crossModelReviewLocalMaxToolRounds">
          Local reviewer max tool rounds
        </label>
        <input
          id="crossModelReviewLocalMaxToolRounds"
          type="number"
          min="1"
          max="32"
          [value]="store.get('crossModelReviewLocalMaxToolRounds')"
          (change)="onLocalNumberChange('crossModelReviewLocalMaxToolRounds', $event)"
        />
      </div>
    </section>
  `,
  styleUrl: './review-settings-tab.component.scss',
})
export class ReviewSettingsTabComponent {
  store = inject(SettingsStore);
  private unifiedCatalog = inject(UnifiedCatalogStore);
  private reviewHealth = inject(CrossModelReviewIpcService);
  private providerIpc = inject(ProviderIpcService);
  private destroyRef = inject(DestroyRef);
  private destroyed = false;
  private readonly qualificationStates = signal(new Map<string, LocalQualificationState>());

  /** Live health notice for a reviewer row (undefined when healthy). */
  reviewerNotice(id: RemoteReviewerProvider): ReviewerNotice | undefined {
    return this.reviewHealth.getReviewerNotice(id);
  }

  noticeTooltip(notice: ReviewerNotice): string {
    if (notice.kind === 'rate-limited') {
      return 'Hit a rate or usage limit on its last run; skipped until it recovers.';
    }
    return notice.reason
      ? `Not available: ${notice.reason}. Skipped and its slot handed to the next reviewer.`
      : 'Not detected; skipped and its slot handed to the next reviewer.';
  }

  private readonly providerById = computed(
    () => new Map<string, ReviewerProviderView>(
      REMOTE_REVIEWER_PROVIDER_DEFINITIONS.map((provider) => [
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
    this.destroyRef.onDestroy(() => { this.destroyed = true; });
  }

  /** All review settings except the reviewer list, which has a bespoke control. */
  readonly genericReviewSettings = computed(() =>
    this.store.reviewSettings().filter((setting) =>
      setting.key !== 'crossModelReviewProviders' && !LOCAL_REVIEW_SETTING_KEYS.has(setting.key)),
  );

  readonly localReviewerModels = computed<LocalReviewerModelView[]>(() =>
    this.unifiedCatalog.displayModelsForProvider('local-model')
      .filter((model) => !model.localModel?.modelId.toLowerCase().includes(':cloud'))
      .map((model) => {
        const reason = localReviewerIneligibility(model);
        return {
          ...model,
          reviewerEligible: reason === undefined,
          canQualify: canQualifyLocalReviewer(model),
          ...(reason ? { reviewerIneligibleReason: reason } : {}),
        };
      }),
  );

  readonly hasEligibleLocalReviewer = computed(() =>
    this.localReviewerModels().some((model) => model.reviewerEligible),
  );

  readonly localModelSelectorId = computed(() =>
    this.store.get('crossModelReviewLocalSelectorId') ?? '',
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
    return REMOTE_REVIEWER_PROVIDER_DEFINITIONS.filter((provider) => !enabled.has(provider.id));
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
  add(provider: RemoteReviewerProvider): void {
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
   * entries left behind by older or hand-edited settings.
   */
  private configuredProviders(): RemoteReviewerProvider[] {
    const value = this.store.get('crossModelReviewProviders');
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const providerById = this.providerById();
    const providers: RemoteReviewerProvider[] = [];
    for (const rawId of value) {
      if (typeof rawId !== 'string') continue;
      const id = normalizeRemoteReviewerProvider(rawId);
      const provider = providerById.get(id);
      if (seen.has(id) || !provider) continue;
      seen.add(provider.id);
      providers.push(provider.id);
    }
    return providers;
  }

  onLocalModelChange(event: Event): void {
    const selectorId = (event.target as HTMLSelectElement).value;
    if (selectorId && !this.localReviewerModels().some(
      (model) => model.id === selectorId && model.reviewerEligible,
    )) return;
    void this.store.set('crossModelReviewLocalSelectorId', selectorId);
  }

  qualificationState(selectorId: string): LocalQualificationState | undefined {
    return this.qualificationStates().get(selectorId);
  }

  async qualifyLocalReviewer(model: LocalReviewerModelView): Promise<void> {
    if (!model.canQualify || this.qualificationState(model.id)?.status === 'verifying') return;
    this.setQualificationState(model.id, { status: 'verifying' });
    try {
      const response = await this.providerIpc.qualifyLocalReviewer(model.id);
      if (this.destroyed) return;
      if (response.success && response.data?.status === 'verified') {
        await this.unifiedCatalog.refresh();
        if (!this.destroyed) this.setQualificationState(model.id, { status: 'verified' });
        return;
      }
      this.setQualificationState(model.id, {
        status: 'failed',
        reason: response.data?.reason ?? response.error?.message ?? 'Capability probe failed.',
      });
    } catch (error) {
      if (!this.destroyed) {
        this.setQualificationState(model.id, {
          status: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private setQualificationState(selectorId: string, state: LocalQualificationState): void {
    const next = new Map(this.qualificationStates());
    next.set(selectorId, state);
    this.qualificationStates.set(next);
  }

  onLocalEnabledChange(event: Event): void {
    const enabled = (event.target as HTMLInputElement).checked;
    void this.store.set('crossModelReviewLocalEnabled', enabled);
  }

  onLocalNumberChange(
    key: 'crossModelReviewLocalTimeout' | 'crossModelReviewLocalMaxToolRounds',
    event: Event,
  ): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isInteger(value)) {
      void this.store.set(key, value);
    }
  }
}

function localReviewerIneligibility(model: ModelDisplayInfo): string | undefined {
  const local = model.localModel;
  if (!local) return 'Local inventory details unavailable';
  if (local.source !== 'this-device') return 'This-device models only';
  if (!local.healthy) return 'Endpoint unavailable';
  if (local.capabilities.toolUse !== 'verified') return 'Tool use not verified';
  return undefined;
}

function canQualifyLocalReviewer(model: ModelDisplayInfo): boolean {
  const local = model.localModel;
  return local?.source === 'this-device' &&
    local.healthy &&
    local.capabilities.toolUse !== 'verified' &&
    !local.modelId.toLowerCase().includes(':cloud');
}
