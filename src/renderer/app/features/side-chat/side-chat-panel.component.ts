/**
 * Side Chat Panel — a Codex-style secondary chat docked on the right rail.
 *
 * Hosts a real chat (full ChatService/ledger backing) that lives ALONGSIDE the
 * main workspace selection: asking questions here never steers the primary
 * instance or changes what the main view shows. The panel's chat id is
 * persisted locally so the same side conversation survives reloads; the chat
 * itself is created lazily on the first send so merely toggling the panel
 * never spawns chats.
 *
 * Visibility is controlled by the dashboard (`showSideChat()`), mirroring the
 * source-control/file-explorer right-rail panels. Width persists via
 * `ViewLayoutService.sideChatWidth`.
 */

import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  OnInit,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import type { ChatProvider } from '../../../../shared/types/chat.types';
import type { InstanceStatus, OutputMessage } from '../../../../shared/types/instance.types';
import { ChatStore } from '../../core/state/chat.store';
import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import { ViewLayoutService } from '../../core/services/view-layout.service';
import { readStorage, writeStorage, type StorageField } from '../../shared/utils/typed-storage';
import { OutputStreamComponent } from '../instance-detail/output-stream.component';
import { ActivityStatusComponent } from '../instance-detail/activity-status.component';
import { CompactModelPickerComponent } from '../models/compact-model-picker.component';
import { ChatOutputMessageMapper } from '../chats/chat-output-message.mapper';

interface SideChatState {
  chatId: string | null;
}

const SIDE_CHAT_FIELD: StorageField<SideChatState> = {
  key: 'side-chat-state',
  version: 1,
  defaultValue: { chatId: null },
};

@Component({
  selector: 'app-side-chat-panel',
  standalone: true,
  imports: [OutputStreamComponent, ActivityStatusComponent, CompactModelPickerComponent],
  templateUrl: './side-chat-panel.component.html',
  styleUrl: './side-chat-panel.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SideChatPanelComponent implements OnInit {
  readonly chatStore = inject(ChatStore);
  private readonly instanceStore = inject(InstanceStore);
  private readonly settingsStore = inject(SettingsStore);
  private readonly viewLayoutService = inject(ViewLayoutService);

  /** Working directory for lazily-created side chats (from the dashboard). */
  workingDirectory = input<string | null>(null);

  closeRequested = output<void>();
  /** Ask the dashboard to open this chat in the main workspace view. */
  openInMainRequested = output<string>();

  private readonly outputMessageMapper = new ChatOutputMessageMapper();

  readonly sideChatId = signal<string | null>(null);
  readonly draft = signal('');
  readonly sending = signal(false);
  readonly error = signal<string | null>(null);

  // Panel-local resize state (mirrors the source-control panel).
  readonly panelWidth = signal(this.viewLayoutService.sideChatWidth);
  readonly isResizing = signal(false);
  private resizeStartX = 0;
  private resizeStartWidth = 0;

  readonly detail = computed(() => {
    const id = this.sideChatId();
    return id ? this.chatStore.details().get(id) ?? null : null;
  });
  readonly chat = computed(() => this.detail()?.chat ?? null);
  readonly hasMessages = computed(() => !!this.detail()?.conversation.messages.length);

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

  readonly providerForUi = computed<ChatProvider>(() => this.chat()?.provider ?? 'claude');
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

  /**
   * If the bound chat disappears from the (non-archived) chat list — e.g. it
   * was archived from the main chat sidebar — detach so the panel returns to
   * its fresh-start state instead of sending into a dead chat.
   */
  private readonly detachWhenChatRemoved = effect(() => {
    const id = this.sideChatId();
    if (id && !this.chatStore.chats().some((chat) => chat.id === id)) {
      this.startNewSideChat();
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

  ngOnInit(): void {
    void this.restorePersistedChat();
  }

  /**
   * Re-attach to the persisted side chat if it still exists (it may have been
   * archived from the main chat list since the last session).
   */
  private async restorePersistedChat(): Promise<void> {
    await this.chatStore.initialize();
    const storedId = readStorage(SIDE_CHAT_FIELD).chatId;
    if (!storedId) {
      return;
    }
    if (!this.chatStore.chats().some((chat) => chat.id === storedId)) {
      writeStorage(SIDE_CHAT_FIELD, { chatId: null });
      return;
    }
    this.sideChatId.set(storedId);
    await this.chatStore.ensureDetailLoaded(storedId);
  }

  onComposerKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void this.send();
    }
  }

  onDraftInput(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
  }

  async send(): Promise<void> {
    const text = this.draft().trim();
    if (!text || this.sending()) {
      return;
    }
    this.sending.set(true);
    this.error.set(null);
    try {
      const chatId = this.sideChatId() ?? await this.createSideChat();
      if (!chatId) {
        return;
      }
      const result = await this.chatStore.sendMessageTo(chatId, text);
      if (!result.ok) {
        this.error.set(result.error);
        return;
      }
      this.draft.set('');
    } finally {
      this.sending.set(false);
    }
  }

  private async createSideChat(): Promise<string | null> {
    const cwd = this.workingDirectory();
    if (!cwd) {
      this.error.set('Select a project or workspace first.');
      return null;
    }
    const created = await this.chatStore.createDetached({
      name: 'Side chat',
      provider: 'claude',
      currentCwd: cwd,
      yolo: this.settingsStore.defaultYoloMode(),
    });
    if (!created.ok) {
      this.error.set(created.error);
      return null;
    }
    const chatId = created.detail.chat.id;
    this.sideChatId.set(chatId);
    writeStorage(SIDE_CHAT_FIELD, { chatId });
    return chatId;
  }

  /** Detach from the current side chat; the next send starts a fresh one. */
  startNewSideChat(): void {
    this.sideChatId.set(null);
    this.error.set(null);
    writeStorage(SIDE_CHAT_FIELD, { chatId: null });
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

  // ===== Resize handlers (left-edge handle; grows leftward) =====

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
