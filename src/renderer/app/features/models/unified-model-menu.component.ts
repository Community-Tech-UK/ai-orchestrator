import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  computed,
  signal,
} from '@angular/core';
import { NestedMenuComponent } from '../../shared/menu/nested-menu.component';
import type {
  MenuItem,
  MenuModel,
  MenuSection,
} from '../../shared/menu/menu.types';
import type {
  ModelDisplayInfo,
  ReasoningEffort,
} from '../../../../shared/types/provider.types';
import type { PickerProvider } from './compact-model-picker.types';
import { versionDescending } from './model-menu.component';

/**
 * Reasoning option shape (matches `ModelMenuReasoningOption`). Re-declared
 * locally to avoid coupling the unified menu's public API to the existing
 * per-provider model menu.
 */
export interface UnifiedReasoningOption {
  id: 'default' | ReasoningEffort;
  label: string;
}

/**
 * Outgoing commit shape. The compact picker forwards this straight into
 * `ModelPickerController.commitSelection({ provider, modelId, reasoning })`.
 *
 *   - `kind: 'provider'` — user clicked a provider row body. The picker
 *     resets to the provider's primary default model and clears reasoning.
 *   - `kind: 'model'` — user clicked a model row body. Provider switches if
 *     needed; reasoning preserved when same-provider, cleared otherwise.
 *   - `kind: 'reasoning'` — user clicked an Intelligence leaf. All three
 *     fields are committed atomically.
 */
export type UnifiedSelection =
  | { kind: 'provider'; provider: PickerProvider }
  | { kind: 'model'; provider: PickerProvider; modelId: string }
  | {
      kind: 'reasoning';
      provider: PickerProvider;
      modelId: string;
      level: ReasoningEffort | null;
    };

/**
 * The shape attached to each menu item's `payload`. Mirrors `UnifiedSelection`
 * so the same payload surfaces verbatim on `select`.
 */
type UnifiedMenuPayload = UnifiedSelection;

/**
 * Single popover content for the consolidated provider+model+reasoning
 * picker. Top-level rows are providers; each provider's row has a submenu
 * containing its model list (Latest / Other versions); each model row has
 * an Intelligence submenu when the provider exposes reasoning options.
 *
 * The menu is stateless about commit — clicks emit `selection` and the
 * consumer (CompactModelPickerComponent) routes the event through
 * `ModelPickerController.commitSelection`.
 */
@Component({
  selector: 'app-unified-model-menu',
  standalone: true,
  imports: [NestedMenuComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-nested-menu
      [model]="menuModel()"
      [autoFocus]="true"
      (itemSelect)="onSelect($event)"
      (dismiss)="dismiss.emit()"
    />
  `,
})
export class UnifiedModelMenuComponent {
  // @Input setters write into private signals so `menuModel` (a computed)
  // reacts. Plain @Input fields would only be picked up on first read and
  // the computed would cache the stale value — see model-menu.component.ts
  // for the full rationale, including why we don't use signal-input().
  private readonly _providers = signal<PickerProvider[]>([]);
  private readonly _selectedProvider = signal<PickerProvider | null>(null);
  private readonly _selectedModelId = signal<string | null>(null);
  private readonly _selectedReasoning = signal<ReasoningEffort | null>(null);
  private readonly _providerLabels = signal<Record<string, string>>({});
  private readonly _modelsForProvider = signal<
    (provider: PickerProvider) => ModelDisplayInfo[]
  >(() => []);
  private readonly _reasoningOptionsForProvider = signal<
    (provider: PickerProvider) => UnifiedReasoningOption[]
  >(() => []);
  private readonly _disabledReasonForProvider = signal<
    (provider: PickerProvider) => string | undefined
  >(() => undefined);

  @Input({ required: true }) set providers(value: PickerProvider[]) {
    this._providers.set(value ?? []);
  }
  @Input({ required: true }) set selectedProvider(value: PickerProvider | null) {
    this._selectedProvider.set(value);
  }
  @Input({ required: true }) set selectedModelId(value: string | null) {
    this._selectedModelId.set(value);
  }
  @Input({ required: true }) set selectedReasoning(value: ReasoningEffort | null) {
    this._selectedReasoning.set(value);
  }
  @Input({ required: true }) set providerLabels(value: Record<string, string>) {
    this._providerLabels.set(value ?? {});
  }
  @Input({ required: true }) set modelsForProvider(
    fn: (provider: PickerProvider) => ModelDisplayInfo[],
  ) {
    this._modelsForProvider.set(fn ?? (() => []));
  }
  @Input({ required: true }) set reasoningOptionsForProvider(
    fn: (provider: PickerProvider) => UnifiedReasoningOption[],
  ) {
    this._reasoningOptionsForProvider.set(fn ?? (() => []));
  }
  @Input() set disabledReasonForProvider(
    fn: ((provider: PickerProvider) => string | undefined) | undefined | null,
  ) {
    this._disabledReasonForProvider.set(fn ?? (() => undefined));
  }

  @Output() selection = new EventEmitter<UnifiedSelection>();
  @Output() dismiss = new EventEmitter<void>();

  readonly menuModel = computed<MenuModel<UnifiedMenuPayload>>(() => {
    const providers = this._providers();
    const labels = this._providerLabels();
    const selectedProvider = this._selectedProvider();
    const disabledReasonFor = this._disabledReasonForProvider();
    const modelsForProvider = this._modelsForProvider();
    const reasoningOptionsForProvider = this._reasoningOptionsForProvider();

    if (providers.length === 0) {
      return {
        sections: [],
        emptyStateLabel: 'No providers available',
      };
    }

    const items: MenuItem<UnifiedMenuPayload>[] = providers.map((provider) => {
      const disabledReason = disabledReasonFor(provider);
      return {
        id: `provider:${provider}`,
        label: labels[provider] ?? provider,
        selected: provider === selectedProvider,
        disabledReason,
        // Disabled providers still expose a submenu placeholder so screen
        // readers announce the structure, but `MenuItemComponent` skips the
        // hover-open / chevron-click for disabled rows.
        submenu: this.buildProviderSubtree(
          provider,
          modelsForProvider(provider),
          reasoningOptionsForProvider(provider),
        ),
        payload: { kind: 'provider', provider } satisfies UnifiedMenuPayload,
      };
    });

    return {
      sections: [
        {
          id: 'providers',
          items,
        } satisfies MenuSection<UnifiedMenuPayload>,
      ],
    };
  });

  onSelect(item: MenuItem<UnifiedMenuPayload>): void {
    const payload = item.payload;
    if (!payload) return;
    if (payload.kind === 'provider') {
      // Treat row-body click on a provider as an explicit "switch provider"
      // commit. The compact picker resets to the provider's primary default
      // model and clears reasoning — matches the legacy behavior of the
      // standalone provider chip's row click.
      this.selection.emit(payload);
      return;
    }
    this.selection.emit(payload);
  }

  /**
   * Build the model subtree for a single provider. Mirrors the layout of
   * `ModelMenuComponent` (Latest section, then "Other versions ▸") so the
   * unified menu feels identical to the prior split UI once the user
   * descends past the provider row.
   */
  private buildProviderSubtree(
    provider: PickerProvider,
    models: ModelDisplayInfo[],
    reasoningOptions: UnifiedReasoningOption[],
  ): MenuModel<UnifiedMenuPayload> {
    if (models.length === 0) {
      return {
        sections: [],
        emptyStateLabel: 'No models available',
      };
    }

    const pinned = models.filter((m) => m.pinned === true);
    const unpinned = models.filter((m) => m.pinned !== true);
    const sections: MenuSection<UnifiedMenuPayload>[] = [];

    if (pinned.length > 0) {
      sections.push({
        id: `latest:${provider}`,
        items: pinned.map((m) => this.buildModelItem(provider, m, reasoningOptions)),
      });
    }

    sections.push({
      id: `other-versions-wrap:${provider}`,
      items: [
        {
          id: `__other_versions__:${provider}`,
          label: 'Other versions',
          submenu: this.buildOtherVersionsSubtree(
            provider,
            unpinned,
            reasoningOptions,
          ),
          // No payload — the row is a parent container; only its leaves commit.
        },
      ],
    });

    return { sections };
  }

  private buildOtherVersionsSubtree(
    provider: PickerProvider,
    models: ModelDisplayInfo[],
    reasoningOptions: UnifiedReasoningOption[],
  ): MenuModel<UnifiedMenuPayload> {
    if (models.length === 0) {
      return {
        sections: [],
        emptyStateLabel: 'No additional versions available',
      };
    }
    const families = groupByFamily(models);
    return {
      sections: families.map((group) => ({
        id: `family:${provider}:${group.family}`,
        label: group.family,
        items: group.models
          .slice()
          .sort(versionDescending)
          .map((m) => this.buildModelItem(provider, m, reasoningOptions)),
      })),
    };
  }

  private buildModelItem(
    provider: PickerProvider,
    model: ModelDisplayInfo,
    reasoningOptions: UnifiedReasoningOption[],
  ): MenuItem<UnifiedMenuPayload> {
    const sameModel =
      provider === this._selectedProvider() &&
      model.id === this._selectedModelId();
    return {
      id: `model:${provider}:${model.id}`,
      label: model.name,
      selected: sameModel,
      submenu:
        reasoningOptions.length > 0
          ? this.buildIntelligenceSubmenu(provider, model.id, reasoningOptions)
          : undefined,
      payload: {
        kind: 'model',
        provider,
        modelId: model.id,
      } satisfies UnifiedMenuPayload,
    };
  }

  private buildIntelligenceSubmenu(
    provider: PickerProvider,
    modelId: string,
    reasoningOptions: UnifiedReasoningOption[],
  ): MenuModel<UnifiedMenuPayload> {
    const items: MenuItem<UnifiedMenuPayload>[] = reasoningOptions.map((opt) => ({
      id: `reasoning:${provider}:${modelId}:${opt.id}`,
      label: opt.label,
      selected: this.isReasoningSelected(opt, provider, modelId),
      payload: {
        kind: 'reasoning',
        provider,
        modelId,
        level: opt.id === 'default' ? null : opt.id,
      } satisfies UnifiedMenuPayload,
    }));
    return {
      sections: [
        {
          id: `intelligence:${provider}:${modelId}`,
          label: 'Intelligence',
          items,
        },
      ],
    };
  }

  private isReasoningSelected(
    opt: UnifiedReasoningOption,
    provider: PickerProvider,
    modelId: string,
  ): boolean {
    if (provider !== this._selectedProvider()) return false;
    if (modelId !== this._selectedModelId()) return false;
    if (opt.id === 'default') return this._selectedReasoning() === null;
    return opt.id === this._selectedReasoning();
  }
}

/**
 * Group models by `family`, preserving first-seen order. Matches the helper
 * inside `model-menu.component.ts` — duplicated here rather than exported to
 * keep the unified menu's API surface independent of the legacy menu.
 */
function groupByFamily(
  models: ModelDisplayInfo[],
): { family: string; models: ModelDisplayInfo[] }[] {
  const groups = new Map<string, ModelDisplayInfo[]>();
  const order: string[] = [];
  for (const model of models) {
    const key = model.family ?? 'Other';
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(model);
  }
  return order.map((family) => ({ family, models: groups.get(family)! }));
}
