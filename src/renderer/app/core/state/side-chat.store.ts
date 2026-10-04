import { Injectable, inject, signal } from '@angular/core';
import type {
  SideChatAttention,
  SideChatLink,
  SideChatParentRef,
  SideChatProviderSelection,
} from '../../../../shared/types/side-chat.types';
import type { ChatDetail } from '../../../../shared/types/chat.types';
import { ChatIpcService } from '../services/ipc/chat-ipc.service';

export interface SideChatSessionState {
  /** Currently selected sidechat within this parent, or null. */
  selectedChatId: string | null;
  /** Draft text per sidechat, keyed by chat id. Survives panel destruction. */
  drafts: Record<string, string>;
  /** Pre-send provider selection for a not-yet-created sidechat. */
  pendingSelection: SideChatProviderSelection | null;
}

const EMPTY_STATE: SideChatSessionState = {
  selectedChatId: null,
  drafts: {},
  pendingSelection: null,
};

/**
 * Session-scoped sidechat state. Lifetime is above the panel: drafts, selection
 * and pending provider choice survive panel close/reopen and are keyed by
 * parent identity so two sessions in the same directory never cross-wire.
 */
@Injectable({ providedIn: 'root' })
export class SideChatStore {
  private readonly ipc = inject(ChatIpcService);

  private readonly _sessions = signal(new Map<string, SideChatSessionState>());
  private readonly _links = signal(new Map<string, SideChatLink>());
  private readonly _attention = signal(new Map<string, SideChatAttention>());
  private readonly _details = signal(new Map<string, ChatDetail>());
  private readonly _sending = signal(false);
  private readonly _error = signal<string | null>(null);
  private requestGeneration = 0;

  readonly sessions = this._sessions.asReadonly();
  readonly links = this._links.asReadonly();
  readonly attention = this._attention.asReadonly();
  readonly sending = this._sending.asReadonly();
  readonly error = this._error.asReadonly();

  sessionKey(parent: SideChatParentRef): string {
    return parent.kind === 'chat'
      ? `chat:${parent.chatId}`
      : `session:${parent.historyThreadId}`;
  }

  stateFor(parent: SideChatParentRef): SideChatSessionState {
    return this._sessions().get(this.sessionKey(parent)) ?? EMPTY_STATE;
  }

  selectedChatId(parent: SideChatParentRef): string | null {
    return this.stateFor(parent).selectedChatId;
  }

  draftFor(parent: SideChatParentRef, chatId: string | null): string {
    if (!chatId) return this.stateFor(parent).drafts['new'] ?? '';
    return this.stateFor(parent).drafts[chatId] ?? '';
  }

  setDraft(parent: SideChatParentRef, chatId: string | null, text: string): void {
    const state = this.stateFor(parent);
    const drafts = { ...state.drafts, [chatId ?? 'new']: text };
    this._sessions.update((map) => {
      const next = new Map(map);
      next.set(this.sessionKey(parent), { ...state, drafts });
      return next;
    });
  }

  setPendingSelection(parent: SideChatParentRef, selection: SideChatProviderSelection | null): void {
    const state = this.stateFor(parent);
    this._sessions.update((map) => {
      const next = new Map(map);
      next.set(this.sessionKey(parent), { ...state, pendingSelection: selection });
      return next;
    });
  }

  selectChat(parent: SideChatParentRef, chatId: string | null): void {
    const state = this.stateFor(parent);
    this._sessions.update((map) => {
      const next = new Map(map);
      next.set(this.sessionKey(parent), { ...state, selectedChatId: chatId });
      return next;
    });
    if (chatId) {
      void this.loadDetail(chatId);
    }
  }

  /**
   * Load sidechats for a parent. In-flight loads are invalidated when the
   * caller switches parent: a late response can never overwrite the new
   * session's list or draft.
   */
  async loadForParent(parent: SideChatParentRef): Promise<SideChatLink[]> {
    const generation = ++this.requestGeneration;
    try {
      const response = await this.ipc.sideChatList({ parent });
      if (generation !== this.requestGeneration) {
        return []; // stale: a newer parent selection owns the UI now
      }
      if (response.success && Array.isArray(response.data)) {
        const links = response.data as SideChatLink[];
        this._links.update((map) => {
          const next = new Map(map);
          for (const link of links) {
            next.set(link.chatId, link);
          }
          return next;
        });
        // Auto-select the last conversation if nothing is selected yet.
        const state = this.stateFor(parent);
        if (!state.selectedChatId && links.length > 0) {
          this.selectChat(parent, links[links.length - 1]!.chatId);
        }
        return links;
      }
      return [];
    } catch {
      return [];
    }
  }

  async loadAttention(parent: SideChatParentRef): Promise<SideChatAttention | null> {
    try {
      const response = await this.ipc.sideChatAttention({ parent });
      if (response.success && response.data) {
        const attention = response.data as SideChatAttention;
        this._attention.update((map) => {
          const next = new Map(map);
          next.set(this.sessionKey(parent), attention);
          return next;
        });
        return attention;
      }
      return null;
    } catch {
      return null;
    }
  }

  async createSideChat(
    parent: SideChatParentRef,
    selection: SideChatProviderSelection,
    currentCwd: string,
    name?: string,
  ): Promise<string | null> {
    this._sending.set(true);
    this._error.set(null);
    try {
      const response = await this.ipc.sideChatCreate({
        parent,
        name,
        selection,
        currentCwd,
      });
      if (response.success && response.data) {
        const detail = response.data as ChatDetail;
        const chatId = detail.chat.id;
        this._details.update((map) => {
          const next = new Map(map);
          next.set(chatId, detail);
          return next;
        });
        this._links.update((map) => {
          const next = new Map(map);
          next.set(chatId, {
            chatId,
            parent,
            authority: 'inherit-parent',
            lastReadAssistantSequence: 0,
          });
          return next;
        });
        this.selectChat(parent, chatId);
        return chatId;
      }
      this._error.set(response.error?.message ?? 'Failed to create sidechat');
      return null;
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : 'Failed to create sidechat');
      return null;
    } finally {
      this._sending.set(false);
    }
  }

  async send(
    parent: SideChatParentRef,
    chatId: string | null,
    text: string,
    currentCwd: string,
  ): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed || this._sending()) return false;
    this._sending.set(true);
    this._error.set(null);
    try {
      let targetChatId = chatId;
      if (!targetChatId) {
        const selection = this.stateFor(parent).pendingSelection
          ?? { provider: 'claude' as const, model: null, reasoning: null };
        targetChatId = await this.createSideChat(parent, selection, currentCwd);
        if (!targetChatId) return false;
      }
      const response = await this.ipc.sideChatSend({ chatId: targetChatId, text: trimmed });
      if (response.success) {
        this.setDraft(parent, targetChatId, '');
        return true;
      }
      this._error.set(response.error?.message ?? 'Failed to send message');
      return false;
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : 'Failed to send message');
      return false;
    } finally {
      this._sending.set(false);
    }
  }

  async markRead(chatId: string, throughSequence: number): Promise<void> {
    try {
      const response = await this.ipc.sideChatMarkRead({ chatId, throughSequence });
      if (!response.success) {
        // Rejected (e.g. sequence beyond latest output) — reload the link so
        // the UI doesn't show a false-read state.
        return;
      }
      this._links.update((map) => {
        const next = new Map(map);
        const link = next.get(chatId);
        if (link && throughSequence > link.lastReadAssistantSequence) {
          next.set(chatId, { ...link, lastReadAssistantSequence: throughSequence });
        }
        return next;
      });
    } catch {
      // Best-effort: read marks are advisory and retried on next visibility.
    }
  }

  detailFor(chatId: string): ChatDetail | null {
    return this._details().get(chatId) ?? null;
  }

  /** Remove a sidechat from the active list (Archive). History is retained. */
  removeSideChat(chatId: string): void {
    this._links.update((map) => {
      const next = new Map(map);
      next.delete(chatId);
      return next;
    });
    this._details.update((map) => {
      const next = new Map(map);
      next.delete(chatId);
      return next;
    });
  }

  private async loadDetail(chatId: string): Promise<void> {
    try {
      const response = await this.ipc.get(chatId);
      if (response.success && response.data) {
        this._details.update((map) => {
          const next = new Map(map);
          next.set(chatId, response.data as ChatDetail);
          return next;
        });
      }
    } catch {
      // Stale detail is acceptable; the next event retries.
    }
  }

  /**
   * Explicitly attach an existing unlinked chat to a parent. Recorded as a
   * follow-up feature: the IPC channel for relinking an existing chat is not
   * yet implemented. Existing unlinked chats remain ordinary chats.
   */
  async attachToParent(_chatId: string, _parent: SideChatParentRef): Promise<boolean> {
    this._error.set('Attach to session requires the relink IPC channel (follow-up).');
    return false;
  }
}
