import {
  ChangeDetectionStrategy,
  Component,
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
} from './provider-menu.component';
import { ModelPickerFocusService } from './model-picker-focus.service';
import {
  UnifiedModelMenuComponent,
  type UnifiedSelection,
  type UnifiedReasoningOption,
} from './unified-model-menu.component';
import {
  getModelsForProvider,
  getPrimaryModelForProvider,
  type ModelDisplayInfo,
  type ReasoningEffort,
} from '../../../../shared/types/provider.types';
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
  xhigh: 'Max',
};

/**
 * Single-chip provider+model picker. Renders one trigger button that opens
 * a unified nested menu: top-level rows are providers (LLMs); each provider
 * expands to its models; models with reasoning options expand again to an
 * Intelligence submenu.
 */
@Component({
  selector: 'app-compact-model-picker',
  standalone: true,
  imports: [OverlayModule, UnifiedModelMenuComponent],
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
      <app-unified-model-menu
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
    .compact-picker__chip:hover {
      background: var(--bg-tertiary, rgba(127,127,127,0.12));
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
  `],
})
export class CompactModelPickerComponent {
  protected readonly controller = inject(ModelPickerController);
  private readonly focusService = inject(ModelPickerFocusService);

  protected readonly menuId = `compact-model-picker__menu-${idCounter++}`;

  // Inputs (decorator-based; signal-input metadata is not picked up by the
  // project's vitest setup — see model-menu.component.ts for context).
  private readonly _mode = signal<CompactPickerMode>('live-instance');
  private readonly _chat = signal<ChatRecord | null>(null);
  private readonly _hasMessages = signal(false);
  private readonly _selection = signal<PendingSelection | null>(null);
  private readonly _providers = signal<PickerProvider[] | null>(null);

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

  @Output() selectionChange = new EventEmitter<PendingSelection>();

  @ViewChild('pickerTrigger', { static: true, read: ElementRef })
  protected readonly pickerTriggerRef!: ElementRef<HTMLElement>;

  protected readonly menuOpen = signal(false);
  protected readonly statusPill = signal<string | null>(null);
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFocusRequest = 0;

  protected readonly overlayPositions: ConnectedPosition[] = [
    { originX: 'start', originY: 'top',    overlayX: 'start', overlayY: 'bottom', offsetY: -4 },
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top',    offsetY: 4 },
  ];

  protected readonly providerLabels = PROVIDER_MENU_LABELS;

  /**
   * Bound `[modelsForProvider]` callback for the unified menu. Always returns
   * the static `getModelsForProvider` lookup — provider-specific dynamic
   * model discovery already mutates `PROVIDER_MODEL_LIST` in place, so the
   * lookup stays current.
   */
  protected readonly modelsForProviderFn = (provider: PickerProvider): ModelDisplayInfo[] =>
    getModelsForProvider(provider);

  /** Bound `[reasoningOptionsForProvider]` callback for the unified menu. */
  protected readonly reasoningOptionsForProviderFn = (
    provider: PickerProvider,
  ): UnifiedReasoningOption[] => {
    return this.controller
      .reasoningOptionsForProvider(provider)
      .map((opt) => ({ id: opt.id, label: opt.label }));
  };

  constructor() {
    // Forward pending-create commits as `selectionChange` events.
    this.controller.setSelectionChangeCallback((sel) => {
      this.selectionChange.emit(sel);
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
  }

  // --- Bar rendering ---

  /**
   * Provider type as the picker UI sees it. The controller stores
   * `InstanceProvider` (which includes `'ollama'`); the picker never
   * surfaces ollama. Chat surfaces filter further to ChatProvider; the
   * new-session/instance-draft surface accepts cursor.
   */
  protected readonly selectedPickerProvider = computed<PickerProvider>(() => {
    const p = this.controller.selectedProviderId();
    return (p === 'ollama' ? 'claude' : p) as PickerProvider;
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

  // --- Provider gating (lock-on-messages) ---

  protected readonly providerDisabledReasonFor = (provider: PickerProvider): string | undefined => {
    return this.controller.disabledReasonFor({ provider });
  };

  // --- Menu toggle ---

  protected toggleMenu(): void {
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
    this.menuOpen.set(true);
  }

  // --- Commit handlers ---

  protected async onUnifiedSelect(selection: UnifiedSelection): Promise<void> {
    this.menuOpen.set(false);
    if (selection.kind === 'provider') {
      // Provider switch resets the model to the new provider's primary
      // default and clears reasoning (matches the legacy modal's
      // `selectProvider` behavior). Without the reset, the chat would keep
      // the OLD provider's model id, which is invalid for the new
      // provider's runtime.
      const newDefaultModel = getPrimaryModelForProvider(selection.provider) ?? null;
      const ok = await this.controller.commitSelection({
        provider: selection.provider,
        modelId: newDefaultModel,
        reasoning: null,
      });
      if (ok) this.flashStatus(`Provider: ${PROVIDER_MENU_LABELS[selection.provider]}`);
      return;
    }

    if (selection.kind === 'model') {
      const switchingProvider = selection.provider !== this.controller.selectedProviderId();
      // Switching provider via a model click resets reasoning; same-provider
      // model switches preserve the current reasoning level.
      const ok = await this.controller.commitSelection({
        provider: selection.provider,
        modelId: selection.modelId,
        ...(switchingProvider ? { reasoning: null } : {}),
      });
      if (ok) {
        const label =
          this.modelsForProviderFn(selection.provider).find((m) => m.id === selection.modelId)?.name
          ?? selection.modelId;
        const reasoning = switchingProvider ? null : this.controller.selectedReasoningEffort();
        const reasoningSuffix = reasoning ? ` · ${REASONING_LABELS[reasoning]}` : '';
        const restartHint = this._chat()?.currentInstanceId ? ' — runtime restarting' : '';
        this.flashStatus(`Switched to ${label}${reasoningSuffix}${restartHint}`);
      }
      return;
    }

    // selection.kind === 'reasoning' — commit provider+model+reasoning.
    const ok = await this.controller.commitSelection({
      provider: selection.provider,
      modelId: selection.modelId,
      reasoning: selection.level,
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
}

let idCounter = 0;
