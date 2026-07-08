import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { OverlayModule, ConnectedPosition } from '@angular/cdk/overlay';
import { ModelPickerController } from './model-picker.controller';
import {
  PROVIDER_MENU_COLORS,
  PROVIDER_MENU_LABELS,
  DEFAULT_CHAT_PROVIDERS,
} from './provider-menu.constants';
import { ModelPickerFocusService } from './model-picker-focus.service';
import {
  type UnifiedSelection,
  type UnifiedReasoningOption,
} from './model-selection.types';
import { ModelSelectionPanelComponent } from './model-selection-panel.component';
import { DynamicModelCatalogService } from './dynamic-model-catalog.service';
import { UnifiedCatalogStore } from './unified-catalog.store';
import {
  getDefaultReasoningEffort,
  getModelsForProvider,
  getPrimaryModelForProvider,
  type ModelDisplayInfo,
  type ReasoningEffort,
} from '../../../../shared/types/provider.types';
import type { ModelRuntimeTarget } from '../../../../shared/types/local-model-runtime.types';
import { decodeLocalModelSelector } from '../../../../shared/utils/local-model-selector';
import type { ChatRecord } from '../../../../shared/types/chat.types';
import type {
  CompactPickerMode,
  PendingSelection,
  PickerProvider,
} from './compact-model-picker.types';

const REASONING_LABELS: Record<ReasoningEffort, string> = {
  none: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'XHigh',
  max: 'Max',
  workflow: 'Workflow',
};

/**
 * Single-chip provider+model picker. Renders one trigger button that opens
 * a search-first selection panel with a favorites rail, provider tabs, model
 * rows, and inline reasoning choices for providers that support them.
 */
@Component({
  selector: 'app-compact-model-picker',
  standalone: true,
  imports: [OverlayModule, ModelSelectionPanelComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ModelPickerController],
  template: `
    <div class="compact-picker" role="group" aria-label="Model selection">
      <button
        #pickerTrigger
        type="button"
        class="compact-picker__chip"
        [attr.aria-haspopup]="'menu'"
        [attr.aria-expanded]="menuOpen()"
        [attr.aria-controls]="menuId"
        [disabled]="_disabledReason() ? true : null"
        [attr.title]="_disabledReason() ?? null"
        (click)="toggleMenu()"
      >
        <span class="compact-picker__dot" [style.background]="providerColor()"></span>
        <span class="compact-picker__label">{{ providerLabel() }}</span>
        <span class="compact-picker__sep" aria-hidden="true">·</span>
        <span class="compact-picker__label compact-picker__label--model">{{ modelLabel() }}</span>
        @if (reasoningSuffix()) {
          <span class="compact-picker__reasoning-suffix">· {{ reasoningSuffix() }}</span>
        }
        <span class="compact-picker__chevron" aria-hidden="true">▾</span>
      </button>

      @if (statusPill()) {
        <span class="compact-picker__status" role="status">{{ statusPill() }}</span>
      }
      @if (catalogFreshness()) {
        <span
          class="compact-picker__catalog"
          role="status"
          [attr.title]="'Model catalog last refreshed ' + catalogFreshness()"
        >↻ {{ catalogFreshness() }}</span>
      }
    </div>

    <ng-template
      cdkConnectedOverlay
      [cdkConnectedOverlayOpen]="menuOpen()"
      [cdkConnectedOverlayOrigin]="pickerTriggerRef"
      [cdkConnectedOverlayPositions]="overlayPositions"
      [cdkConnectedOverlayHasBackdrop]="true"
      [cdkConnectedOverlayBackdropClass]="'cdk-overlay-transparent-backdrop'"
      (backdropClick)="closeMenu()"
      (overlayKeydown)="onOverlayKeydown($event)"
    >
      <app-model-selection-panel
        [providers]="providerList()"
        [selectedProvider]="selectedPickerProvider()"
        [selectedModelId]="controller.selectedModelId() || null"
        [selectedReasoning]="controller.selectedReasoningEffort()"
        [providerLabels]="providerLabels"
        [modelsForProvider]="modelsForProviderFn"
        [reasoningOptionsForProvider]="reasoningOptionsForProviderFn"
        [disabledReasonForProvider]="providerDisabledReasonFor"
        (selection)="onUnifiedSelect($event)"
        (dismiss)="closeMenu()"
      />
    </ng-template>
  `,
  styles: [`
    :host { display: inline-block; }
    .compact-picker {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .compact-picker__chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 26px;
      padding: 0 10px;
      border: 1px solid var(--border-subtle, rgba(255,255,255,0.10));
      border-radius: 13px;
      background: var(--bg-secondary, transparent);
      color: var(--text-primary, inherit);
      font: inherit;
      font-size: 12px;
      cursor: pointer;
      max-width: 100%;
      white-space: nowrap;
    }
    .compact-picker__chip:hover:not(:disabled) {
      background: var(--bg-tertiary, rgba(127,127,127,0.12));
    }
    .compact-picker__chip:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .compact-picker__dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex: 0 0 8px;
    }
    .compact-picker__label {
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 220px;
    }
    .compact-picker__label--model {
      color: var(--text-primary, inherit);
    }
    .compact-picker__sep {
      color: var(--text-tertiary, rgba(255,255,255,0.45));
      font-size: 11px;
    }
    .compact-picker__reasoning-suffix {
      color: var(--text-secondary, rgba(255,255,255,0.65));
    }
    .compact-picker__chevron {
      font-size: 10px;
      opacity: 0.7;
    }
    .compact-picker__status {
      font-size: 11px;
      padding: 2px 8px;
      border: 1px solid var(--success-border, rgba(34,197,94,0.4));
      border-radius: 10px;
      color: var(--success-text, rgb(74,222,128));
    }
    .compact-picker__catalog {
      font-size: 10px;
      color: var(--text-tertiary, rgba(255,255,255,0.45));
      white-space: nowrap;
    }
  `],
})
export class CompactModelPickerComponent {
  protected readonly controller = inject(ModelPickerController);
  private readonly focusService = inject(ModelPickerFocusService);
  private readonly dynamicCatalog = inject(DynamicModelCatalogService);
  private readonly unifiedCatalog = inject(UnifiedCatalogStore);

  protected readonly menuId = `compact-model-picker__menu-${idCounter++}`;

  // Inputs (decorator-based; signal-input metadata is not picked up by the
  // project's vitest setup.
  private readonly _mode = signal<CompactPickerMode>('live-instance');
  private readonly _chat = signal<ChatRecord | null>(null);
  private readonly _hasMessages = signal(false);
  private readonly _selection = signal<PendingSelection | null>(null);
  private readonly _providers = signal<PickerProvider[] | null>(null);
  protected readonly _disabledReason = signal<string | null>(null);

  @Input() set mode(value: CompactPickerMode) {
    this._mode.set(value);
    this.controller.setMode(value);
  }
  @Input() set chat(value: ChatRecord | null | undefined) {
    this._chat.set(value ?? null);
    if (value) this.controller.setChat(value, this._hasMessages());
  }
  @Input() set hasMessages(value: boolean) {
    this._hasMessages.set(value);
    const c = this._chat();
    if (c) this.controller.setChat(c, value);
  }
  /**
   * Optional override of the provider list shown in the menu. Defaults to
   * `DEFAULT_CHAT_PROVIDERS` (4 providers, no cursor) so existing chat
   * surfaces don't need to opt in. The new-session/instance-draft surface
   * passes the wider list including `cursor`.
   */
  @Input() set providers(value: PickerProvider[] | null | undefined) {
    this._providers.set(value && value.length > 0 ? value : null);
  }
  @Input() set selection(value: PendingSelection | null | undefined) {
    this._selection.set(value ?? null);
    if (value) this.controller.setSelection(value);
  }
  /**
   * When set, the picker trigger is disabled and the menu cannot be opened; the
   * string is shown as a tooltip explaining why (e.g. "Model changes are only
   * available while the instance is waiting for user input"). Lets a host gate
   * the whole picker to match a backend rule rather than letting the user make a
   * change that would be silently rejected.
   */
  @Input() set disabledReason(value: string | null | undefined) {
    this._disabledReason.set(value ?? null);
  }

  @Output() selectionChange = new EventEmitter<PendingSelection>();

  @ViewChild('pickerTrigger', { static: true, read: ElementRef })
  protected readonly pickerTriggerRef!: ElementRef<HTMLElement>;

  protected readonly menuOpen = signal(false);
  protected readonly statusPill = signal<string | null>(null);
  private readonly catalogFreshnessTick = signal(0);
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private catalogFreshnessTimer: ReturnType<typeof setInterval> | null = null;
  private lastFocusRequest = 0;

  protected readonly overlayPositions: ConnectedPosition[] = [
    { originX: 'start', originY: 'top',    overlayX: 'start', overlayY: 'bottom', offsetY: -4 },
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top',    offsetY: 4 },
  ];

  protected readonly providerLabels = PROVIDER_MENU_LABELS;

  /**
   * Bound `[modelsForProvider]` callback for the selection panel. The unified
   * catalog is authoritative for every provider once loaded. Before that first
   * IPC snapshot arrives, use the curated static list only as an immediate
   * fallback; renderer-side dynamic discovery is just a producer that pushes
   * Copilot/Cursor results into the unified catalog.
   */
  protected readonly modelsForProviderFn = (provider: PickerProvider): ModelDisplayInfo[] => {
    // Prefer the unified catalog (static, models.dev, override, custom, and
    // CLI-discovered rows). Fall back to static data only until it has loaded.
    const unified = this.unifiedCatalog.displayModelsForProvider(provider);
    return unified.length > 0 ? unified : getModelsForProvider(provider);
  };

  /** Bound `[reasoningOptionsForProvider]` callback for the selection panel. */
  protected readonly reasoningOptionsForProviderFn = (
    provider: PickerProvider,
  ): UnifiedReasoningOption[] => {
    return this.controller
      .reasoningOptionsForProvider(provider)
      .map((opt) => ({ id: opt.id, label: opt.label, isDefault: opt.isDefault }));
  };

  constructor() {
    const destroyRef = inject(DestroyRef);

    // Forward pending-create commits as `selectionChange` events.
    this.controller.setSelectionChangeCallback((sel) => {
      this.selectionChange.emit(sel);
    });

    // When the menu opens, refresh the live model lists for dynamic providers
    // (Copilot, Cursor). Static providers are a no-op inside the service.
    effect(() => {
      if (!this.menuOpen()) return;
      // Pull the unified catalog once, and refresh the renderer-side live lists
      // for dynamic providers that still produce catalog updates here.
      this.unifiedCatalog.ensureLoaded();
      for (const provider of this.providerList()) {
        this.dynamicCatalog.ensureLoaded(provider);
      }
    });

    // mp keybinding — open the menu when requested.
    effect(() => {
      const n = this.focusService.request();
      if (n === this.lastFocusRequest) return;
      this.lastFocusRequest = n;
      // Skip the very first read (initial signal value of 0) so we don't
      // auto-open at mount time.
      if (n === 0) return;
      this.openModelMenu();
    });

    this.catalogFreshnessTimer = setInterval(() => {
      this.catalogFreshnessTick.update((value) => value + 1);
    }, 60_000);
    if (
      this.catalogFreshnessTimer
      && typeof this.catalogFreshnessTimer === 'object'
      && 'unref' in this.catalogFreshnessTimer
    ) {
      this.catalogFreshnessTimer.unref();
    }

    destroyRef.onDestroy(() => {
      if (this.statusTimer) {
        clearTimeout(this.statusTimer);
        this.statusTimer = null;
      }
      if (this.catalogFreshnessTimer) {
        clearInterval(this.catalogFreshnessTimer);
        this.catalogFreshnessTimer = null;
      }
    });
  }

  // --- Bar rendering ---

  /**
   * Provider type as the picker UI sees it. The controller stores
   * `InstanceProvider` (which includes `'ollama'`); the picker never
   * surfaces ollama. Chat surfaces filter further to ChatProvider; the
   * new-session/instance-draft surface accepts cursor.
   */
  protected readonly selectedPickerProvider = computed<PickerProvider>(() => {
    return this.controller.selectedProviderId();
  });

  /**
   * The list of providers rendered in the menu. Defaults to chat-4 unless
   * the host explicitly passed a wider list via `[providers]`.
   */
  protected readonly providerList = computed<PickerProvider[]>(() => {
    return this._providers() ?? DEFAULT_CHAT_PROVIDERS;
  });

  protected readonly providerLabel = computed(() => {
    const p = this.selectedPickerProvider();
    return PROVIDER_MENU_LABELS[p] ?? p;
  });

  protected readonly providerColor = computed(() => {
    const p = this.selectedPickerProvider();
    return PROVIDER_MENU_COLORS[p] ?? '#888';
  });

  protected readonly modelLabel = computed(() => {
    const id = this.controller.selectedModelId();
    if (!id) return 'Select model';
    const list = this.modelsForProviderFn(this.selectedPickerProvider());
    return list.find((m) => m.id === id)?.name ?? id;
  });

  protected readonly reasoningSuffix = computed<string | null>(() => {
    const r = this.controller.selectedReasoningEffort();
    return r ? REASONING_LABELS[r] ?? r : null;
  });

  /**
   * Live-refresh indicator: how long ago the unified model catalog last rebuilt
   * (from a models.dev sync or CLI discovery). Null until the catalog loads.
   * Recomputes whenever the catalog pushes an update (lastBuiltAt changes).
   */
  protected readonly catalogFreshness = computed<string | null>(() => {
    this.catalogFreshnessTick();
    const at = this.unifiedCatalog.lastBuiltAt();
    return at ? formatAgo(at) : null;
  });

  // --- Provider gating (lock-on-messages) ---

  protected readonly providerDisabledReasonFor = (provider: PickerProvider): string | undefined => {
    return this.controller.disabledReasonFor({ provider });
  };

  // --- Menu toggle ---

  protected toggleMenu(): void {
    if (this._disabledReason()) return;
    this.menuOpen.update((v) => !v);
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
  }

  /**
   * External entry-point used by the `mp` keybinding. Kept under the
   * legacy name for back-compat with `ModelPickerFocusService`.
   */
  openModelMenu(): void {
    if (this._disabledReason()) return;
    this.menuOpen.set(true);
  }

  // --- Commit handlers ---

  protected async onUnifiedSelect(selection: UnifiedSelection): Promise<void> {
    this.menuOpen.set(false);
    if (selection.kind === 'provider') {
      // Provider row clicks reset the model to the new provider's primary
      // default and the provider's app-level reasoning default. Without the
      // model reset, the chat would keep the OLD provider's model id, which is
      // invalid for the new provider's runtime.
      const newDefaultModel =
        this.modelsForProviderFn(selection.provider)[0]?.id
        ?? getPrimaryModelForProvider(selection.provider)
        ?? null;
      const modelRuntimeTarget = this.modelRuntimeTargetForSelection(selection.provider, newDefaultModel);
      const ok = await this.controller.commitSelection({
        provider: selection.provider,
        modelId: newDefaultModel,
        reasoning: getDefaultReasoningEffort(selection.provider),
        ...(modelRuntimeTarget ? { modelRuntimeTarget } : {}),
      });
      if (ok) this.flashStatus(`Provider: ${PROVIDER_MENU_LABELS[selection.provider]}`);
      return;
    }

    if (selection.kind === 'model') {
      const modelRuntimeTarget = this.modelRuntimeTargetForSelection(selection.provider, selection.modelId);
      const ok = await this.controller.commitSelection({
        provider: selection.provider,
        modelId: selection.modelId,
        reasoning: getDefaultReasoningEffort(selection.provider),
        ...(modelRuntimeTarget ? { modelRuntimeTarget } : {}),
      });
      if (ok) {
        const label =
          this.modelsForProviderFn(selection.provider).find((m) => m.id === selection.modelId)?.name
          ?? selection.modelId;
        const restartHint = this._chat()?.currentInstanceId ? ' — runtime restarting' : '';
        this.flashStatus(`Switched to ${label}${restartHint}`);
      }
      return;
    }

    // selection.kind === 'reasoning' — commit provider+model+reasoning.
    const modelRuntimeTarget = this.modelRuntimeTargetForSelection(selection.provider, selection.modelId);
    const ok = await this.controller.commitSelection({
      provider: selection.provider,
      modelId: selection.modelId,
      reasoning: selection.level,
      ...(modelRuntimeTarget ? { modelRuntimeTarget } : {}),
    });
    if (ok) {
      const label =
        this.modelsForProviderFn(selection.provider).find((m) => m.id === selection.modelId)?.name
        ?? selection.modelId;
      const reasoningSuffix = selection.level ? ` · ${REASONING_LABELS[selection.level]}` : '';
      const restartHint = this._chat()?.currentInstanceId ? ' — runtime restarting' : '';
      this.flashStatus(`Switched to ${label}${reasoningSuffix}${restartHint}`);
    }
  }

  protected onOverlayKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      this.closeMenu();
    }
  }

  private flashStatus(text: string): void {
    this.statusPill.set(text);
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = setTimeout(() => {
      this.statusPill.set(null);
      this.statusTimer = null;
    }, 2000);
  }

  private modelRuntimeTargetForSelection(
    provider: PickerProvider,
    modelId: string | null,
  ): ModelRuntimeTarget | null {
    if (provider !== 'local-model' || !modelId) {
      return null;
    }

    try {
      const decoded = decodeLocalModelSelector(modelId);
      const nodeName = this.localModelNodeNameForSelection(modelId, decoded.modelId);
      return {
        kind: 'local-model',
        source: decoded.source,
        endpointProvider: decoded.endpointProvider,
        endpointId: decoded.endpointId,
        modelId: decoded.modelId,
        selectorId: modelId,
        ...(decoded.nodeId ? { nodeId: decoded.nodeId } : {}),
        ...(nodeName ? { nodeName } : {}),
      };
    } catch {
      return null;
    }
  }

  private localModelNodeNameForSelection(
    selectorId: string,
    modelId: string,
  ): string | undefined {
    const displayName = this.modelsForProviderFn('local-model')
      .find((model) => model.id === selectorId)
      ?.name;
    const prefix = `${modelId} on `;
    if (!displayName?.startsWith(prefix)) {
      return undefined;
    }

    return displayName.slice(prefix.length).trim() || undefined;
  }
}

let idCounter = 0;

/** Short relative-time label for the catalog-freshness pill. */
function formatAgo(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
