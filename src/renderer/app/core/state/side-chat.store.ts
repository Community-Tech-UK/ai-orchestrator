import { Injectable, computed, inject, signal } from '@angular/core';
import type {
  SideChatAttention,
  SideChatLink,
  SideChatParentRef,
  SideChatPermissionSummary,
  SideChatProviderSelection,
  SideChatSummary,
} from '../../../../shared/types/side-chat.types';
import { sideChatParentKey } from '../../../../shared/types/side-chat.types';
import type { ChatDetail, ChatEvent } from '../../../../shared/types/chat.types';
import { ChatIpcService } from '../services/ipc/chat-ipc.service';
import { ChatStore } from './chat.store';

/** Draft key for the not-yet-created conversation of a parent. */
const NEW_DRAFT_KEY = 'new';

export interface SideChatSessionState {
  /** Currently selected sidechat within this parent, or null for "new". */
  selectedChatId: string | null;
  /** Draft text per sidechat (and `new`). Survives panel destruction. */
  drafts: Record<string, string>;
  /** Pre-send provider selection for the next new sidechat. */
  pendingSelection: SideChatProviderSelection | null;
}

/** A refused send kept per parent so the panel can offer an explicit retry. */
export interface SideChatSendError {
  message: string;
  code: string | null;
  chatId: string | null;
  /** The question that was not sent; retried verbatim with the last snapshot. */
  text: string;
  lastSnapshotAvailable: boolean;
}

/** A request to show a parent's sidechats, raised by badges and attention lists. */
export interface SideChatOpenRequest {
  parent: SideChatParentRef;
  chatId: string | null;
  /** Monotonic, so repeating the same request still notifies. */
  id: number;
}

const EMPTY_STATE: SideChatSessionState = {
  selectedChatId: null,
  drafts: {},
  pendingSelection: null,
};

interface SideChatListResponse {
  active: SideChatSummary[];
}

type AttentionLoadState = 'idle' | 'loading' | 'loaded' | 'error';

/**
 * Session-scoped sidechat state. Lifetime is above the panel: drafts, selection,
 * provider choice and errors are keyed by parent identity, so two sessions in
 * the same directory never cross-wire and closing the panel loses nothing.
 * Transcripts live in {@link ChatStore}, which keeps loaded chat details live
 * through incremental events.
 */
@Injectable({ providedIn: 'root' })
export class SideChatStore {
  private readonly ipc = inject(ChatIpcService);
  private readonly chatStore = inject(ChatStore);

  private readonly _sessions = signal(new Map<string, SideChatSessionState>());
  private readonly _summaries = signal(new Map<string, SideChatSummary[]>());
  private readonly _attention = signal(new Map<string, SideChatAttention>());
  private readonly _permissions = signal(new Map<string, SideChatPermissionSummary>());
  private readonly _sendingParents = signal(new Set<string>());
  private readonly _errors = signal(new Map<string, SideChatSendError>());
  private readonly _attentionLoadState = signal<AttentionLoadState>('idle');
  private readonly _openRequest = signal<SideChatOpenRequest | null>(null);
  private readonly deletedChatIds = new Set<string>();
  private readonly listGeneration = new Map<string, number>();
  private unsubscribe: (() => void) | null = null;
  private attentionLoadGeneration = 0;
  private openRequestId = 0;

  readonly attention = this._attention.asReadonly();
  readonly attentionLoadState = this._attentionLoadState.asReadonly();
  readonly openRequest = this._openRequest.asReadonly();

  /** Aggregate unread + needs-action conversations across every parent. */
  readonly attentionBadgeCount = computed(() => {
    let count = 0;
    for (const entry of this._attention().values()) {
      count += entry.unread + entry.needsAttention;
    }
    return count;
  });

  /** Parents with pending sidechat activity, needing action first. */
  readonly attentionList = computed(() => [...this._attention().values()]
    .filter((entry) => entry.unread + entry.needsAttention + entry.running > 0)
    .sort((a, b) => b.needsAttention - a.needsAttention || b.unread - a.unread || b.running - a.running));

  /**
   * Subscribe to attention deltas and load attention for every parent, so
   * badges are correct without any panel mounted. Idempotent.
   */
  async initialize(): Promise<void> {
    if (this.unsubscribe) {
      return;
    }
    this.unsubscribe = this.ipc.onChatEvent((event) => this.onChatEvent(event));
    await this.loadAttentionSnapshot();
  }

  /** Retry the all-parent attention snapshot; only meaningful after a failed load. */
  async retryAttentionLoad(): Promise<void> {
    if (this._attentionLoadState() !== 'error') {
      return;
    }
    await this.loadAttentionSnapshot();
  }

  private async loadAttentionSnapshot(): Promise<void> {
    const generation = this.attentionLoadGeneration;
    const atRequest = this._attention();
    this._attentionLoadState.set('loading');
    try {
      const response = await this.ipc.sideChatAttentionAll();
      if (generation !== this.attentionLoadGeneration) {
        return;
      }
      if (!response.success || !Array.isArray(response.data)) {
        this._attentionLoadState.set('error');
        return;
      }

      // The snapshot is authoritative except for entries a live delta set after the request started.
      this._attention.update((current) => {
        const next = new Map<string, SideChatAttention>();
        for (const entry of response.data as SideChatAttention[]) {
          next.set(sideChatParentKey(entry.parent), entry);
        }
        for (const [key, entry] of current) {
          if (atRequest.get(key) !== entry) next.set(key, entry);
        }
        return next;
      });
      this._attentionLoadState.set('loaded');
    } catch {
      if (generation !== this.attentionLoadGeneration) {
        return;
      }
      this._attentionLoadState.set('error');
    }
  }

  disposeForTesting(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    // Invalidate a snapshot still in flight so it cannot land after teardown.
    this.attentionLoadGeneration += 1;
    this._attentionLoadState.set('idle');
  }

  sessionKey(parent: SideChatParentRef): string {
    return sideChatParentKey(parent);
  }

  stateFor(parent: SideChatParentRef): SideChatSessionState {
    return this._sessions().get(this.sessionKey(parent)) ?? EMPTY_STATE;
  }

  selectedChatId(parent: SideChatParentRef): string | null {
    return this.stateFor(parent).selectedChatId;
  }

  summariesFor(parent: SideChatParentRef): SideChatSummary[] {
    return this._summaries().get(this.sessionKey(parent)) ?? [];
  }

  attentionFor(parent: SideChatParentRef): SideChatAttention | null {
    return this._attention().get(this.sessionKey(parent)) ?? null;
  }

  permissionsFor(parent: SideChatParentRef): SideChatPermissionSummary | null {
    return this._permissions().get(this.sessionKey(parent)) ?? null;
  }

  linkFor(parent: SideChatParentRef, chatId: string): SideChatLink | null {
    return this.summariesFor(parent).find((summary) => summary.chat.id === chatId)?.link ?? null;
  }

  isSending(parent: SideChatParentRef): boolean {
    return this._sendingParents().has(this.sessionKey(parent));
  }

  errorFor(parent: SideChatParentRef): SideChatSendError | null {
    return this._errors().get(this.sessionKey(parent)) ?? null;
  }

  clearError(parent: SideChatParentRef): void {
    this.setError(parent, null);
  }

  draftFor(parent: SideChatParentRef, chatId: string | null): string {
    return this.stateFor(parent).drafts[chatId ?? NEW_DRAFT_KEY] ?? '';
  }

  setDraft(parent: SideChatParentRef, chatId: string | null, text: string): void {
    if (chatId && this.deletedChatIds.has(chatId)) return;
    this.patchSession(parent, (state) => ({
      ...state,
      drafts: { ...state.drafts, [chatId ?? NEW_DRAFT_KEY]: text },
    }));
  }

  pendingSelection(parent: SideChatParentRef): SideChatProviderSelection | null {
    return this.stateFor(parent).pendingSelection;
  }

  setPendingSelection(parent: SideChatParentRef, selection: SideChatProviderSelection | null): void {
    this.patchSession(parent, (state) => ({ ...state, pendingSelection: selection }));
  }

  selectChat(parent: SideChatParentRef, chatId: string | null): void {
    if (chatId && this.deletedChatIds.has(chatId)) return;
    this.patchSession(parent, (state) => ({ ...state, selectedChatId: chatId }));
    if (chatId) {
      void this.chatStore.ensureDetailLoaded(chatId);
    }
  }

  /** Ask the host to show a parent's sidechats (optionally one conversation). */
  requestOpen(parent: SideChatParentRef, chatId: string | null = null): void {
    this.openRequestId += 1;
    this._openRequest.set({ parent, chatId, id: this.openRequestId });
  }

  /** Resolve a runtime-addressed approval or question back to its owning panel. */
  requestOpenForRuntime(instanceId: string): boolean {
    const chat = this.chatStore.chats().find((record) => record.currentInstanceId === instanceId)
      ?? [...this.chatStore.details().values()].find((detail) => detail.chat.currentInstanceId === instanceId)?.chat;
    if (!chat?.sideChatParentKey) return false;
    const parent = this._attention().get(chat.sideChatParentKey)?.parent
      ?? this._summaries().get(chat.sideChatParentKey)?.find((summary) => summary.chat.id === chat.id)?.link.parent;
    if (!parent) return false;
    this.requestOpen(parent, chat.id);
    return true;
  }

  /**
   * Load a parent's sidechats when its panel opens. Selection follows the
   * spec's opening behaviour: a conversation needing action or holding an
   * unread answer wins, then the last selected one, then the newest.
   */
  async open(parent: SideChatParentRef, preferredChatId: string | null = null): Promise<void> {
    void this.loadPermissions(parent);
    const loaded = await this.refresh(parent);
    if (!loaded) {
      return;
    }
    const active = new Set(loaded.map((summary) => summary.chat.id));
    const attentionTarget = loaded.find((summary) =>
      summary.state === 'needs-attention' || summary.state === 'unread')?.chat.id ?? null;
    const current = this.selectedChatId(parent);
    const choice = (preferredChatId && active.has(preferredChatId) ? preferredChatId : null)
      ?? attentionTarget
      ?? (current && active.has(current) ? current : null)
      ?? loaded[loaded.length - 1]?.chat.id
      ?? null;
    this.selectChat(parent, choice);
  }

  /**
   * Reload a parent's list without changing selection. A response that
   * arrives after a newer request for the same parent is dropped, so a late
   * load can never overwrite fresher state.
   */
  async refresh(parent: SideChatParentRef): Promise<SideChatSummary[] | null> {
    const key = this.sessionKey(parent);
    const generation = (this.listGeneration.get(key) ?? 0) + 1;
    this.listGeneration.set(key, generation);
    try {
      const response = await this.ipc.sideChatList({ parent });
      if (this.listGeneration.get(key) !== generation || !response.success || !response.data) {
        return null;
      }
      const data = response.data as SideChatListResponse;
      const active = data.active.filter((summary) => !this.deletedChatIds.has(summary.chat.id));
      this._summaries.update((map) => new Map(map).set(key, active));
      return active;
    } catch {
      return null;
    }
  }

  async loadPermissions(parent: SideChatParentRef): Promise<SideChatPermissionSummary | null> {
    try {
      const response = await this.ipc.sideChatPermissions({ parent });
      if (!response.success || !response.data) {
        return null;
      }
      const summary = response.data as SideChatPermissionSummary;
      this._permissions.update((map) => new Map(map).set(this.sessionKey(parent), summary));
      return summary;
    } catch {
      return null;
    }
  }

  /**
   * Send a question. With no selected conversation, a new sidechat is created
   * first using the pending provider selection. A refused send keeps the draft
   * and records whether the last captured parent snapshot can be used.
   */
  async send(
    parent: SideChatParentRef,
    chatId: string | null,
    text: string,
    currentCwd: string,
    options: { allowStaleContext?: boolean; fallbackSelection?: SideChatProviderSelection } = {},
  ): Promise<boolean> {
    const trimmed = text.trim();
    const key = this.sessionKey(parent);
    if (!trimmed || this._sendingParents().has(key) || (chatId && this.deletedChatIds.has(chatId))) return false;
    this.setSending(key, true);
    this.setError(parent, null);
    let targetChatId = chatId;
    try {
      if (!targetChatId) {
        const selection = this.pendingSelection(parent) ?? options.fallbackSelection ?? null;
        if (!selection) {
          this.setError(parent, { message: 'Choose a provider for this sidechat first', code: null, chatId: null, text: trimmed, lastSnapshotAvailable: false });
          return false;
        }
        targetChatId = await this.create(parent, selection, currentCwd, trimmed);
        if (!targetChatId) return false;
        this.setDraft(parent, null, '');
      }
      const response = await this.ipc.sideChatSend({
        chatId: targetChatId,
        text: trimmed,
        ...(options.allowStaleContext ? { allowStaleContext: true } : {}),
      });
      if (this.deletedChatIds.has(targetChatId)) return false;
      if (response.success) {
        this.setDraft(parent, targetChatId, '');
        return true;
      }
      const failure = (response.data ?? null) as { code?: string; lastSnapshotAvailable?: boolean } | null;
      this.setError(parent, {
        message: response.error?.message ?? 'Failed to send message',
        code: failure?.code ?? null,
        chatId: targetChatId,
        text: trimmed,
        lastSnapshotAvailable: failure?.lastSnapshotAvailable === true,
      });
      // Keep the unsent question in the composer of the conversation it was for.
      this.setDraft(parent, targetChatId, trimmed);
      return false;
    } catch (error) {
      this.setError(parent, {
        message: error instanceof Error ? error.message : 'Failed to send message',
        code: null, chatId: targetChatId, text: trimmed, lastSnapshotAvailable: false,
      });
      return false;
    } finally {
      this.setSending(key, false);
    }
  }

  /** Change a sidechat's provider/model/reasoning; history and ownership are kept. */
  async setSelection(parent: SideChatParentRef, chatId: string, selection: SideChatProviderSelection): Promise<boolean> {
    if (this.deletedChatIds.has(chatId)) return false;
    try {
      const response = await this.ipc.sideChatSetSelection({ chatId, selection });
      if (this.deletedChatIds.has(chatId)) return false;
      if (response.success) {
        void this.refresh(parent);
        return true;
      }
      this.setError(parent, { message: response.error?.message ?? 'Failed to change provider', code: null, chatId, text: '', lastSnapshotAvailable: false });
      return false;
    } catch (error) {
      this.setError(parent, { message: error instanceof Error ? error.message : 'Failed to change provider', code: null, chatId, text: '', lastSnapshotAvailable: false });
      return false;
    }
  }

  /**
   * Acknowledge one sidechat through a specific assistant sequence. Never
   * "clear all": an answer that arrives concurrently stays unread.
   */
  async markRead(parent: SideChatParentRef, chatId: string, throughSequence: number): Promise<void> {
    const link = this.linkFor(parent, chatId);
    if (link && throughSequence <= link.lastReadAssistantSequence) {
      return;
    }
    try {
      const response = await this.ipc.sideChatMarkRead({ chatId, throughSequence });
      if (!response.success || !response.data) {
        return;
      }
      const updated = response.data as SideChatLink;
      const key = this.sessionKey(parent);
      this._summaries.update((map) => {
        const list = map.get(key);
        if (!list) return map;
        return new Map(map).set(key, list.map((summary) => summary.chat.id === chatId
          ? {
              ...summary,
              link: updated,
              state: summary.state === 'unread' && updated.lastReadAssistantSequence >= summary.latestAssistantSequence
                ? 'idle'
                : summary.state,
            }
          : summary));
      });
    } catch {
      // Read marks are retried on the next visible view.
    }
  }

  /** Stop and permanently delete the confirmed sidechat, including its local draft. */
  async discard(parent: SideChatParentRef, chatId: string): Promise<boolean> {
    try {
      const response = await this.ipc.sideChatDiscard({ chatId, confirmation: 'discard' });
      if (!response.success) {
        this.setError(parent, { message: response.error?.message ?? 'Could not discard sidechat', code: null, chatId, text: '', lastSnapshotAvailable: false });
        return false;
      }
      this.forgetChat(chatId);
      await this.refresh(parent);
      return true;
    } catch (error) {
      this.setError(parent, { message: error instanceof Error ? error.message : 'Could not discard sidechat', code: null, chatId, text: '', lastSnapshotAvailable: false });
      return false;
    }
  }

  private async create(
    parent: SideChatParentRef,
    selection: SideChatProviderSelection,
    currentCwd: string,
    firstQuestion: string,
  ): Promise<string | null> {
    const response = await this.ipc.sideChatCreate({
      parent,
      name: firstQuestion.slice(0, 80),
      selection,
      currentCwd,
    });
    if (response.success && response.data) {
      const chatId = (response.data as ChatDetail).chat.id;
      if (this.deletedChatIds.has(chatId)) return null;
      this.selectChat(parent, chatId);
      void this.refresh(parent);
      return chatId;
    }
    this.setError(parent, {
      message: response.error?.message ?? 'Failed to create sidechat',
      code: null, chatId: null, text: firstQuestion, lastSnapshotAvailable: false,
    });
    return null;
  }

  private onChatEvent(event: ChatEvent): void {
    if (event.type === 'chat-deleted') {
      this.forgetChat(event.chatId);
      return;
    }
    if (event.type !== 'side-chat-attention') {
      return;
    }
    const key = this.sessionKey(event.attention.parent);
    this._attention.update((map) => new Map(map).set(key, event.attention));
    // A list that a panel has loaded is kept current; others load on open.
    if (this._summaries().has(key)) {
      void this.refresh(event.attention.parent);
    }
  }

  private forgetChat(chatId: string): void {
    this.deletedChatIds.add(chatId);
    this._sessions.update((map) => new Map<string, SideChatSessionState>([...map].map(([key, state]) => {
      const drafts = { ...state.drafts };
      delete drafts[chatId];
      return [key, { ...state, drafts, selectedChatId: state.selectedChatId === chatId ? null : state.selectedChatId }];
    })));
    this._summaries.update((map) => new Map<string, SideChatSummary[]>([...map].map(([key, summaries]) => {
      if (!summaries.some((summary) => summary.chat.id === chatId)) return [key, summaries];
      return [key, summaries.filter((summary) => summary.chat.id !== chatId)];
    })));
    this._errors.update((map) => new Map<string, SideChatSendError>([...map].filter(([, error]) => error.chatId !== chatId)));
  }

  private patchSession(
    parent: SideChatParentRef,
    patch: (state: SideChatSessionState) => SideChatSessionState,
  ): void {
    const key = this.sessionKey(parent);
    this._sessions.update((map) => new Map(map).set(key, patch(map.get(key) ?? EMPTY_STATE)));
  }

  private setSending(key: string, sending: boolean): void {
    this._sendingParents.update((set) => {
      const next = new Set(set);
      if (sending) next.add(key);
      else next.delete(key);
      return next;
    });
  }

  private setError(parent: SideChatParentRef, error: SideChatSendError | null): void {
    if (error?.chatId && this.deletedChatIds.has(error.chatId)) return;
    const key = this.sessionKey(parent);
    this._errors.update((map) => {
      const next = new Map(map);
      if (error) next.set(key, error);
      else next.delete(key);
      return next;
    });
  }
}
