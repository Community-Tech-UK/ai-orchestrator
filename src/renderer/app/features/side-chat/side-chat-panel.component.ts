/**
 * Side Chat Panel — session-linked secondary chat docked on the right rail.
 *
 * Sidechats are linked to a parent session (chat or logical session). Drafts,
 * selection and pending provider choice live in `SideChatStore` keyed by parent
 * identity, so panel close/reopen never loses or cross-wires state between two
 * sessions in the same directory. The panel itself is created lazily on the
 * first send so merely toggling it never spawns chats.
 */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { InstanceStatus, OutputMessage } from '../../../../shared/types/instance.types';
import type { SideChatParentRef, SideChatProviderSelection } from '../../../../shared/types/side-chat.types';
import { ChatStore } from '../../core/state/chat.store';
import { SideChatStore } from '../../core/state/side-chat.store';
import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import { ViewLayoutService } from '../../core/services/view-layout.service';
import { OutputStreamComponent } from '../instance-detail/output-stream.component';
import { chatAsyncAnswerTarget } from '../instance-detail/async-question';
import { ActivityStatusComponent } from '../instance-detail/activity-status.component';
import { CompactModelPickerComponent } from '../models/compact-model-picker.component';
import { ChatOutputMessageMapper } from '../chats/chat-output-message.mapper';

@Component({
  selector: 'app-side-chat-panel',
  standalone: true,
  imports: [OutputStreamComponent, ActivityStatusComponent, CompactModelPickerComponent],
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
  private readonly elRef = inject(ElementRef);

  @ViewChild('panelBody') panelBody?: ElementRef<HTMLElement>;

  /** Working directory for lazily-created side chats (from the dashboard). */
  workingDirectory = input<string | null>(null);
  /** Parent session identity for session-linked sidechats. */
  parent = input<SideChatParentRef | null>(null);
  /** Display name of the parent session for the header. */
  parentTitle = input<string>('');

  closeRequested = output<void>();
  openInMainRequested = output<string>();

  private readonly outputMessageMapper = new ChatOutputMessageMapper();

  readonly error = signal<string | null>(null);

  readonly panelWidth = signal(this.viewLayoutService.sideChatWidth);
  readonly isResizing = signal(false);
  private resizeStartX = 0;
  private resizeStartWidth = 0;

  readonly sideChatId = computed(() => {
    const parent = this.parent();
    return parent ? this.sideChatStore.selectedChatId(parent) : null;
  });

  readonly detail = computed(() => {
    const id = this.sideChatId();
    return id ? this.sideChatStore.detailFor(id) ?? this.chatStore.details().get(id) ?? null : null;
  });
  readonly chat = computed(() => this.detail()?.chat ?? null);
  readonly hasMessages = computed(() => !!this.detail()?.conversation.messages.length);

  readonly draft = computed(() => {
    const parent = this.parent();
    return parent ? this.sideChatStore.draftFor(parent, this.sideChatId()) : '';
  });

  readonly sending = computed(() => this.sideChatStore.sending());

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

  readonly providerForUi = computed(() => this.chat()?.provider ?? 'claude');
  readonly statusForUi = computed<InstanceStatus>(() => this.currentInstance()?.status ?? 'idle');
  readonly isBusy = computed(() => {
    const status = this.statusForUi();
    return status === 'busy'
      || status === 'processing'
      || status === 'thinking_deeply'
      || status === 'waiting_for_permission';
  });
  readonly showActivity = computed(() => {
    const status = this.statusForUi();
    return status === 'busy'
      || status === 'processing'
      || status === 'thinking_deeply'
      || status === 'initializing'
      || status === 'interrupting'
      || status === 'cancelling'
      || status === 'interrupt-escalating';
  });
  readonly activity = computed(() => {
    const instance = this.currentInstance();
    return instance ? this.instanceStore.instanceActivities().get(instance.id) ?? '' : '';
  });
  readonly canSend = computed(() =>
    !this.sending() && !!this.draft().trim() && (!!this.chat() || !!this.workingDirectory())
  );

  readonly showThinking = this.settingsStore.showThinking;
  readonly thinkingDefaultExpanded = this.settingsStore.thinkingDefaultExpanded;
  readonly showToolMessages = this.settingsStore.showToolMessages;

  readonly streamId = computed(() => this.chat()?.id ?? 'side-chat');
  readonly asyncAnswerTarget = computed(() => chatAsyncAnswerTarget(
    this.chat()?.id,
    this.currentInstance()?.id,
    (chatId, text) => this.chatStore.sendMessageTo(chatId, text),
    (error) => this.error.set(error),
  ));

  /** Load sidechats when the parent changes. */
  private readonly loadOnParentChange = effect(() => {
    const parent = this.parent();
    if (parent) {
      void this.sideChatStore.loadForParent(parent);
    }
  });

  readonly loadOlderForOutput = async () => {
    const id = this.sideChatId();
    return id ? this.chatStore.loadOlderMessagesFor(id) : null;
  };

  readonly probeOlderForOutput = async () => {
    const window = this.detail()?.conversation.window;
    return window ? { hasMore: window.hasOlder, totalStored: window.totalMessages } : null;
  };

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

  onSelectionChange(selection: SideChatProviderSelection | null): void {
    const parent = this.parent();
    if (parent) {
      this.sideChatStore.setPendingSelection(parent, selection);
    }
  }

  async send(): Promise<void> {
    const parent = this.parent();
    const text = this.draft().trim();
    if (!parent || !text || this.sending()) {
      return;
    }
    this.error.set(null);
    const ok = await this.sideChatStore.send(
      parent,
      this.sideChatId(),
      text,
      this.workingDirectory() ?? '',
    );
    if (!ok) {
      this.error.set(this.sideChatStore.error() ?? 'Failed to send');
    }
  }

  selectSideChat(chatId: string | null): void {
    const parent = this.parent();
    if (parent) {
      this.sideChatStore.selectChat(parent, chatId);
    }
  }

  sideChatLinks() {
    const parent = this.parent();
    if (!parent) return [];
    const links = this.sideChatStore.links();
    const key = this.sideChatStore.sessionKey(parent);
    // Filter links belonging to this parent.
    return [...links.values()].filter((link) => {
      const linkKey = link.parent.kind === 'chat'
        ? `chat:${link.parent.chatId}`
        : `session:${link.parent.historyThreadId}`;
      return linkKey === key;
    });
  }

  linkTitle(chatId: string): string {
    return this.sideChatStore.detailFor(chatId)?.chat.name
      ?? this.chatStore.details().get(chatId)?.chat.name
      ?? chatId;
  }

  linkUnread(chatId: string): boolean {
    const link = this.sideChatStore.links().get(chatId);
    if (!link) return false;
    const detail = this.sideChatStore.detailFor(chatId) ?? this.chatStore.details().get(chatId);
    const latest = detail?.conversation.messages
      .filter((m) => m.role === 'assistant')
      .reduce((max, m) => Math.max(max, m.sequence), 0) ?? 0;
    return latest > link.lastReadAssistantSequence;
  }

  async archiveSideChat(): Promise<void> {
    const chatId = this.sideChatId();
    if (!chatId) return;
    await this.chatStore.archive(chatId);
    this.sideChatStore.removeSideChat(chatId);
    this.startNewSideChat();
  }

  /**
   * Mark the current answer as read only when the panel is visible and the
   * user has scrolled to show the latest output (i.e. the answer is viewed).
   * A scrolled-up reader keeps the answer unread.
   */
  markReadIfVisible(): void {
    const chatId = this.sideChatId();
    if (!chatId || this.isBusy()) return;
    // Scope the scroll check to this panel's own body element (not a global
    // query that could match another panel in combined layouts).
    const body = this.panelBody?.nativeElement
      ?? this.elRef.nativeElement.querySelector('.panel-body');
    if (!body) return;
    const atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 60;
    if (!atBottom) return;
    const detail = this.sideChatStore.detailFor(chatId) ?? this.chatStore.details().get(chatId);
    const latest = detail?.conversation.messages
      .filter((m) => m.role === 'assistant')
      .reduce((max, m) => Math.max(max, m.sequence), 0) ?? 0;
    if (latest > 0) {
      void this.sideChatStore.markRead(chatId, latest);
    }
  }

  startNewSideChat(): void {
    this.selectSideChat(null);
    this.error.set(null);
  }

  openInMain(): void {
    const chatId = this.sideChatId();
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
}
