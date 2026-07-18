import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  signal,
  output,
} from '@angular/core';
import type {
  ModelDisplayInfo,
  ReasoningEffort,
} from '../../../../shared/types/provider.types';
import type { PickerProvider } from './compact-model-picker.types';
import type {
  UnifiedReasoningOption,
  UnifiedSelection,
} from './model-selection.types';
import {
  PROVIDER_MENU_COLORS,
  PROVIDER_MENU_LABELS,
} from './provider-menu.constants';
import {
  orderFavoriteRowsByUsage,
  orderProviderRowsByUsage,
} from './model-usage-memory';
import { ModelUsageMemoryService } from './model-usage-memory.service';
import { DEFAULT_FAVORITE_MODEL_KEYS } from './default-favorites';

type ActiveModelTab = 'favorites' | PickerProvider;
type ProviderLabelMap = Partial<Record<PickerProvider, string>>;

interface ModelPickerRow {
  key: string;
  provider: PickerProvider;
  providerLabel: string;
  providerColor: string;
  model: ModelDisplayInfo;
  reasoningOptions: UnifiedReasoningOption[];
  reasoningValue: string;
  favorite: boolean;
  selected: boolean;
  disabledReason?: string;
  shortcut?: string;
  searchText: string;
}

const FAVORITES_STORAGE_KEY = 'compact-model-picker:favorites:v1';

/**
 * Search-first model picker panel. The left rail chooses Favorites or a
 * provider, while the main surface lists directly selectable model rows.
 * Selection stays stateless: consumers receive a `UnifiedSelection` and route
 * it through their existing commit path.
 */
@Component({
  selector: 'app-model-selection-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="model-picker-panel"
      role="dialog"
      aria-label="Choose model"
      tabindex="-1"
      (keydown)="onPanelKeydown($event)"
    >
      <nav class="model-picker-rail" aria-label="Model sources">
        <button
          type="button"
          class="model-picker-rail__button model-picker-rail__button--favorites"
          [class.active]="activeTab() === 'favorites'"
          data-tab="favorites"
          aria-label="Favorites"
          title="Favorites"
          (click)="selectTab('favorites')"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m12 2.6 2.92 5.92 6.54.95-4.73 4.61 1.12 6.51L12 17.52l-5.85 3.07 1.12-6.51-4.73-4.61 6.54-.95L12 2.6Z" />
          </svg>
        </button>

        <div class="model-picker-rail__divider" role="separator"></div>

        @for (provider of providerList(); track provider) {
          <button
            type="button"
            class="model-picker-rail__button"
            [class.active]="activeTab() === provider"
            [attr.data-provider]="provider"
            [attr.aria-label]="providerLabelMap()[provider] ?? provider"
            [title]="providerLabelMap()[provider] ?? provider"
            (click)="selectTab(provider)"
          >
            <span
              class="model-picker-provider-mark"
              [style.color]="providerColor(provider)"
              aria-hidden="true"
            >
              <svg viewBox="0 0 24 24">
                <path [attr.d]="providerIconPath(provider)"></path>
              </svg>
            </span>
          </button>
        }
      </nav>

      <section class="model-picker-main">
        <label class="model-picker-search">
          <svg class="model-picker-search__icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7"></circle>
            <path d="m16.5 16.5 4 4"></path>
          </svg>
          <input
            #searchInput
            class="model-picker-search__input"
            type="search"
            placeholder="Search models..."
            [value]="searchTerm()"
            (input)="onSearchInput($event)"
          >
        </label>

        <div class="model-picker-list" role="list" aria-label="Models">
          @for (row of visibleRows(); track row.key) {
            <div
              class="model-picker-row"
              role="listitem"
              [class.selected]="row.selected"
              [class.disabled]="row.disabledReason"
              [attr.aria-disabled]="row.disabledReason ? 'true' : null"
              [attr.title]="row.disabledReason ?? row.model.id"
            >
              <button
                type="button"
                class="model-picker-row__favorite"
                [class.active]="row.favorite"
                [attr.aria-pressed]="row.favorite ? 'true' : 'false'"
                [attr.aria-label]="row.favorite ? 'Remove from favorites' : 'Add to favorites'"
                [title]="row.favorite ? 'Remove from favorites' : 'Add to favorites'"
                (click)="toggleFavorite(row, $event)"
                (keydown)="onFavoriteKeydown(row, $event)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m12 2.6 2.92 5.92 6.54.95-4.73 4.61 1.12 6.51L12 17.52l-5.85 3.07 1.12-6.51-4.73-4.61 6.54-.95L12 2.6Z" />
                </svg>
              </button>

              <button
                type="button"
                class="model-picker-row__select"
                [disabled]="row.disabledReason ? true : null"
                [attr.aria-current]="row.selected ? 'true' : null"
                [attr.title]="row.disabledReason ?? row.model.id"
                (click)="selectRow(row)"
              >
                <span class="model-picker-row__body">
                  <span class="model-picker-row__name">{{ row.model.name }}</span>
                  <span class="model-picker-row__meta">
                    <span
                      class="model-picker-provider-mark model-picker-provider-mark--small"
                      [style.color]="row.providerColor"
                      aria-hidden="true"
                    >
                      <svg viewBox="0 0 24 24">
                        <path [attr.d]="providerIconPath(row.provider)"></path>
                      </svg>
                    </span>
                    <span class="model-picker-row__provider">{{ row.providerLabel }}</span>
                    @if (row.model.localModel) {
                      <span class="model-picker-row__badge" [class.model-picker-row__badge--warn]="!row.model.localModel.healthy">
                        {{ row.model.localModel.healthy ? 'Healthy' : 'Unavailable' }}
                      </span>
                      @if (row.model.localModel.loaded) {
                        <span class="model-picker-row__badge model-picker-row__badge--loaded" [attr.title]="loadedContextTitle(row)">Loaded</span>
                      }
                    }
                  </span>
                  @if (row.model.localModel) {
                    <span class="model-picker-row__chips" aria-label="Local model capabilities">
                      @if (row.model.localModel.capabilities.multiTurn) { <span class="model-picker-row__chip">Chat</span> }
                      @if (row.model.localModel.capabilities.toolUse !== 'none') { <span class="model-picker-row__chip">Tools</span> }
                      @else { <span class="model-picker-row__chip model-picker-row__chip--muted">No tools</span> }
                    </span>
                  }
                </span>
              </button>

              <div class="model-picker-row__actions">
                @if (row.reasoningOptions.length > 0) {
                  <label class="model-picker-row__reasoning-label" [attr.for]="reasoningSelectId(row)">
                    Reasoning for {{ row.model.name }}
                  </label>
                  <select
                    class="model-picker-row__reasoning"
                    [id]="reasoningSelectId(row)"
                    [value]="row.reasoningValue"
                    [disabled]="row.disabledReason ? true : null"
                    [attr.aria-label]="'Reasoning for ' + row.model.name"
                    (click)="$event.stopPropagation()"
                    (change)="selectReasoning(row, $event)"
                  >
                    @for (option of row.reasoningOptions; track option.id) {
                      <option
                        [value]="reasoningOptionValue(option)"
                        [selected]="row.reasoningValue === reasoningOptionValue(option)"
                      >
                        {{ option.label }}{{ option.isDefault ? ' (default)' : '' }}
                      </option>
                    }
                  </select>
                }

                @if (row.shortcut) {
                  <span class="model-picker-row__shortcut" aria-hidden="true">{{ row.shortcut }}</span>
                }
              </div>
            </div>
          } @empty {
            <div class="model-picker-empty" role="status">{{ emptyStateLabel() }}</div>
          }
        </div>
      </section>
    </div>
  `,
  styles: [`
    :host {
      display: block;
    }

    .model-picker-panel {
      display: grid;
      grid-template-columns: 52px minmax(0, 1fr);
      width: min(680px, calc(100vw - 32px));
      height: min(520px, calc(100vh - 96px));
      overflow: hidden;
      background: color-mix(in srgb, var(--bg-secondary, #151515) 94%, black);
      border: 1px solid var(--border-color, rgba(255,255,255,0.12));
      border-radius: 8px;
      box-shadow: 0 22px 60px rgba(0,0,0,0.42);
      color: var(--text-primary, #f4f4f5);
      outline: none;
    }

    .model-picker-rail {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      padding: 8px 6px;
      background: color-mix(in srgb, var(--bg-primary, #101010) 88%, black);
      border-right: 1px solid var(--border-subtle, rgba(255,255,255,0.08));
    }

    .model-picker-rail__button {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      border: 0;
      border-radius: 8px;
      background: transparent;
      color: var(--text-secondary, #c4c4c9);
      cursor: pointer;
    }

    .model-picker-rail__button:hover,
    .model-picker-rail__button.active {
      background: var(--bg-hover, rgba(255,255,255,0.08));
      color: var(--text-primary, #fff);
    }

    .model-picker-rail__button.active::after {
      content: '';
      position: absolute;
      right: -7px;
      top: 8px;
      bottom: 8px;
      width: 2px;
      border-radius: 2px;
      background: var(--primary-color, #d97706);
    }

    .model-picker-rail__button svg {
      width: 21px;
      height: 21px;
      fill: currentColor;
    }

    .model-picker-rail__button--favorites {
      color: #f4c430;
    }

    .model-picker-rail__divider {
      width: 32px;
      height: 1px;
      margin: 1px 0 4px;
      background: var(--border-subtle, rgba(255,255,255,0.08));
    }

    .model-picker-provider-mark {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
    }

    .model-picker-provider-mark svg {
      width: 100%;
      height: 100%;
      fill: currentColor;
    }

    .model-picker-provider-mark--small {
      width: 16px;
      height: 16px;
      font-size: 10px;
      opacity: 0.92;
    }

    .model-picker-main {
      min-width: 0;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      padding: 10px;
      gap: 10px;
    }

    .model-picker-search {
      position: relative;
      display: block;
    }

    .model-picker-search__icon {
      position: absolute;
      left: 12px;
      top: 50%;
      width: 17px;
      height: 17px;
      transform: translateY(-50%);
      fill: none;
      stroke: var(--text-muted, #8f8f96);
      stroke-width: 2;
      stroke-linecap: round;
      pointer-events: none;
    }

    .model-picker-search__input {
      width: 100%;
      height: 38px;
      padding: 0 12px 0 38px;
      border: 1px solid var(--border-color, rgba(255,255,255,0.12));
      border-radius: 8px;
      background: var(--bg-tertiary, rgba(255,255,255,0.06));
      color: var(--text-primary, #f4f4f5);
      font: inherit;
      font-size: 14px;
      outline: none;
    }

    .model-picker-search__input:focus {
      border-color: var(--primary-color, #d97706);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary-color, #d97706) 28%, transparent);
    }

    .model-picker-list {
      min-height: 0;
      overflow-y: auto;
      /* Reserve the scrollbar gutter so the list width doesn't jump when a long
         provider list (e.g. Cursor's ~129 models) makes the bar appear. */
      scrollbar-gutter: stable;
      /* Firefox / standards. */
      scrollbar-width: thin;
      scrollbar-color: var(--border-light, rgba(255, 255, 255, 0.28)) transparent;
      padding-right: 2px;
    }

    /* Always-visible styled scrollbar so it's obvious the list scrolls even on
       macOS (where native overlay scrollbars stay hidden until you drag). */
    .model-picker-list::-webkit-scrollbar {
      width: 10px;
    }

    .model-picker-list::-webkit-scrollbar-track {
      background: transparent;
      margin: 2px 0;
    }

    .model-picker-list::-webkit-scrollbar-thumb {
      background: var(--border-light, rgba(255, 255, 255, 0.28));
      border-radius: 6px;
      /* Inset the thumb so it reads as a pill rather than a full-width bar. */
      border: 2px solid transparent;
      background-clip: padding-box;
    }

    .model-picker-list::-webkit-scrollbar-thumb:hover {
      background: var(--text-muted, rgba(255, 255, 255, 0.45));
      background-clip: padding-box;
    }

    .model-picker-row {
      display: grid;
      grid-template-columns: 38px minmax(0, 1fr) auto;
      align-items: center;
      min-height: 58px;
      margin-bottom: 6px;
      border: 1px solid transparent;
      border-radius: 8px;
      background: color-mix(in srgb, var(--bg-elevated, #242424) 62%, transparent);
      color: var(--text-primary, #f4f4f5);
      cursor: pointer;
      outline: none;
    }

    .model-picker-row:hover:not(.disabled),
    .model-picker-row:focus-visible:not(.disabled) {
      background: var(--bg-hover, rgba(255,255,255,0.08));
      border-color: var(--border-light, rgba(255,255,255,0.16));
    }

    .model-picker-row.selected {
      border-color: color-mix(in srgb, var(--primary-color, #d97706) 54%, transparent);
      background: color-mix(in srgb, var(--primary-color, #d97706) 13%, var(--bg-elevated, #242424));
    }

    .model-picker-row.disabled {
      opacity: 0.48;
      cursor: not-allowed;
    }

    .model-picker-row__favorite {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      margin-left: 6px;
      border: 0;
      border-radius: 8px;
      background: transparent;
      /* Grey outline when not favourited; gold fill (via .active) when it is. */
      color: var(--text-muted, #8f8f96);
      cursor: pointer;
    }

    .model-picker-row__favorite:hover,
    .model-picker-row__favorite.active {
      color: #f4c430;
      background: color-mix(in srgb, #f4c430 14%, transparent);
    }

    .model-picker-row__favorite svg {
      width: 18px;
      height: 18px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.75;
      stroke-linejoin: round;
    }

    .model-picker-row__favorite.active svg {
      fill: currentColor;
      stroke: none;
    }

    .model-picker-row__select {
      min-width: 0;
      height: 100%;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
      outline: none;
    }

    .model-picker-row__select:disabled {
      cursor: not-allowed;
    }

    .model-picker-row__body {
      min-width: 0;
      display: grid;
      gap: 4px;
      padding: 9px 8px 9px 0;
    }

    .model-picker-row__name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 14px;
      font-weight: 700;
      line-height: 1.3;
      color: var(--text-primary, #f4f4f5);
    }

    .model-picker-row__meta {
      display: inline-flex;
      min-width: 0;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      color: var(--text-muted, #9ca3af);
      font-size: 12px;
    }

    .model-picker-row__provider {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .model-picker-row__badge,
    .model-picker-row__chip { display: inline-flex; align-items: center; height: 18px; padding: 0 6px; border: 1px solid color-mix(in srgb, var(--success-border, rgba(34,197,94,0.42)) 75%, transparent); border-radius: 999px; color: var(--success-text, #86efac); background: color-mix(in srgb, var(--success-bg, rgba(34,197,94,0.14)) 72%, transparent); font-size: 10px; font-weight: 700; line-height: 1; white-space: nowrap; }

    .model-picker-row__badge--warn { border-color: color-mix(in srgb, var(--warning-border, rgba(251,191,36,0.46)) 75%, transparent); color: var(--warning-text, #fbbf24); background: color-mix(in srgb, var(--warning-bg, rgba(251,191,36,0.14)) 72%, transparent); }

    .model-picker-row__badge--loaded { border-color: color-mix(in srgb, var(--primary-color, #14b8a6) 50%, transparent); color: color-mix(in srgb, var(--primary-color, #14b8a6) 70%, white); background: color-mix(in srgb, var(--primary-color, #14b8a6) 14%, transparent); }

    .model-picker-row__chips { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }

    .model-picker-row__chip { border-color: color-mix(in srgb, var(--border-light, rgba(255,255,255,0.22)) 80%, transparent); color: var(--text-secondary, #c4c4c9); background: color-mix(in srgb, var(--bg-primary, #111) 42%, transparent); }

    .model-picker-row__chip--muted { color: var(--text-tertiary, rgba(255,255,255,0.45)); background: transparent; }

    .model-picker-row__actions {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      min-width: 0;
      padding-right: 10px;
    }

    .model-picker-row__reasoning-label {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
      border: 0;
    }

    /*
     * Reasoning picker. Re-declares every box property explicitly so the
     * control no longer inherits the global 'input, textarea, select' rule
     * from _base.scss — that rule's 8px/12px padding collapsed the fixed
     * height and clipped the value text. Background is set with longhands
     * (never the 'background' shorthand) so the caret image survives.
     */
    .model-picker-row__reasoning {
      appearance: none;
      flex: 0 0 auto;
      width: 160px;
      height: 26px;
      padding: 0 24px 0 10px;
      border: 1px solid var(--border-color, rgba(255,255,255,0.16));
      border-radius: 6px;
      background-color: var(--bg-elevated, #242424);
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%2391988d' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
      background-size: 10px;
      color: var(--text-secondary, #c4c4c9);
      font: inherit;
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
      outline: none;
      cursor: pointer;
    }

    .model-picker-row__reasoning:hover:not(:disabled) {
      border-color: var(--border-light, rgba(255,255,255,0.28));
      background-color: var(--bg-hover, #1d2925);
      color: var(--text-primary, #f4f4f5);
    }

    .model-picker-row__reasoning:focus-visible {
      border-color: var(--primary-color, #d97706);
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--primary-color, #d97706) 24%, transparent);
    }

    .model-picker-row__reasoning:disabled {
      cursor: not-allowed;
    }

    .model-picker-row__shortcut {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      height: 26px;
      min-width: 28px;
      padding: 0 8px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--bg-primary, #111) 60%, transparent);
      color: var(--text-muted, #9ca3af);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.01em;
    }

    .model-picker-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 160px;
      color: var(--text-muted, #9ca3af);
      font-size: 13px;
      text-align: center;
    }

    @media (max-width: 560px) {
      .model-picker-panel {
        grid-template-columns: 46px minmax(0, 1fr);
        width: calc(100vw - 24px);
        height: min(520px, calc(100vh - 72px));
      }

      .model-picker-row {
        grid-template-columns: 34px minmax(0, 1fr) auto;
      }

      .model-picker-row__shortcut {
        display: none;
      }

      .model-picker-row__reasoning {
        width: 132px;
      }
    }
  `],
})
export class ModelSelectionPanelComponent implements AfterViewInit {
  private readonly storedFavorites = loadFavoriteKeys();
  private readonly modelUsageMemory = inject(ModelUsageMemoryService);

  protected readonly activeTab = signal<ActiveModelTab>('favorites');
  protected readonly searchTerm = signal('');
  private readonly favoriteKeys = signal<string[]>(this.storedFavorites.keys);
  private readonly customizedFavorites = signal(this.storedFavorites.customized);

  readonly providers = input.required<PickerProvider[]>();
  readonly selectedProvider = input.required<PickerProvider | null>();
  readonly selectedModelId = input.required<string | null>();
  readonly selectedReasoning = input.required<ReasoningEffort | null>();
  readonly providerLabels = input.required<ProviderLabelMap | null | undefined>();
  readonly modelsForProvider = input.required<
    (provider: PickerProvider) => ModelDisplayInfo[]
  >();
  readonly reasoningOptionsForProvider = input.required<
    (provider: PickerProvider) => UnifiedReasoningOption[]
  >();
  readonly disabledReasonForProvider = input<
    ((provider: PickerProvider) => string | undefined) | undefined | null
  >();

  private readonly _providers = computed(() => this.providers() ?? []);
  private readonly _selectedProvider = computed(() => this.selectedProvider());
  private readonly _selectedModelId = computed(() => this.selectedModelId());
  private readonly _selectedReasoning = computed(() => this.selectedReasoning());
  private readonly _providerLabels = computed(() =>
    this.providerLabels() ?? PROVIDER_MENU_LABELS,
  );
  private readonly _modelsForProvider = computed(() =>
    this.modelsForProvider() ?? (() => []),
  );
  private readonly _reasoningOptionsForProvider = computed(() =>
    this.reasoningOptionsForProvider() ?? (() => []),
  );
  private readonly _disabledReasonForProvider = computed(() =>
    this.disabledReasonForProvider() ?? (() => undefined),
  );

  readonly selection = output<UnifiedSelection>();
  readonly dismiss = output<void>();

  @ViewChild('searchInput', { static: true })
  private readonly searchInput!: ElementRef<HTMLInputElement>;

  protected readonly providerList = this._providers;
  protected readonly providerLabelMap = this._providerLabels;

  /**
   * Default (non-customized) favorites: the curated `DEFAULT_FAVORITE_MODEL_KEYS`,
   * filtered to available models. When none are available, fall back to one
   * usage-ranked row per provider so the tab is never empty. Availability is
   * derived from `_providers`/`_modelsForProvider` (not `allRows()`) to avoid a
   * computed cycle via effectiveFavoriteKeys.
   */
  private readonly defaultFavoriteKeys = computed(() => {
    const modelsForProvider = this._modelsForProvider();
    const providers = this._providers();

    const availableKeys = new Set<string>();
    for (const provider of providers) {
      for (const model of modelsForProvider(provider)) {
        availableKeys.add(modelKey(provider, model.id));
      }
    }

    const curated = DEFAULT_FAVORITE_MODEL_KEYS.filter((key) => availableKeys.has(key));
    if (curated.length > 0) return curated;

    const usageByKey = this.modelUsageMemory.usageByKey();
    return providers
      .map((provider) => {
        const keys = modelsForProvider(provider).map((model) => ({
          key: modelKey(provider, model.id),
        }));
        return orderProviderRowsByUsage(keys, usageByKey)[0]?.key ?? null;
      })
      .filter((key): key is string => key !== null);
  });

  private readonly effectiveFavoriteKeys = computed(() =>
    this.customizedFavorites() ? this.favoriteKeys() : this.defaultFavoriteKeys(),
  );

  private readonly favoriteKeySet = computed(() => new Set(this.effectiveFavoriteKeys()));

  private readonly allRows = computed<ModelPickerRow[]>(() => {
    const labels = this._providerLabels();
    const modelsForProvider = this._modelsForProvider();
    const reasoningOptionsForProvider = this._reasoningOptionsForProvider();
    const disabledReasonForProvider = this._disabledReasonForProvider();
    const favoriteKeys = this.favoriteKeySet();
    const selectedProvider = this._selectedProvider();
    const selectedModelId = this._selectedModelId();
    const selectedReasoning = this._selectedReasoning();

    return this._providers().flatMap((provider) => {
      const providerLabel = labels[provider] ?? provider;
      const providerColor = this.providerColor(provider);
      const providerDisabledReason = disabledReasonForProvider(provider);
      const reasoningOptions = reasoningOptionsForProvider(provider);

      return modelsForProvider(provider).map((model) => {
        const key = modelKey(provider, model.id);
        const selected = provider === selectedProvider && model.id === selectedModelId;
        const disabledReason = providerDisabledReason ?? localModelDisabledReason(model);
        return {
          key,
          provider,
          providerLabel,
          providerColor,
          model,
          reasoningOptions,
          reasoningValue: this.reasoningValueFor(selected, selectedReasoning, reasoningOptions),
          favorite: favoriteKeys.has(key),
          selected,
          disabledReason,
          searchText: [
            model.name,
            model.id,
            model.family ?? '',
            model.localModel ? (model.localModel.healthy ? 'healthy' : 'unavailable') : '',
            model.localModel?.loaded ? 'loaded' : '',
            model.localModel?.capabilities.multiTurn ? 'chat' : '',
            model.localModel
              ? (model.localModel.capabilities.toolUse !== 'none' ? 'tools' : 'no tools')
              : '',
            providerLabel,
            provider,
          ].join(' ').toLowerCase(),
        } satisfies ModelPickerRow;
      });
    });
  });

  protected readonly visibleRows = computed<ModelPickerRow[]>(() => {
    const active = this.activeTab();
    const term = this.searchTerm().trim().toLowerCase();
    const usageByKey = this.modelUsageMemory.usageByKey();
    const allRows = this.allRows();

    const scopedRows = active === 'favorites'
      ? orderFavoriteRowsByUsage(allRows, this.effectiveFavoriteKeys(), usageByKey)
      : orderProviderRowsByUsage(
        allRows.filter((row) => row.provider === active),
        usageByKey,
      );

    const filteredRows = term
      ? scopedRows.filter((row) => row.searchText.includes(term))
      : scopedRows;

    return filteredRows.map((row, index) => ({
      ...row,
      shortcut: index < 9 ? shortcutLabel(index + 1) : undefined,
    }));
  });

  protected readonly emptyStateLabel = computed(() => {
    if (this.searchTerm().trim()) return 'No models match your search';
    const active = this.activeTab();
    if (active === 'favorites') return 'No favorite models yet';
    if (active === 'local-model') {
      return 'No local models found. Add a Remote Node or configure Auxiliary Models in Settings.';
    }
    const label = this._providerLabels()[active] ?? active;
    return `No models available for ${label}`;
  });

  constructor() {
    effect(() => {
      const providers = this._providers();
      const active = this.activeTab();
      if (active !== 'favorites' && !providers.includes(active)) {
        this.activeTab.set('favorites');
      }
    });
  }

  ngAfterViewInit(): void {
    queueMicrotask(() => this.searchInput.nativeElement.focus());
  }

  protected selectTab(tab: ActiveModelTab): void {
    this.activeTab.set(tab);
  }

  protected onSearchInput(event: Event): void {
    this.searchTerm.set((event.target as HTMLInputElement).value);
  }

  protected selectRow(row: ModelPickerRow): void {
    if (row.disabledReason) return;
    this.selection.emit({
      kind: 'model',
      provider: row.provider,
      modelId: row.model.id,
    });
  }

  protected selectReasoning(row: ModelPickerRow, event: Event): void {
    event.stopPropagation();
    if (row.disabledReason) return;

    const value = (event.target as HTMLSelectElement).value;
    const option = row.reasoningOptions.find((candidate) =>
      this.reasoningOptionValue(candidate) === value,
    );
    if (!option) return;

    this.selection.emit({
      kind: 'reasoning',
      provider: row.provider,
      modelId: row.model.id,
      level: option.id === 'default' ? null : option.id,
    });
  }

  protected toggleFavorite(row: ModelPickerRow, event: Event): void {
    event.stopPropagation();

    const next = new Set(this.effectiveFavoriteKeys());
    if (next.has(row.key)) {
      next.delete(row.key);
    } else {
      next.add(row.key);
    }

    const ordered = this.orderedKeys(next);
    this.customizedFavorites.set(true);
    this.favoriteKeys.set(ordered);
    persistFavoriteKeys(ordered);
  }

  protected onFavoriteKeydown(row: ModelPickerRow, event: KeyboardEvent): void {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    this.toggleFavorite(row, event);
  }

  protected loadedContextTitle(row: ModelPickerRow): string | null {
    const contextLength = row.model.localModel?.loadedContextLength;
    return contextLength ? `Loaded context: ${contextLength.toLocaleString()} tokens` : null;
  }

  protected onPanelKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.dismiss.emit();
      return;
    }

    if (!event.metaKey && !event.ctrlKey) return;
    if (!/^[1-9]$/.test(event.key)) return;

    const index = Number(event.key) - 1;
    const row = this.visibleRows()[index];
    if (!row) return;

    event.preventDefault();
    this.selectRow(row);
  }

  protected providerColor(provider: PickerProvider): string {
    return PROVIDER_MENU_COLORS[provider] ?? '#888';
  }

  protected reasoningSelectId(row: ModelPickerRow): string {
    return `model-reasoning-${row.provider}-${sanitizeIdPart(row.model.id)}`;
  }

  protected reasoningOptionValue(option: UnifiedReasoningOption): string {
    return option.id === 'default' ? 'default' : option.id;
  }

  protected providerIconPath(provider: PickerProvider): string {
    switch (provider) {
      case 'claude':
        return 'M12 1.75c.48 0 .87.39.87.87v4.04a.87.87 0 1 1-1.74 0V2.62c0-.48.39-.87.87-.87ZM17.88 3.33c.41.24.55.77.32 1.19l-2.02 3.5a.87.87 0 1 1-1.5-.87l2.02-3.5a.87.87 0 0 1 1.18-.32ZM21.82 7.47c.24.41.1.95-.32 1.18L18 10.67a.87.87 0 0 1-.87-1.5l3.5-2.02a.87.87 0 0 1 1.19.32ZM22.25 12c0 .48-.39.87-.87.87h-4.04a.87.87 0 1 1 0-1.74h4.04c.48 0 .87.39.87.87ZM20.67 17.88a.87.87 0 0 1-1.18.32l-3.5-2.02a.87.87 0 1 1 .87-1.5l3.5 2.02c.41.24.55.77.31 1.18ZM16.53 21.82a.87.87 0 0 1-1.18-.32l-2.02-3.5a.87.87 0 1 1 1.5-.87l2.02 3.5c.24.41.1.95-.32 1.19ZM12 22.25a.87.87 0 0 1-.87-.87v-4.04a.87.87 0 1 1 1.74 0v4.04c0 .48-.39.87-.87.87ZM7.47 20.67a.87.87 0 0 1-.32-1.18l2.02-3.5a.87.87 0 1 1 1.5.87l-2.02 3.5a.87.87 0 0 1-1.18.31ZM3.33 16.53a.87.87 0 0 1 .32-1.18l3.5-2.02a.87.87 0 1 1 .87 1.5l-3.5 2.02a.87.87 0 0 1-1.19-.32ZM1.75 12c0-.48.39-.87.87-.87h4.04a.87.87 0 1 1 0 1.74H2.62a.87.87 0 0 1-.87-.87ZM3.33 7.47a.87.87 0 0 1 1.18-.32l3.5 2.02a.87.87 0 1 1-.87 1.5l-3.5-2.02a.87.87 0 0 1-.31-1.18ZM7.47 3.33c.41-.24.95-.1 1.18.32l2.02 3.5a.87.87 0 1 1-1.5.87l-2.02-3.5a.87.87 0 0 1 .32-1.19ZM12 10.35a1.65 1.65 0 1 1 0 3.3 1.65 1.65 0 0 1 0-3.3Z';
      case 'codex':
        return 'M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.985 5.985 0 0 0 .517 4.91 6.046 6.046 0 0 0 6.51 2.9A6.065 6.065 0 0 0 19.02 19.81a5.985 5.985 0 0 0 3.998-2.9 6.046 6.046 0 0 0-.736-7.09Z';
      case 'gemini':
      case 'antigravity':
        return 'M12 2.5 14.45 9.55 21.5 12 14.45 14.45 12 21.5 9.55 14.45 2.5 12 9.55 9.55 12 2.5Z';
      case 'copilot':
        return 'M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12Z';
      case 'cursor':
        return 'M12 2 20 7v10l-8 5-8-5V7l8-5Zm0 2.35L6 8.1v7.8l6 3.75 6-3.75V8.1l-6-3.75Z';
      case 'grok':
        return 'M12 2c5.523 0 10 4.477 10 10s-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2Zm0 2.5A7.5 7.5 0 1 0 19.5 12 7.5 7.5 0 0 0 12 4.5Zm-3.25 4.25h2.1l1.15 3.4 1.15-3.4h2.1l-2.2 5.5h-2.1l-2.2-5.5Z';
      case 'local-model':
        return 'M4 6.5 12 2l8 4.5v9L12 20l-8-4.5v-9Zm2 1.18v6.64l6 3.38 6-3.38V7.68L12 4.3 6 7.68Zm6 1.1 3.5-1.97 1.5.84-5 2.82-5-2.82 1.5-.84L12 8.78Zm-5 3.03 5 2.82 5-2.82v1.72l-5 2.82-5-2.82v-1.72Z';
    }
  }

  private orderedKeys(keys: Set<string>): string[] {
    const rowsInDisplayOrder = this.allRows().map((row) => row.key);
    const ordered = rowsInDisplayOrder.filter((key) => keys.has(key));
    for (const key of keys) {
      if (!ordered.includes(key)) ordered.push(key);
    }
    return ordered;
  }

  private reasoningValueFor(
    selected: boolean,
    selectedReasoning: ReasoningEffort | null,
    reasoningOptions: UnifiedReasoningOption[],
  ): string {
    if (reasoningOptions.length === 0) return 'default';
    const fallback = defaultReasoningOptionId(reasoningOptions);
    if (selected) return selectedReasoning ?? fallback;
    return fallback;
  }
}

function modelKey(provider: PickerProvider, modelId: string): string {
  return `${provider}:${modelId}`;
}

function localModelDisabledReason(model: ModelDisplayInfo): string | undefined {
  return model.localModel && !model.localModel.healthy
    ? 'Local model endpoint is unavailable'
    : undefined;
}

/**
 * The select value to show when a row has no explicit effort. Prefers the
 * option flagged `isDefault` (Claude's High), falls back to a provider-decide
 * `default` row when present, else the first option.
 */
function defaultReasoningOptionId(options: UnifiedReasoningOption[]): string {
  const flagged = options.find((option) => option.isDefault);
  if (flagged) return flagged.id;
  if (options.some((option) => option.id === 'default')) return 'default';
  return options[0]?.id ?? 'default';
}

function loadFavoriteKeys(): { customized: boolean; keys: string[] } {
  if (typeof window === 'undefined') {
    return { customized: false, keys: [] };
  }

  try {
    const raw = window.localStorage.getItem(FAVORITES_STORAGE_KEY);
    if (raw === null) return { customized: false, keys: [] };
    const parsed = JSON.parse(raw);
    return {
      customized: true,
      keys: Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => typeof entry === 'string')
        : [],
    };
  } catch {
    return { customized: false, keys: [] };
  }
}

function persistFavoriteKeys(keys: string[]): void {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Ignore storage failures; the in-memory selection remains usable.
  }
}

function shortcutLabel(index: number): string {
  return shortcutModifierLabel() === '⌘' ? `⌘${index}` : `Ctrl ${index}`;
}

function shortcutModifierLabel(): '⌘' | 'Ctrl' {
  if (typeof window === 'undefined') return 'Ctrl';
  const platform = window.navigator.platform.toLowerCase();
  return /mac|iphone|ipad|ipod/.test(platform) ? '⌘' : 'Ctrl';
}

function sanitizeIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-');
}
