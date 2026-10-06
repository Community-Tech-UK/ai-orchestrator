/**
 * Side Chat Panel — session-linked sidechats docked on the right rail.
 *
 * Every sidechat belongs to the parent session shown in the main view. Drafts,
 * selection, provider choice and errors live in `SideChatStore` keyed by that
 * parent, so closing the panel or switching sessions never loses or cross-wires
 * them. Opening the panel spawns nothing; the first question creates the
 * sidechat with the provider chosen beforehand.
 */

import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  HostListener,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import type { InstanceStatus, OutputMessage } from '../../../../shared/types/instance.types';
import type {
  SideChatConversationState,
  SideChatParentRef,
  SideChatProvider,
  SideChatProviderSelection,
  SideChatSummary,
} from '../../../../shared/types/side-chat.types';
import { ChatStore } from '../../core/state/chat.store';
import { SideChatStore } from '../../core/state/side-chat.store';
import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import { ViewLayoutService } from '../../core/services/view-layout.service';
import { OutputStreamComponent } from '../instance-detail/output-stream.component';
import { chatAsyncAnswerTarget } from '../instance-detail/async-question';
import { ActivityStatusComponent } from '../instance-detail/activity-status.component';
import { CompactModelPickerComponent } from '../models/compact-model-picker.component';
import type { PendingSelection, PickerProvider } from '../models/compact-model-picker.types';
import { PROVIDER_MENU_LABELS, SIDE_CHAT_MENU_PROVIDERS } from '../models/provider-menu.constants';
import { ChatOutputMessageMapper } from '../chats/chat-output-message.mapper';
import { UserActionRequestComponent } from '../instance-detail/user-action-request.component';
import { BrowserApprovalRequestComponent } from '../instance-detail/browser-approval-request.component';
import { describePermissionPolicy } from './side-chat-permissions';

const BUSY_STATUSES = new Set<InstanceStatus>([
  'busy', 'processing', 'thinking_deeply', 'waiting_for_permission', 'initializing',
  'interrupting', 'cancelling', 'interrupt-escalating', 'respawning', 'waking',
]);

const STATE_LABELS: Record<SideChatConversationState, string> = {
  'needs-attention': 'Needs action',
  unread: 'Unread answer',
  running: 'Running',
  idle: 'Idle',
};

/** Distance from the bottom (px) still counted as "viewing the latest answer". */
const AT_BOTTOM_TOLERANCE_PX = 48;

@Component({
  selector: 'app-side-chat-panel',
  standalone: true,
  imports: [
    OutputStreamComponent,
    ActivityStatusComponent,
    CompactModelPickerComponent,
    UserActionRequestComponent,
    BrowserApprovalRequestComponent,
  ],
  templateUrl: './side-chat-panel.component.html',
  styleUrl: './side-chat-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SideChatPanelComponent {
  readonly chatStore = inject(ChatStore);
  readonly sideChatStore = inject(SideChatStore);
  private readonly instanceStore = inject(InstanceStore);
  private readonly settingsStore = inject(SettingsStore);
  private readonly viewLayoutService = inject(ViewLayoutService);
  private readonly elRef = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Fallback working directory; main uses the parent's own workspace. */
  workingDirectory = input<string | null>(null);
  /** Parent session identity for session-linked sidechats. */
  parent = input<SideChatParentRef | null>(null);
  /** Display name of the parent session for the header. */
  parentTitle = input<string>('');
  /** The parent's own provider/model, offered as the initial selection. */
  parentSelection = input<SideChatProviderSelection | null>(null);
  /** Conversation to open first (from a badge or attention list). */
  preferredChatId = input<string | null>(null);

  closeRequested = output<void>();
  openInMainRequested = output<string>();

  private readonly outputMessageMapper = new ChatOutputMessageMapper();

  readonly panelWidth = signal(this.viewLayoutService.sideChatWidth);
  readonly isResizing = signal(false);
  readonly showPermissionDetails = signal(false);
  readonly attachChoice = signal('');
  /** Panel-local message (e.g. a failed answer to an agent question). */
  readonly notice = signal<string | null>(null);
  /** Whether the transcript is scrolled to (or near) its newest content. */
  readonly atBottom = signal(true);
  private readonly viewTick = signal(0);
  private resizeStartX = 0;
  private resizeStartWidth = 0;

  readonly sideChatId = computed(() => {
    const parent = this.parent();
    return parent ? this.sideChatStore.selectedChatId(parent) : null;
  });

  readonly summaries = computed<SideChatSummary[]>(() => {
    const parent = this.parent();
    return parent ? this.sideChatStore.summariesFor(parent) : [];
  });

  readonly archived = computed(() => {
    const parent = this.parent();
    return parent ? this.sideChatStore.archivedFor(parent) : [];
  });

  readonly selectedSummary = computed(() =>
    this.summaries().find((summary) => summary.chat.id === this.sideChatId()) ?? null);

  readonly detail = computed(() => {
    const id = this.sideChatId();
    return id ? this.chatStore.details().get(id) ?? null : null;
  });
  readonly chat = computed(() => this.detail()?.chat ?? this.selectedSummary()?.chat ?? null);
  readonly hasMessages = computed(() => !!this.detail()?.conversation.messages.length);

  readonly draft = computed(() => {
    const parent = this.parent();
    return parent ? this.sideChatStore.draftFor(parent, this.sideChatId()) : '';
  });

  readonly sending = computed(() => {
    const parent = this.parent();
    return parent ? this.sideChatStore.isSending(parent) : false;
  });

  readonly error = computed(() => {
    const parent = this.parent();
    return parent ? this.sideChatStore.errorFor(parent) : null;
  });

  readonly permissions = computed(() => {
    const parent = this.parent();
    return parent ? this.sideChatStore.permissionsFor(parent) : null;
  });

  readonly permissionLines = computed(() => {
    const permissions = this.permissions();
    return permissions?.ok ? describePermissionPolicy(permissions.policy) : [];
  });

  /** Providers that can enforce the parent's policy, in picker order. */
  readonly availableProviders = computed<PickerProvider[]>(() => {
    const permissions = this.permissions();
    if (!permissions) return SIDE_CHAT_MENU_PROVIDERS;
    const allowed = new Set(permissions.providers.filter((entry) => entry.available).map((entry) => entry.provider));
    return SIDE_CHAT_MENU_PROVIDERS.filter((provider) => allowed.has(provider as SideChatProvider));
  });

  /** Providers hidden from the picker, with the concrete reason. */
  readonly unavailableProviders = computed(() => {
    const permissions = this.permissions();
    if (!permissions) return [];
    return permissions.providers
      .filter((entry) => !entry.available && SIDE_CHAT_MENU_PROVIDERS.includes(entry.provider as PickerProvider))
      .map((entry) => ({ label: PROVIDER_MENU_LABELS[entry.provider as PickerProvider], reason: entry.reason ?? '' }));
  });

  /** Selection shown in the picker: the chat's own, or the pending choice for a new one. */
  readonly pickerSelection = computed<PendingSelection | null>(() => {
    const chat = this.chat();
    if (chat?.provider) {
      return {
        provider: chat.provider as PickerProvider,
        model: chat.model,
        reasoning: chat.reasoningEffort,
        modelRuntimeTarget: chat.modelRuntimeTarget ?? null,
      };
    }
    const parent = this.parent();
    const pending = parent ? this.sideChatStore.pendingSelection(parent) : null;
    return (pending as PendingSelection | null) ?? this.defaultSelection();
  });

  /** The parent's provider when it can enforce the policy, else the first usable one. */
  readonly defaultSelection = computed<PendingSelection | null>(() => {
    const available = this.availableProviders();
    const fromParent = this.parentSelection();
    if (fromParent && available.includes(fromParent.provider as PickerProvider)) {
      return { ...fromParent, provider: fromParent.provider as PickerProvider, model: fromParent.model ?? null, reasoning: fromParent.reasoning ?? null };
    }
    const first = available[0];
    return first ? { provider: first, model: null, reasoning: null } : null;
  });

  readonly currentInstance = computed(() => {
    const detail = this.detail();
    const instanceId = detail?.chat.currentInstanceId;
    if (!instanceId) {
      return detail?.currentInstance ?? null;
    }
    return this.instanceStore.getInstance(instanceId) ?? detail?.currentInstance ?? null;
  });

  readonly messages = computed<OutputMessage[]>(() => {
    const detail = this.detail();
    if (!detail) {
      return [];
    }
    const ledgerMessages = detail.conversation.messages.map((message) =>
      this.outputMessageMapper.toOutputMessage(message)
    );
    const seenIds = new Set(ledgerMessages.map((message) => message.id));
    const runtimeMessages = this.currentInstance()?.outputBuffer ?? [];
    const runtimeOnly = runtimeMessages.filter((message) =>
      message.type !== 'user' && !seenIds.has(message.id)
    );
    return [...ledgerMessages, ...runtimeOnly];
  });

  /** Newest assistant answer sequence in the loaded transcript. */
  readonly latestAssistantSequence = computed(() =>
    (this.detail()?.conversation.messages ?? [])
      .filter((message) => message.role === 'assistant')
      .reduce((max, message) => Math.max(max, message.sequence), 0));

  readonly hasUnreadAnswer = computed(() => {
    const summary = this.selectedSummary();
    return !!summary && this.latestAssistantSequence() > summary.link.lastReadAssistantSequence;
  });

  /** A new answer arrived while the reader is scrolled up. */
  readonly showNewAnswer = computed(() => this.hasUnreadAnswer() && !this.atBottom());

  readonly providerForUi = computed(() => {
    const provider = this.chat()?.provider ?? 'claude';
    // Local models render through the generic conversation view.
    return provider === 'local-model' ? 'claude' : provider;
  });
  readonly statusForUi = computed<InstanceStatus>(() => this.currentInstance()?.status ?? 'idle');
  readonly isBusy = computed(() => BUSY_STATUSES.has(this.statusForUi()));
  readonly showActivity = computed(() => {
    const status = this.statusForUi();
    return status !== 'waiting_for_permission' && BUSY_STATUSES.has(status);
  });
  readonly activity = computed(() => {
    const instance = this.currentInstance();
    return instance ? this.instanceStore.instanceActivities().get(instance.id) ?? '' : '';
  });
  readonly pickerDisabledReason = computed(() =>
    this.isBusy() ? 'Stop the current answer before changing provider or model' : null);
  readonly canSend = computed(() =>
    !!this.parent() && !this.sending() && !!this.draft().trim() && (!!this.chat() || !!this.pickerSelection()));

  /** Existing chats in this workspace that could be attached explicitly. */
  readonly attachCandidates = computed(() => {
    const parent = this.parent();
    if (!parent) return [];
    const linked = new Set([...this.summaries(), ...this.archived().map((chat) => ({ chat }))].map((item) => item.chat.id));
    const cwd = this.workingDirectory();
    return this.chatStore.chats().filter((chat) =>
      !linked.has(chat.id)
      && !chat.sideChatParentKey
      && !(parent.kind === 'chat' && parent.chatId === chat.id)
      && (!cwd || chat.currentCwd === cwd));
  });

  readonly showThinking = this.settingsStore.showThinking;
  readonly thinkingDefaultExpanded = this.settingsStore.thinkingDefaultExpanded;
  readonly showToolMessages = this.settingsStore.showToolMessages;

  readonly streamId = computed(() => this.chat()?.id ?? 'side-chat');
  readonly asyncAnswerTarget = computed(() => chatAsyncAnswerTarget(
    this.chat()?.id,
    this.currentInstance()?.id,
    (chatId, text) => this.chatStore.sendMessageTo(chatId, text),
    (message) => this.notice.set(message),
  ));

  constructor() {
    // Load the parent's sidechats (and permission posture) whenever the main
    // session changes. The store drops late responses for a superseded load.
    effect(() => {
      const parent = this.parent();
      const preferred = this.preferredChatId();
      if (parent) {
        untracked(() => void this.sideChatStore.open(parent, preferred));
      }
    });
    // Re-check visibility whenever the answer or selection changes.
    effect(() => {
      this.latestAssistantSequence();
      this.sideChatId();
      untracked(() => this.scheduleViewCheck());
    });
    effect(() => {
      this.viewTick();
      untracked(() => this.markReadIfViewed());
    });

    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const host = this.elRef.nativeElement;
      // The transcript scrolls inside app-output-stream; scroll events do not
      // bubble, so listen in the capture phase on the panel itself.
      const onScroll = () => this.scheduleViewCheck();
      host.addEventListener('scroll', onScroll, true);
      destroyRef.onDestroy(() => host.removeEventListener('scroll', onScroll, true));
    });
  }

  readonly loadOlderForOutput = async () => {
    const id = this.sideChatId();
    return id ? this.chatStore.loadOlderMessagesFor(id) : null;
  };

  readonly probeOlderForOutput = async () => {
    const window = this.detail()?.conversation.window;
    return window ? { hasMore: window.hasOlder, totalStored: window.totalMessages } : null;
  };

  providerLabel(provider: string | null): string {
    return provider ? PROVIDER_MENU_LABELS[provider as PickerProvider] ?? provider : 'No provider';
  }

  stateLabel(state: SideChatConversationState): string {
    return STATE_LABELS[state];
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.send();
    }
  }

  onDraftInput(event: Event): void {
    const parent = this.parent();
    if (parent) {
      this.sideChatStore.setDraft(parent, this.sideChatId(), (event.target as HTMLTextAreaElement).value);
    }
  }

  onSelectionChange(selection: PendingSelection): void {
    const parent = this.parent();
    if (!parent) return;
    const next: SideChatProviderSelection = {
      provider: selection.provider as SideChatProvider,
      model: selection.model,
      reasoning: selection.reasoning,
      modelRuntimeTarget: selection.modelRuntimeTarget ?? null,
    };
    const chatId = this.sideChatId();
    if (chatId) {
      void this.sideChatStore.setSelection(parent, chatId, next);
    } else {
      this.sideChatStore.setPendingSelection(parent, next);
    }
  }

  async send(options: { allowStaleContext?: boolean } = {}): Promise<void> {
    const parent = this.parent();
    const text = options.allowStaleContext ? this.error()?.text ?? '' : this.draft();
    if (!parent || !text.trim() || this.sending()) {
      return;
    }
    const fallback = this.defaultSelection();
    await this.sideChatStore.send(parent, this.sideChatId(), text, this.workingDirectory() ?? '', {
      allowStaleContext: options.allowStaleContext,
      fallbackSelection: fallback
        ? { ...fallback, provider: fallback.provider as SideChatProvider }
        : undefined,
    });
    this.scheduleViewCheck();
  }

  sendWithLastSnapshot(): void {
    void this.send({ allowStaleContext: true });
  }

  selectSideChat(chatId: string | null): void {
    const parent = this.parent();
    if (parent) {
      this.sideChatStore.selectChat(parent, chatId);
    }
  }

  onSelectorKeydown(event: KeyboardEvent, index: number): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = Array.from(this.elRef.nativeElement.querySelectorAll<HTMLElement>('.selector-item'));
    const next = items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next?.focus();
  }

  async archiveSideChat(): Promise<void> {
    const parent = this.parent();
    const chatId = this.sideChatId();
    if (parent && chatId) {
      await this.sideChatStore.archive(parent, chatId);
    }
  }

  async attachSelected(): Promise<void> {
    const parent = this.parent();
    const chatId = this.attachChoice();
    if (parent && chatId) {
      if (await this.sideChatStore.attach(parent, chatId)) {
        this.attachChoice.set('');
      }
    }
  }

  onAttachChoice(event: Event): void {
    this.attachChoice.set((event.target as HTMLSelectElement).value);
  }

  startNewSideChat(): void {
    this.selectSideChat(null);
  }

  openInMain(chatId: string | null = this.sideChatId()): void {
    if (chatId) {
      this.openInMainRequested.emit(chatId);
    }
  }

  async interrupt(): Promise<void> {
    const instance = this.currentInstance();
    if (instance) {
      await this.instanceStore.interruptInstance(instance.id);
    }
  }

  /** Scroll to the newest answer; viewing it there marks it read. */
  jumpToNewAnswer(): void {
    const viewport = this.transcriptViewport();
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
    this.scheduleViewCheck();
  }

  @HostListener('window:focus')
  @HostListener('document:visibilitychange')
  onVisibilityChange(): void {
    this.scheduleViewCheck();
  }

  onResizeStart(event: MouseEvent): void {
    event.preventDefault();
    this.isResizing.set(true);
    this.resizeStartX = event.clientX;
    this.resizeStartWidth = this.panelWidth();
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(event: MouseEvent): void {
    if (!this.isResizing()) return;
    const delta = this.resizeStartX - event.clientX;
    const newWidth = Math.max(280, Math.min(560, this.resizeStartWidth + delta));
    this.panelWidth.set(newWidth);
    this.viewLayoutService.setSideChatWidth(newWidth);
  }

  @HostListener('document:mouseup')
  onMouseUp(): void {
    if (this.isResizing()) {
      this.isResizing.set(false);
    }
  }

  /**
   * Acknowledge the selected sidechat through its newest answer only when that
   * answer is actually on screen: app visible and focused, and the transcript
   * scrolled to the bottom. A hidden panel, background app or scrolled-up
   * reader leaves it unread.
   */
  private markReadIfViewed(): void {
    const parent = this.parent();
    const chatId = this.sideChatId();
    const viewport = this.transcriptViewport();
    const atBottom = viewport
      ? viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= AT_BOTTOM_TOLERANCE_PX
      : true;
    this.atBottom.set(atBottom);
    if (!parent || !chatId || !viewport || !atBottom || !this.hasUnreadAnswer()) return;
    if (typeof document !== 'undefined' && (document.visibilityState !== 'visible' || !document.hasFocus())) return;
    void this.sideChatStore.markRead(parent, chatId, this.latestAssistantSequence());
  }

  private scheduleViewCheck(): void {
    // After the next frame so the transcript has rendered the new answer.
    requestAnimationFrame(() => this.viewTick.update((tick) => tick + 1));
  }

  private transcriptViewport(): HTMLElement | null {
    return this.elRef.nativeElement.querySelector<HTMLElement>('.panel-body .output-stream');
  }
}
