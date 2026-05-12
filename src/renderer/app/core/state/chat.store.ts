import { Injectable, computed, inject, signal } from '@angular/core';
import type { ChatCreateInput, ChatDetail, ChatEvent, ChatRecord } from '../../../../shared/types/chat.types';
import type { FileAttachment } from '../../../../shared/types/instance.types';
import type { ReasoningEffort } from '../../../../shared/types/provider.types';
import { ChatIpcService } from '../services/ipc/chat-ipc.service';

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

  readonly chats = this._chats.asReadonly();
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
    this.initializationPromise = this.loadChats().then(() => {
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
    await this.loadDetail(chatId);
  }

  deselect(): void {
    this._selectedChatId.set(null);
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
      const response = await this.ipc.sendMessage(chatId, trimmed, attachments);
      if (response.success && response.data) {
        this.mergeDetail(response.data);
        this.mergeChat(response.data.chat);
      } else {
        this._error.set(response.error?.message ?? 'Failed to send message');
      }
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : 'Failed to send message');
    } finally {
      this._sending.set(false);
    }
  }

  disposeForTesting(): void {
    this.unsubscribeChatEvents?.();
    this.unsubscribeChatEvents = null;
    this.initialized = false;
    this.initializationPromise = null;
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
      }
    }
    if (event.type === 'transcript-updated') {
      this.mergeDetail(event.detail);
      this.mergeChat(event.detail.chat);
    }
    if (this._selectedChatId() === event.chatId && event.type !== 'transcript-updated') {
      await this.loadDetail(event.chatId);
    }
  }

  private handleDetailResponse(response: { success: boolean; data?: ChatDetail; error?: { message: string } }, fallback: string): void {
    if (response.success && response.data) {
      this.mergeDetail(response.data);
      this.mergeChat(response.data.chat);
    } else {
      this._error.set(response.error?.message ?? fallback);
    }
  }

  private mergeDetail(detail: ChatDetail): void {
    this._details.update((details) => {
      const next = new Map(details);
      next.set(detail.chat.id, detail);
      return next;
    });
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
