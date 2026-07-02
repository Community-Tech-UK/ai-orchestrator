import { Injectable, computed, inject, signal } from '@angular/core';
import type { ChatCreateInput, ChatDetail, ChatEvent, ChatRecord, ChatUiState } from '../../../../shared/types/chat.types';
import type {
  ConversationLedgerConversation,
  ConversationMessageRecord,
} from '../../../../shared/types/conversation-ledger.types';
import type { FileAttachment } from '../../../../shared/types/instance.types';
import type { ReasoningEffort } from '../../../../shared/types/provider.types';
import { ChatIpcService } from '../services/ipc/chat-ipc.service';

export interface ChatOlderMessagesLoadResult {
  prependedCount: number;
  hasMore: boolean;
  totalStored: number;
}

/**
 * Result of an id-addressed store operation (used by surfaces that manage
 * their own error presentation, e.g. the side-chat panel, instead of the
 * store-global `error` signal consumed by the main chat view).
 */
export type ChatOperationResult =
  | { ok: true }
  | { ok: false; error: string };

export type ChatDetachedCreateResult =
  | { ok: true; detail: ChatDetail }
  | { ok: false; error: string };

@Injectable({ providedIn: 'root' })
export class ChatStore {
  private readonly ipc = inject(ChatIpcService);
  private readonly _chats = signal<ChatRecord[]>([]);
  private readonly _selectedChatId = signal<string | null>(null);
  private readonly _details = signal(new Map<string, ChatDetail>());
  private readonly _loading = signal(false);
  private readonly _sending = signal(false);
  private readonly _error = signal<string | null>(null);
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;
  private unsubscribeChatEvents: (() => void) | null = null;
  private restoredUiState = false;

  readonly chats = this._chats.asReadonly();
  /**
   * Cached chat details keyed by chat id. Lets secondary surfaces (e.g. the
   * side-chat panel) reactively read a chat that is NOT the globally selected
   * one: `computed(() => chatStore.details().get(id) ?? null)`.
   */
  readonly details = this._details.asReadonly();
  readonly selectedChatId = this._selectedChatId.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly sending = this._sending.asReadonly();
  readonly error = this._error.asReadonly();

  setError(message: string | null): void {
    this._error.set(message);
  }
  readonly selectedDetail = computed(() => {
    const id = this._selectedChatId();
    return id ? this._details().get(id) ?? null : null;
  });
  readonly selectedChat = computed(() => this.selectedDetail()?.chat ?? null);

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initializationPromise) {
      return this.initializationPromise;
    }
    this.subscribeToChatEvents();
    this.initializationPromise = this.loadChats().then(async () => {
      await this.restoreUiState();
      this.initialized = true;
    }).finally(() => {
      this.initializationPromise = null;
    });
    return this.initializationPromise;
  }

  async loadChats(): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    try {
      const response = await this.ipc.list();
      if (response.success && response.data) {
        this._chats.set(response.data);
      } else {
        this._error.set(response.error?.message ?? 'Failed to load chats');
      }
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : 'Failed to load chats');
    } finally {
      this._loading.set(false);
    }
  }

  async select(chatId: string): Promise<void> {
    await this.initialize();
    this._selectedChatId.set(chatId);
    void this.persistUiState(chatId);
    await this.loadDetail(chatId);
  }

  deselect(): void {
    this._selectedChatId.set(null);
    void this.persistUiState(null);
  }

  async selectFirstChat(): Promise<void> {
    await this.initialize();
    const first = this._chats()[0];
    if (first) {
      await this.select(first.id);
    }
  }

  async create(payload: ChatCreateInput): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    try {
      const response = await this.ipc.create(payload);
      if (response.success && response.data) {
        this.mergeDetail(response.data);
        this._selectedChatId.set(response.data.chat.id);
        void this.persistUiState(response.data.chat.id);
        await this.loadChats();
      } else {
        this._error.set(response.error?.message ?? 'Failed to create chat');
      }
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : 'Failed to create chat');
    } finally {
      this._loading.set(false);
    }
  }

  /**
   * Create a chat WITHOUT selecting it or touching persisted UI state — the
   * main workspace keeps whatever it is showing. Used by the side-chat panel,
   * whose chat lives alongside the primary selection. Errors are returned to
   * the caller instead of being written to the store-global `error` signal.
   */
  async createDetached(payload: ChatCreateInput): Promise<ChatDetachedCreateResult> {
    try {
      const response = await this.ipc.create(payload);
      if (response.success && response.data) {
        this.mergeDetail(response.data);
        this.mergeChat(response.data.chat);
        return { ok: true, detail: response.data };
      }
      return { ok: false, error: response.error?.message ?? 'Failed to create chat' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Failed to create chat' };
    }
  }

  /**
   * Ensure a chat's detail is cached (loading it quietly if absent) without
   * selecting the chat. Once cached, incremental `transcript-appended` events
   * keep it fresh even while another chat/instance owns the main view.
   */
  async ensureDetailLoaded(chatId: string): Promise<void> {
    await this.initialize();
    if (!this._details().has(chatId)) {
      await this.reloadDetailQuiet(chatId);
    }
  }

  async rename(chatId: string, name: string): Promise<void> {
    const response = await this.ipc.rename(chatId, name);
    if (response.success && response.data) {
      this.mergeDetail(response.data);
      this.mergeChat(response.data.chat);
    } else {
      this._error.set(response.error?.message ?? 'Failed to rename chat');
    }
  }

  async archive(chatId: string): Promise<void> {
    const response = await this.ipc.archive(chatId);
    if (response.success) {
      this._chats.update((chats) => chats.filter((chat) => chat.id !== chatId));
      this._details.update((details) => {
        const next = new Map(details);
        next.delete(chatId);
        return next;
      });
      if (this._selectedChatId() === chatId) {
        this._selectedChatId.set(null);
        void this.persistUiState(null);
      }
    } else {
      this._error.set(response.error?.message ?? 'Failed to archive chat');
    }
  }

  async setCwd(chatId: string, cwd: string): Promise<void> {
    const response = await this.ipc.setCwd(chatId, cwd);
    this.handleDetailResponse(response, 'Failed to set working directory');
  }

  async setProvider(chatId: string, provider: ChatRecord['provider']): Promise<void> {
    if (!provider) return;
    const response = await this.ipc.setProvider(chatId, provider);
    this.handleDetailResponse(response, 'Failed to set provider');
  }

  async setModel(chatId: string, model: string | null): Promise<void> {
    const response = await this.ipc.setModel(chatId, model);
    this.handleDetailResponse(response, 'Failed to set model');
  }

  async setReasoning(chatId: string, reasoningEffort: ReasoningEffort | null): Promise<void> {
    const response = await this.ipc.setReasoning(chatId, reasoningEffort);
    this.handleDetailResponse(response, 'Failed to set reasoning level');
  }

  async setYolo(chatId: string, yolo: boolean): Promise<void> {
    const response = await this.ipc.setYolo(chatId, yolo);
    this.handleDetailResponse(response, 'Failed to set autonomy');
  }

  async sendMessage(text: string, attachments?: FileAttachment[]): Promise<void> {
    const chatId = this._selectedChatId();
    const trimmed = text.trim();
    if (!chatId || !trimmed || this._sending()) {
      return;
    }
    this._sending.set(true);
    this._error.set(null);
    try {
      const result = await this.sendMessageTo(chatId, trimmed, attachments);
      if (!result.ok) {
        this._error.set(result.error);
      }
    } finally {
      this._sending.set(false);
    }
  }

  /**
   * Send a message to an explicit chat, independent of the global selection
   * and the global `sending` flag (so a busy side chat never disables the main
   * composer, and vice versa). Errors are returned, not written to `error`.
   */
  async sendMessageTo(
    chatId: string,
    text: string,
    attachments?: FileAttachment[],
  ): Promise<ChatOperationResult> {
    const trimmed = text.trim();
    if (!trimmed) {
      return { ok: false, error: 'Message is empty' };
    }
    try {
      const response = await this.ipc.sendMessage(chatId, trimmed, attachments);
      if (response.success && response.data) {
        this.mergeDetail(response.data);
        this.mergeChat(response.data.chat);
        return { ok: true };
      }
      return { ok: false, error: response.error?.message ?? 'Failed to send message' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Failed to send message' };
    }
  }

  async loadOlderMessages(limit = 200): Promise<ChatOlderMessagesLoadResult | null> {
    const chatId = this._selectedChatId();
    return chatId ? this.loadOlderMessagesFor(chatId, limit) : null;
  }

  async loadOlderMessagesFor(chatId: string, limit = 200): Promise<ChatOlderMessagesLoadResult | null> {
    const detail = this._details().get(chatId) ?? null;
    const oldestSequence = detail?.conversation.window?.oldestSequence;
    if (!detail || !detail.conversation.window?.hasOlder || oldestSequence == null) {
      return null;
    }

    const response = await this.ipc.loadOlderMessages(detail.chat.id, oldestSequence, limit);
    if (!response.success || !response.data) {
      this._error.set(response.error?.message ?? 'Failed to load older messages');
      return null;
    }
    const page = response.data;

    const existing = this._details().get(detail.chat.id);
    if (!existing) {
      return null;
    }

    const incoming = page.messages;
    const existingIds = new Set(existing.conversation.messages.map((message) => message.id));
    const prependedCount = incoming.filter((message) => !existingIds.has(message.id)).length;
    const messages = [...incoming, ...existing.conversation.messages]
      .filter((message, index, all) => all.findIndex((candidate) => candidate.id === message.id) === index)
      .sort((left, right) => left.sequence - right.sequence);

    this._details.update((details) => {
      const next = new Map(details);
      next.set(detail.chat.id, {
        ...existing,
        conversation: {
          ...existing.conversation,
          messages,
          window: {
            totalMessages: page.totalMessages,
            hasOlder: page.hasMore,
            oldestSequence: messages[0]?.sequence ?? null,
            newestSequence: messages[messages.length - 1]?.sequence ?? null,
          },
        },
      });
      return next;
    });

    return {
      prependedCount,
      hasMore: page.hasMore,
      totalStored: page.totalMessages,
    };
  }

  disposeForTesting(): void {
    this.unsubscribeChatEvents?.();
    this.unsubscribeChatEvents = null;
    this.initialized = false;
    this.initializationPromise = null;
    this.restoredUiState = false;
  }

  private async loadDetail(chatId: string): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    try {
      const response = await this.ipc.get(chatId);
      if (response.success && response.data) {
        this.mergeDetail(response.data);
      } else {
        this._error.set(response.error?.message ?? 'Failed to load chat');
      }
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : 'Failed to load chat');
    } finally {
      this._loading.set(false);
    }
  }

  private subscribeToChatEvents(): void {
    if (this.unsubscribeChatEvents) {
      return;
    }
    this.unsubscribeChatEvents = this.ipc.onChatEvent((event) => {
      void this.handleChatEvent(event);
    });
  }

  private async handleChatEvent(event: ChatEvent): Promise<void> {
    if (event.type === 'chat-created' || event.type === 'chat-updated' || event.type === 'runtime-linked' || event.type === 'runtime-cleared') {
      this.mergeChat(event.chat);
    }
    if (event.type === 'chat-archived') {
      this._chats.update((chats) => chats.filter((chat) => chat.id !== event.chatId));
      this._details.update((details) => {
        const next = new Map(details);
        next.delete(event.chatId);
        return next;
      });
      if (this._selectedChatId() === event.chatId) {
        this._selectedChatId.set(null);
        void this.persistUiState(null);
      }
    }
    if (event.type === 'transcript-appended') {
      this.applyTranscriptAppend(event);
      this.mergeChat(event.chat);
    }
    if (event.type !== 'transcript-appended') {
      if (this._selectedChatId() === event.chatId) {
        await this.loadDetail(event.chatId);
      } else if (this._details().has(event.chatId)) {
        // A cached-but-unselected chat (e.g. the side-chat panel's chat) still
        // needs its detail refreshed on runtime-linked/cleared and chat-updated
        // events, or its status pill / currentInstance binding goes stale.
        // Quiet refresh: don't flip the store-global loading/error signals for
        // a background chat.
        await this.reloadDetailQuiet(event.chatId);
      }
    }
  }

  /** Refresh a cached detail without touching the global loading/error state. */
  private async reloadDetailQuiet(chatId: string): Promise<void> {
    try {
      const response = await this.ipc.get(chatId);
      if (response.success && response.data) {
        this.mergeDetail(response.data);
      }
    } catch {
      // Keep the stale cached detail; the next event or send will retry.
    }
  }

  /**
   * Merge an incremental transcript delta into the cached detail for a chat.
   *
   * Crucially, prior message records keep their object identity, so the
   * chat-detail component's memoized message mapping and the output stream's
   * incremental `DisplayItemProcessor` are not invalidated — only the appended
   * message renders, instead of the whole transcript re-rendering per event.
   *
   * If we have no cached base (a background chat that was never opened), we
   * skip; the chat hydrates fully on select. For the currently-selected chat we
   * fall back to a full load so a delta that races ahead of the base still
   * shows.
   */
  private applyTranscriptAppend(event: Extract<ChatEvent, { type: 'transcript-appended' }>): void {
    const existing = this._details().get(event.chatId);
    if (!existing) {
      if (this._selectedChatId() === event.chatId) {
        void this.loadDetail(event.chatId);
      }
      return;
    }
    const messages = this.mergeAppendedMessages(existing.conversation.messages, event.messages);
    this.mergeDetail({
      chat: event.chat,
      conversation: { ...existing.conversation, messages },
      currentInstance: event.currentInstance,
    });
  }

  private mergeAppendedMessages(
    prior: ConversationMessageRecord[],
    incoming: ConversationMessageRecord[],
  ): ConversationMessageRecord[] {
    if (incoming.length === 0) {
      return prior;
    }
    const existingIds = new Set(prior.map((message) => message.id));
    const maxSequence = prior.length ? prior[prior.length - 1].sequence : 0;
    const isPureAppend = incoming.every(
      (message) => !existingIds.has(message.id) && message.sequence > maxSequence,
    );
    if (isPureAppend) {
      // Fast path (the common case): keep every prior record's identity intact.
      return [...prior, ...incoming];
    }
    // Robust path for re-delivery / out-of-order / content finalization:
    // upsert by id, then re-order by ledger sequence.
    const byId = new Map(prior.map((message) => [message.id, message]));
    for (const message of incoming) {
      byId.set(message.id, message);
    }
    return [...byId.values()].sort((a, b) => a.sequence - b.sequence);
  }

  private handleDetailResponse(response: { success: boolean; data?: ChatDetail; error?: { message: string } }, fallback: string): void {
    if (response.success && response.data) {
      this.mergeDetail(response.data);
      this.mergeChat(response.data.chat);
    } else {
      this._error.set(response.error?.message ?? fallback);
    }
  }

  private async restoreUiState(): Promise<void> {
    if (this.restoredUiState) {
      return;
    }
    this.restoredUiState = true;
    const response = await this.ipc.getUiState();
    if (!response.success || !response.data?.selectedChatId) {
      return;
    }
    const chatId = response.data.selectedChatId;
    if (!this._chats().some((chat) => chat.id === chatId)) {
      void this.persistUiState(null);
      return;
    }
    this._selectedChatId.set(chatId);
    await this.loadDetail(chatId);
  }

  private async persistUiState(selectedChatId: string | null): Promise<void> {
    const openChatIds = selectedChatId ? [selectedChatId] : [];
    const state: Pick<ChatUiState, 'selectedChatId' | 'openChatIds'> = {
      selectedChatId,
      openChatIds,
    };
    const response = await this.ipc.setUiState(state);
    if (!response.success) {
      this._error.set(response.error?.message ?? 'Failed to persist chat restore state');
    }
  }

  private mergeDetail(detail: ChatDetail): void {
    this._details.update((details) => {
      const next = new Map(details);
      const existing = next.get(detail.chat.id);
      next.set(detail.chat.id, existing ? this.mergeChatDetail(existing, detail) : detail);
      return next;
    });
  }

  private mergeChatDetail(existing: ChatDetail, incoming: ChatDetail): ChatDetail {
    const incomingWindow = incoming.conversation.window;
    const oldestIncomingSequence = incomingWindow?.oldestSequence ?? incoming.conversation.messages[0]?.sequence ?? null;
    if (oldestIncomingSequence === null) {
      return incoming;
    }

    const preservedOlder = existing.conversation.messages.filter(
      (message) => message.sequence < oldestIncomingSequence,
    );
    if (preservedOlder.length === 0) {
      return incoming;
    }

    const messages = [...preservedOlder, ...this.mergeAppendedMessages([], incoming.conversation.messages)];
    return {
      ...incoming,
      conversation: this.buildConversationWindow(
        incoming.conversation,
        messages,
        incomingWindow?.totalMessages ?? messages.length,
      ),
    };
  }

  private buildConversationWindow(
    conversation: ConversationLedgerConversation,
    messages: ConversationMessageRecord[],
    totalMessages: number,
  ): ConversationLedgerConversation {
    return {
      ...conversation,
      messages,
      window: {
        totalMessages,
        hasOlder: totalMessages > messages.length,
        oldestSequence: messages[0]?.sequence ?? null,
        newestSequence: messages[messages.length - 1]?.sequence ?? null,
      },
    };
  }

  private mergeChat(chat: ChatRecord): void {
    this._chats.update((chats) => {
      const index = chats.findIndex((item) => item.id === chat.id);
      const next = index === -1
        ? [chat, ...chats]
        : chats.map((item) => item.id === chat.id ? chat : item);
      return next
        .filter((item) => item.archivedAt === null)
        .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
    });
  }
}
