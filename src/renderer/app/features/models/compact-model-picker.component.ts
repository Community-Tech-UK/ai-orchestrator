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
  ProviderMenuComponent,
  PROVIDER_MENU_COLORS,
  PROVIDER_MENU_LABELS,
  DEFAULT_CHAT_PROVIDERS,
} from './provider-menu.component';
import { ModelMenuComponent, type ModelMenuSelection } from './model-menu.component';
import { ModelPickerFocusService } from './model-picker-focus.service';
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

/** Two-control bar replacing the modal + chat-detail row + new-chat-form rows. */
@Component({
  selector: 'app-compact-model-picker',
  standalone: true,
  imports: [OverlayModule, ProviderMenuComponent, ModelMenuComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [ModelPickerController],
  template: `
    <div class="compact-picker" role="group" aria-label="Model selection">
      <button
        #providerChip
        type="button"
        class="compact-picker__chip compact-picker__chip--provider"
        [class.is-disabled]="!!providerChipDisabled()"
        [attr.aria-haspopup]="'menu'"
        [attr.aria-expanded]="providerMenuOpen()"
        [attr.aria-controls]="providerMenuId"
        [attr.title]="providerChipDisabled() ?? null"
        [disabled]="!!providerChipDisabled()"
        (click)="toggleProviderMenu()"
      >
        <span class="compact-picker__dot" [style.background]="providerColor()"></span>
        <span class="compact-picker__label">{{ providerLabel() }}</span>
        <span class="compact-picker__chevron" aria-hidden="true">▾</span>
      </button>

      <button
        #modelTrigger
        type="button"
        class="compact-picker__chip compact-picker__chip--model"
        [class.is-disabled]="!!modelTriggerDisabled()"
        [attr.aria-haspopup]="'menu'"
        [attr.aria-expanded]="modelMenuOpen()"
        [attr.aria-controls]="modelMenuId"
        [attr.title]="modelTriggerDisabled() ?? null"
        [disabled]="!!modelTriggerDisabled()"
        (click)="toggleModelMenu()"
      >
        <span class="compact-picker__label">{{ modelLabel() }}</span>
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
      [cdkConnectedOverlayOpen]="providerMenuOpen()"
      [cdkConnectedOverlayOrigin]="providerChipRef"
      [cdkConnectedOverlayPositions]="overlayPositions"
      [cdkConnectedOverlayHasBackdrop]="true"
      [cdkConnectedOverlayBackdropClass]="'cdk-overlay-transparent-backdrop'"
      (backdropClick)="closeProviderMenu()"
      (overlayKeydown)="onOverlayKeydown($event, 'provider')"
    >
      <app-provider-menu
        [id]="providerMenuId"
        [selectedProvider]="selectedPickerProvider()"
        [providers]="providerList()"
        [disabledReasonFor]="providerDisabledReasonFor"
        (providerSelect)="onProviderSelect($event)"
        (dismiss)="closeProviderMenu()"
      />
    </ng-template>

    <ng-template
      cdkConnectedOverlay
      [cdkConnectedOverlayOpen]="modelMenuOpen()"
      [cdkConnectedOverlayOrigin]="modelTriggerRef"
      [cdkConnectedOverlayPositions]="overlayPositions"
      [cdkConnectedOverlayHasBackdrop]="true"
      [cdkConnectedOverlayBackdropClass]="'cdk-overlay-transparent-backdrop'"
      (backdropClick)="closeModelMenu()"
      (overlayKeydown)="onOverlayKeydown($event, 'model')"
    >
      <app-model-menu
        [id]="modelMenuId"
        [provider]="selectedPickerProvider()"
        [models]="modelsForProvider()"
        [selectedModelId]="controller.selectedModelId() || null"
        [selectedReasoning]="controller.selectedReasoningEffort()"
        [reasoningOptions]="reasoningOptionsForMenu()"
        (modelSelect)="onModelSelect($event)"
        (dismiss)="closeModelMenu()"
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
    .compact-picker__chip:hover:not(.is-disabled) {
      background: var(--bg-tertiary, rgba(127,127,127,0.12));
    }
    .compact-picker__chip.is-disabled {
      opacity: 0.45;
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

  protected readonly providerMenuId = `compact-model-picker__provider-menu-${idCounter++}`;
  protected readonly modelMenuId = `compact-model-picker__model-menu-${idCounter++}`;

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
   * Optional override of the provider list shown in the chip's menu. Defaults
   * to `DEFAULT_CHAT_PROVIDERS` (4 providers, no cursor) so existing chat
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

  @ViewChild('providerChip', { static: true, read: ElementRef })
  protected readonly providerChipRef!: ElementRef<HTMLElement>;
  @ViewChild('modelTrigger', { static: true, read: ElementRef })
  protected readonly modelTriggerRef!: ElementRef<HTMLElement>;

  protected readonly providerMenuOpen = signal(false);
  protected readonly modelMenuOpen = signal(false);
  protected readonly statusPill = signal<string | null>(null);
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private lastFocusRequest = 0;

  protected readonly overlayPositions: ConnectedPosition[] = [
    { originX: 'start', originY: 'top',    overlayX: 'start', overlayY: 'bottom', offsetY: -4 },
    { originX: 'start', originY: 'bottom', overlayX: 'start', overlayY: 'top',    offsetY: 4 },
  ];

  constructor() {
    // Forward pending-create commits as `selectionChange` events.
    this.controller.setSelectionChangeCallback((sel) => {
      this.selectionChange.emit(sel);
    });

    // mp keybinding — open the model menu when requested.
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
   * The list of providers rendered in the chip's menu. Defaults to chat-4
   * unless the host explicitly passed a wider list via `[providers]`.
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
    const list = this.modelsForProvider();
    return list.find((m) => m.id === id)?.name ?? id;
  });

  protected readonly reasoningSuffix = computed<string | null>(() => {
    const r = this.controller.selectedReasoningEffort();
    return r ? REASONING_LABELS[r] ?? r : null;
  });

  protected readonly modelsForProvider = computed<ModelDisplayInfo[]>(() => {
    const provider = this.controller.selectedProviderId();
    return getModelsForProvider(provider);
  });

  protected readonly reasoningOptionsForMenu = computed(() =>
    this.controller.reasoningOptions().map((opt) => ({ id: opt.id, label: opt.label })),
  );

  // --- Disabled gating ---

  protected readonly providerChipDisabled = computed<string | undefined>(() => {
    if (this._mode() === 'pending-create') return undefined;
    const c = this._chat();
    if (!c) return 'Pick a chat first';
    // Chip is disabled only when no provider switch would be allowed at all
    // (i.e. lock-on-messages applies + a provider is set).
    if (c.provider && this._hasMessages()) {
      return 'Provider can only be changed before the first message';
    }
    return undefined;
  });

  protected readonly modelTriggerDisabled = computed<string | undefined>(() => {
    const provider = this.controller.selectedProviderId();
    if (!provider) return 'Pick a provider first';
    return undefined;
  });

  protected readonly providerDisabledReasonFor = (provider: PickerProvider): string | undefined => {
    return this.controller.disabledReasonFor({ provider });
  };

  // --- Menu toggle ---

  protected toggleProviderMenu(): void {
    if (this.providerChipDisabled()) return;
    this.modelMenuOpen.set(false);
    this.providerMenuOpen.update((v) => !v);
  }

  protected toggleModelMenu(): void {
    if (this.modelTriggerDisabled()) return;
    this.providerMenuOpen.set(false);
    this.modelMenuOpen.update((v) => !v);
  }

  protected closeProviderMenu(): void { this.providerMenuOpen.set(false); }
  protected closeModelMenu(): void { this.modelMenuOpen.set(false); }

  openModelMenu(): void {
    if (this.modelTriggerDisabled()) return;
    this.providerMenuOpen.set(false);
    this.modelMenuOpen.set(true);
  }

  // --- Commit handlers ---

  protected async onProviderSelect(provider: PickerProvider): Promise<void> {
    this.providerMenuOpen.set(false);
    // Provider switch resets the model to the new provider's primary default
    // and clears reasoning (matches the legacy modal's `selectProvider`
    // behavior). Without the reset, the chat would keep the OLD provider's
    // model id, which is invalid for the new provider's runtime.
    const newDefaultModel = getPrimaryModelForProvider(provider) ?? null;
    const ok = await this.controller.commitSelection({
      provider,
      modelId: newDefaultModel,
      reasoning: null,
    });
    if (ok) this.flashStatus(`Provider: ${PROVIDER_MENU_LABELS[provider]}`);
  }

  protected async onModelSelect(selection: ModelMenuSelection): Promise<void> {
    this.modelMenuOpen.set(false);
    const target = selection.reasoning !== undefined
      ? { modelId: selection.modelId, reasoning: selection.reasoning }
      : { modelId: selection.modelId };
    const ok = await this.controller.commitSelection(target);
    if (ok) {
      const label = this.modelsForProvider().find((m) => m.id === selection.modelId)?.name
        ?? selection.modelId;
      const reasoningSuffix = selection.reasoning
        ? ` · ${REASONING_LABELS[selection.reasoning]}`
        : '';
      const restartHint = this._chat()?.currentInstanceId ? ' — runtime restarting' : '';
      this.flashStatus(`Switched to ${label}${reasoningSuffix}${restartHint}`);
    }
  }

  protected onOverlayKeydown(event: KeyboardEvent, which: 'provider' | 'model'): void {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (which === 'provider') this.closeProviderMenu();
      else this.closeModelMenu();
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
