import { Injectable, computed, effect, inject, signal } from '@angular/core';
import {
  getModelsForProvider,
  type ReasoningEffort,
} from '../../../../shared/types/provider.types';
import { ChatStore } from '../../core/state/chat.store';
import type { InstanceProvider } from '../../core/state/instance/instance.types';
import type { ChatRecord } from '../../../../shared/types/chat.types';
import type {
  CommitTarget,
  CompactPickerMode,
  PendingSelection,
} from './compact-model-picker.types';

export interface ModelPickerReasoningOption {
  id: 'default' | ReasoningEffort;
  label: string;
  description: string;
}

/**
 * Compact-model-picker controller. Component-scoped (each
 * `<app-compact-model-picker>` provides its own instance) so two pickers
 * mounted simultaneously — sidebar new-chat form + chat-detail bar — keep
 * independent selection state.
 *
 * Two operating modes:
 *   - `'live-instance'`: bound to a `ChatRecord`. `commitSelection` calls
 *     `ChatStore.setProvider/setModel/setReasoning` which terminate the
 *     chat's runtime so the next message spawns a fresh instance with
 *     the new config.
 *   - `'pending-create'`: bound to a form before the chat exists.
 *     `commitSelection` updates an in-memory `PendingSelection` and
 *     forwards it via the registered callback. No backend call.
 */
@Injectable({ providedIn: 'root' })
export class ModelPickerController {
  private readonly chatStore = inject(ChatStore);

  readonly selectedProviderId = signal<InstanceProvider>('claude');
  readonly selectedModelId = signal('');
  readonly selectedReasoningEffort = signal<ReasoningEffort | null>(null);
  /** True while a `commitSelection` call is in flight. */
  readonly applying = signal(false);

  readonly pickerMode = signal<CompactPickerMode>('live-instance');

  /** Live ChatRecord bound to the picker in `'live-instance'` mode. */
  private readonly chat = signal<ChatRecord | null>(null);

  /**
   * `true` when the bound chat already has at least one durable message.
   * Drives the lock-on-messages rule — the renderer matches what
   * `ChatService.setProvider` enforces server-side so the picker can disable
   * itself before the click instead of throwing on commit.
   */
  private readonly chatHasMessages = signal(false);

  /** Pending form state for `'pending-create'` mode (two-way bound). */
  private readonly pendingSelection = signal<PendingSelection | null>(null);

  /** Callback registered by the host for `'pending-create'` mode. */
  private pendingSelectionChange: ((selection: PendingSelection) => void) | null = null;

  constructor() {
    effect(() => {
      // Live-instance: mirror the bound chat into the rendering signals
      // so re-renders pick up provider/model/reasoning whenever the chat
      // record refreshes (e.g. after a chat-updated event).
      if (this.pickerMode() !== 'live-instance') return;
      const c = this.chat();
      if (!c) return;
      const provider = (c.provider ?? 'claude') as InstanceProvider;
      this.selectedProviderId.set(provider);
      this.selectedModelId.set(c.model ?? this.defaultModelForProvider(provider));
      this.selectedReasoningEffort.set(c.reasoningEffort);
    });

    effect(() => {
      // Pending-create: mirror the form's selection so the menu renders
      // the right "current" state.
      if (this.pickerMode() !== 'pending-create') return;
      const sel = this.pendingSelection();
      if (!sel) return;
      const provider = sel.provider as InstanceProvider;
      this.selectedProviderId.set(provider);
      this.selectedModelId.set(sel.model ?? this.defaultModelForProvider(provider));
      this.selectedReasoningEffort.set(sel.reasoning);
    });
  }

  /** Compact-picker setup. Called by `CompactModelPickerComponent`. */
  setMode(mode: CompactPickerMode): void {
    this.pickerMode.set(mode);
  }

  setChat(chat: ChatRecord, hasMessages: boolean): void {
    this.chat.set(chat);
    this.chatHasMessages.set(hasMessages);
  }

  setSelection(selection: PendingSelection): void {
    this.pendingSelection.set(selection);
  }

  setSelectionChangeCallback(callback: (selection: PendingSelection) => void): void {
    this.pendingSelectionChange = callback;
  }

  /**
   * Returns a disabled-reason string for the given target, or `undefined`
   * when the target would be acceptable. Consumed by the menu rows for
   * per-item gating, and by the bar chips for own-chip gating.
   */
  disabledReasonFor(target: CommitTarget): string | undefined {
    if (this.pickerMode() === 'pending-create') {
      // Before a chat exists, no rules apply — every selection is just form state.
      return undefined;
    }
    const c = this.chat();
    const hasMessages = this.chatHasMessages();

    if (target.provider !== undefined) {
      // Lock-on-messages: ChatService.setProvider throws if the chat already
      // has a provider AND messages exist.
      if (c?.provider && hasMessages && target.provider !== c.provider) {
        return 'Provider can only be changed before the first message';
      }
    }

    if (target.modelId !== undefined) {
      const targetProvider = target.provider ?? c?.provider;
      if (!targetProvider) return 'Pick a provider first';
    }

    if (target.reasoning !== undefined) {
      const targetProvider = target.provider ?? c?.provider;
      if (!targetProvider) return 'Pick a provider first';
    }

    return undefined;
  }

  /**
   * Single commit path used by every menu interaction. In live-instance
   * mode each non-undefined field hits the matching `chatStore.setX`,
   * which terminates the runtime and persists the value. In pending-create
   * mode the merged selection is forwarded via the registered callback;
   * no backend call.
   *
   * Returns `true` on success, `false` when the target was disabled.
   */
  async commitSelection(target: CommitTarget): Promise<boolean> {
    if (this.disabledReasonFor(target)) return false;

    const mode = this.pickerMode();

    if (mode === 'pending-create') {
      const current = this.pendingSelection();
      if (!current) return false;
      const next: PendingSelection = {
        provider: target.provider ?? current.provider,
        model: target.modelId !== undefined ? target.modelId : current.model,
        reasoning: target.reasoning !== undefined ? target.reasoning : current.reasoning,
      };
      this.pendingSelection.set(next);
      this.pendingSelectionChange?.(next);
      return true;
    }

    // 'live-instance'
    const c = this.chat();
    if (!c) return false;
    this.applying.set(true);
    try {
      if (target.provider !== undefined && target.provider !== c.provider) {
        await this.chatStore.setProvider(c.id, target.provider);
      }
      if (target.modelId !== undefined && target.modelId !== c.model) {
        await this.chatStore.setModel(c.id, target.modelId);
      }
      if (target.reasoning !== undefined && target.reasoning !== c.reasoningEffort) {
        await this.chatStore.setReasoning(c.id, target.reasoning);
      }
      return true;
    } finally {
      this.applying.set(false);
    }
  }

  readonly reasoningOptions = computed<ModelPickerReasoningOption[]>(() => {
    const provider = this.selectedProviderId();
    const defaults: ModelPickerReasoningOption[] = [
      { id: 'default', label: 'Default', description: 'Let the provider decide' },
    ];

    if (provider === 'claude') {
      return [
        ...defaults,
        { id: 'low', label: 'Low', description: 'Shorter thinking' },
        { id: 'medium', label: 'Medium', description: 'Balanced thinking' },
        { id: 'high', label: 'High', description: 'Deeper thinking' },
        { id: 'xhigh', label: 'Max', description: 'Largest thinking budget' },
      ];
    }

    if (provider === 'codex') {
      return [
        ...defaults,
        { id: 'none', label: 'Off', description: 'No extra reasoning effort' },
        { id: 'minimal', label: 'Minimal', description: 'Light reasoning' },
        { id: 'low', label: 'Low', description: 'Shorter thinking' },
        { id: 'medium', label: 'Medium', description: 'Balanced thinking' },
        { id: 'high', label: 'High', description: 'Deeper thinking' },
        { id: 'xhigh', label: 'Max', description: 'Largest thinking budget' },
      ];
    }

    return [];
  });

  private defaultModelForProvider(provider: InstanceProvider): string {
    return getModelsForProvider(provider)[0]?.id ?? '';
  }
}
