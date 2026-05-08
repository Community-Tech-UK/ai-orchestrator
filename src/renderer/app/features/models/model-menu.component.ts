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
import type { MenuItem, MenuModel, MenuSection } from '../../shared/menu/menu.types';
import type { ModelDisplayInfo, ReasoningEffort } from '../../../../shared/types/provider.types';
import type { ChatProvider } from '../../../../shared/types/chat.types';

/**
 * The shape attached to each `MenuItem.payload`. Lets us tell apart a row
 * commit ("switch model, keep reasoning") from a reasoning-submenu commit
 * ("switch model and reasoning together") with a single emit channel.
 */
type ModelMenuPayload =
  | { kind: 'model'; modelId: string }
  | { kind: 'reasoning'; modelId: string; level: ReasoningEffort | null };

export interface ModelMenuReasoningOption {
  id: 'default' | ReasoningEffort;
  label: string;
}

export interface ModelMenuSelection {
  modelId: string;
  /** undefined ⇒ keep current reasoning; null ⇒ default; effort ⇒ explicit. */
  reasoning?: ReasoningEffort | null;
}

/**
 * Popover content for the compact picker's model trigger.
 *
 *   - Top "Latest" section (no header): models with `pinned === true`.
 *   - `Other versions ▸` row whose submenu lists every non-pinned model
 *     for the provider, grouped by `family`, sorted version-descending.
 *   - For providers that expose reasoning levels (Claude, Codex), each
 *     model row sprouts an `Intelligence ▸` submenu listing
 *     `Default` + the provider's levels. Clicking a leaf commits both
 *     the model and the chosen reasoning.
 */
@Component({
  selector: 'app-model-menu',
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
export class ModelMenuComponent {
  // @Input setters that write into private signals so the `menuModel`
  // computed reacts. Signal inputs (`input()`) would be cleaner, but the
  // project's Vitest setup does not include an Angular compiler plugin —
  // signal-input metadata isn't recognized at JIT-compile time, so JIT-rendered
  // template bindings fail with NG0303 "isn't a known property". @Input
  // decorators emit metadata via TypeScript's decorator emit and work
  // unconditionally.
  private readonly _provider = signal<ChatProvider>('claude');
  private readonly _models = signal<ModelDisplayInfo[]>([]);
  private readonly _selectedModelId = signal<string | null>(null);
  private readonly _selectedReasoning = signal<ReasoningEffort | null>(null);
  private readonly _reasoningOptions = signal<ModelMenuReasoningOption[]>([]);

  @Input() set provider(value: ChatProvider) { this._provider.set(value); }
  @Input() set models(value: ModelDisplayInfo[]) { this._models.set(value ?? []); }
  @Input() set selectedModelId(value: string | null) { this._selectedModelId.set(value); }
  @Input() set selectedReasoning(value: ReasoningEffort | null) { this._selectedReasoning.set(value); }
  @Input() set reasoningOptions(value: ModelMenuReasoningOption[]) { this._reasoningOptions.set(value ?? []); }

  @Output() modelSelect = new EventEmitter<ModelMenuSelection>();
  @Output() dismiss = new EventEmitter<void>();

  readonly menuModel = computed<MenuModel<ModelMenuPayload>>(() => {
    const allModels = this._models();
    const pinned = allModels.filter((m) => m.pinned === true);
    const unpinned = allModels.filter((m) => m.pinned !== true);

    const sections: MenuSection<ModelMenuPayload>[] = [];

    if (pinned.length > 0) {
      sections.push({
        id: 'latest',
        items: pinned.map((m) => this.buildModelItem(m)),
      });
    }

    sections.push({
      id: 'other-versions-wrapper',
      items: [{
        id: '__other_versions__',
        label: 'Other versions',
        submenu: this.buildOtherVersionsModel(unpinned),
        // No payload — opening the submenu is the only action; no leaf commit.
      }],
    });

    return { sections };
  });

  onSelect(item: MenuItem<ModelMenuPayload>): void {
    const payload = item.payload;
    if (!payload) return;
    if (payload.kind === 'model') {
      this.modelSelect.emit({ modelId: payload.modelId, reasoning: this._selectedReasoning() });
    } else {
      this.modelSelect.emit({ modelId: payload.modelId, reasoning: payload.level });
    }
  }

  private buildModelItem(model: ModelDisplayInfo): MenuItem<ModelMenuPayload> {
    return {
      id: `model:${model.id}`,
      label: model.name,
      selected: model.id === this._selectedModelId(),
      submenu: this._reasoningOptions().length > 0
        ? this.buildIntelligenceSubmenu(model.id)
        : undefined,
      payload: { kind: 'model', modelId: model.id },
    };
  }

  private buildOtherVersionsModel(models: ModelDisplayInfo[]): MenuModel<ModelMenuPayload> {
    if (models.length === 0) {
      return { sections: [], emptyStateLabel: 'No additional versions available' };
    }
    const families = groupByFamily(models);
    return {
      sections: families.map((group) => ({
        id: `family:${group.family}`,
        label: group.family,
        items: group.models
          .slice()
          .sort(versionDescending)
          .map((m) => this.buildModelItem(m)),
      })),
    };
  }

  private buildIntelligenceSubmenu(modelId: string): MenuModel<ModelMenuPayload> {
    const items: MenuItem<ModelMenuPayload>[] = this._reasoningOptions().map((opt) => ({
      id: `reasoning:${modelId}:${opt.id}`,
      label: opt.label,
      selected: this.isReasoningOptionSelected(opt, modelId),
      payload: {
        kind: 'reasoning',
        modelId,
        level: opt.id === 'default' ? null : opt.id,
      },
    }));
    return {
      sections: [{ id: 'intelligence', label: 'Intelligence', items }],
    };
  }

  private isReasoningOptionSelected(opt: ModelMenuReasoningOption, modelId: string): boolean {
    if (modelId !== this._selectedModelId()) return false;
    if (opt.id === 'default') return this._selectedReasoning() === null;
    return opt.id === this._selectedReasoning();
  }
}

/**
 * Group models by `family`, preserving first-seen order. Untagged entries
 * (no `family` set — typical for dynamically-discovered Copilot models)
 * collect under a synthetic 'Other' bucket so they still surface.
 */
function groupByFamily(models: ModelDisplayInfo[]): { family: string; models: ModelDisplayInfo[] }[] {
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

/**
 * Version-aware comparator. Newer versions sort first.
 *
 * Parses the first numeric tuple from `name` (then falls back to `id`),
 * left-pads each component to four digits, and compares as a string. So
 * "Opus 4.7" > "Opus 4.6" > "Opus 4.5" > "Opus 4". Entries that don't
 * yield a numeric tuple fall through to alphabetical (descending).
 */
export function versionDescending(a: ModelDisplayInfo, b: ModelDisplayInfo): number {
  const aKey = parseVersionKey(a);
  const bKey = parseVersionKey(b);
  if (aKey && bKey) {
    return aKey < bKey ? 1 : aKey > bKey ? -1 : 0;
  }
  return b.name.localeCompare(a.name);
}

function parseVersionKey(model: ModelDisplayInfo): string | null {
  const source = `${model.name} ${model.id}`;
  const match = source.match(/(\d+)(?:\.(\d+))*/);
  if (!match) return null;
  // Re-extract every numeric component to support arbitrary-length tuples.
  const numeric = match[0].split('.').map((part) => part.padStart(4, '0'));
  return numeric.join('.');
}
