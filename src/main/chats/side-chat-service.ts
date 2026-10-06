import type { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type {
  ChatDetail,
  ChatEvent,
  ChatProvider,
  ChatRecord,
  ChatSendMessageInput,
  ChatSideChatCreateInput,
} from '../../shared/types/chat.types';
import type { AgentToolPermissions } from '../../shared/types/agent.types';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import { getDefaultReasoningEffort } from '../../shared/types/provider.types';
import { getProviderModelContextWindow } from '../../shared/types/provider-context-window';
import type {
  SideChatAttention,
  SideChatAuthorityPolicy,
  SideChatLink,
  SideChatParentRef,
  SideChatPermissionSummary,
  SideChatProviderSelection,
  SideChatSummary,
} from '../../shared/types/side-chat.types';
import { sideChatParentKey } from '../../shared/types/side-chat.types';
import { getConversationHistoryTitle } from '../../shared/types/history.types';
import { estimateTokens } from '../../shared/utils/token-estimate';
import type { ConversationLedgerService } from '../conversation-ledger';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { InstanceManager } from '../instance/instance-manager';
import { getLogger } from '../logging/logger';
import { addAllowedRoot } from '../security/path-validator';
import type { ChatStore } from './chat-store';
import { normalizeChatName } from './chat-service-helpers';
import { SideChatAttentionTracker } from './side-chat-attention';
import {
  SideChatAuthorityResolver,
  describeProviderCapabilities,
  policyFingerprint,
  policyToRuntimeConfig,
  providerCanEnforcePolicy,
} from './side-chat-authority';
import { SideChatContextStore } from './side-chat-context-store';
import type { BuildParentContextOptions } from './side-chat-context';
import { SideChatLinkStore } from './side-chat-link-store';
import {
  SideChatParentResolver,
  type SideChatArchiveLookup,
} from './side-chat-parent-resolver';
import { SideChatPolicyStore } from './side-chat-policy-store';
import {
  SIDE_CHAT_BUSY_STATUSES,
  SideChatError,
  assertProviderEnforceable,
  assertSelectionUsable,
  normalizeSelection,
} from './side-chat-selection';
import {
  SideChatSendCoordinator,
  type SideChatSendFailure,
  type SideChatSendResult,
} from './side-chat-send-coordinator';

const logger = getLogger('SideChatService');

/** Coalescing window for attention deltas, so a streaming answer emits a bounded number. */
const ATTENTION_FLUSH_MS = 50;
/** Recent sidechat turns counted against the parent-context budget on rebuild. */
const HISTORY_ESTIMATE_MESSAGES = 40;

export { SideChatError };

/** The ChatService operations a sidechat needs; keeps the two services decoupled. */
export interface SideChatChatPort {
  /**
   * The ordinary chat send path (ledger append, runtime, continuity). An
   * existing `userTurnId` is updated in place, so a retry adds no second turn.
   */
  dispatchMessage(input: ChatSendMessageInput, options: { userTurnId: string }): Promise<unknown>;
  detail(chat: ChatRecord): Promise<ChatDetail>;
  /** Terminate the chat's runtime, clear its link and emit `runtime-cleared`. */
  clearRuntime(chat: ChatRecord, reason: 'provider' | 'policy'): Promise<ChatRecord>;
  emit(event: ChatEvent): void;
}

export interface SideChatServiceDeps {
  db: SqliteDriver;
  ledger: ConversationLedgerService;
  instanceManager: InstanceManager;
  chatStore: ChatStore;
  events: EventEmitter;
  chat: SideChatChatPort;
  resolveAgentPermissions: (workingDirectory: string, agentId: string | null) => Promise<AgentToolPermissions>;
  archive?: SideChatArchiveLookup;
}

/**
 * Session-linked sidechats: ownership, inherited authority, refreshed parent
 * context and persistent attention, layered over ordinary durable chats.
 *
 * A sidechat is a normal `chats` row with its own ledger thread and runtime,
 * plus a `side_chat_links` relation to its parent. Every question captures the
 * parent's current context, and every runtime spawns under the parent's
 * effective permission policy, re-resolved before each dispatch.
 */
export class SideChatService {
  private readonly linkStore: SideChatLinkStore;
  private readonly contextStore: SideChatContextStore;
  private readonly policyStore: SideChatPolicyStore;
  private readonly resolver: SideChatParentResolver;
  private readonly authority: SideChatAuthorityResolver;
  private readonly coordinator: SideChatSendCoordinator;
  private readonly attentionTracker: SideChatAttentionTracker;
  /** Policy fingerprint each live sidechat runtime was spawned under. */
  private readonly runtimeFingerprint = new Map<string, string>();
  /** Live sidechat runtime instance → owning chat. */
  private readonly runtimeChat = new Map<string, string>();
  private readonly pendingAttention = new Map<string, SideChatParentRef>();
  private attentionTimer: ReturnType<typeof setTimeout> | null = null;
  private attentionFlush: Promise<void> = Promise.resolve();

  constructor(private readonly deps: SideChatServiceDeps) {
    this.linkStore = new SideChatLinkStore(deps.db);
    this.contextStore = new SideChatContextStore(deps.db);
    this.policyStore = new SideChatPolicyStore(deps.db);
    this.resolver = new SideChatParentResolver({
      ledger: deps.ledger,
      chatStore: deps.chatStore,
      instanceManager: deps.instanceManager,
      archive: deps.archive,
    });
    this.authority = new SideChatAuthorityResolver({
      chatStore: deps.chatStore,
      instanceManager: deps.instanceManager,
      linkStore: this.linkStore,
      resolveAgentPermissions: deps.resolveAgentPermissions,
      loadPersistedPolicy: (parent) => this.policyStore.get(parent),
      persistPolicy: (parent, policy) => this.policyStore.put(parent, policy),
    });
    this.coordinator = new SideChatSendCoordinator({
      resolver: this.resolver,
      contextStore: this.contextStore,
      linkStore: this.linkStore,
      preflight: (chatId, link) => this.preflight(chatId, link),
      dispatchSend: async (input, userTurnId) => {
        await this.deps.chat.dispatchMessage(input, { userTurnId });
      },
      buildOptions: (chatId) => this.buildContextOptions(chatId),
    });
    this.attentionTracker = new SideChatAttentionTracker({
      linkStore: this.linkStore,
      chatStore: deps.chatStore,
      instanceManager: deps.instanceManager,
      getLatestAssistantSequence: (link) => this.latestAssistantSequence(link),
      resolveParentTitle: async (parent) => (await this.resolver.resolveIdentity(parent))?.title ?? null,
    });
    deps.events.on('chat:event', (event: ChatEvent) => this.onChatEvent(event));
    if (typeof deps.instanceManager.on === 'function') {
      deps.instanceManager.on('instance:state-changed', (event: { instanceId: string }) => {
        const chatId = this.runtimeChat.get(event.instanceId)
          ?? deps.chatStore.getByInstanceId(event.instanceId)?.id;
        const link = chatId ? this.linkStore.get(chatId) : null;
        if (link) this.scheduleAttention(link.parent);
      });
      deps.instanceManager.on('instance:removed', (instanceId: string) => {
        this.onRuntimeCleared(instanceId);
      });
    }
  }

  dispose(): void {
    if (this.attentionTimer) {
      clearTimeout(this.attentionTimer);
      this.attentionTimer = null;
    }
    this.pendingAttention.clear();
  }

  isSideChat(chatId: string): boolean {
    return this.linkStore.get(chatId) !== null;
  }

  getLink(chatId: string): SideChatLink | null {
    return this.linkStore.get(chatId);
  }

  // ── Creation and ownership ────────────────────────────────────────────────

  /**
   * Create a sidechat linked to a parent. Authority and provider capability are
   * checked first; the backing chat row and ownership relation are persisted
   * atomically. No runtime is spawned until the first question.
   */
  async create(input: ChatSideChatCreateInput): Promise<ChatDetail> {
    const authority = await this.requireAuthority(input.parent);
    const identity = await this.resolver.resolveIdentity(input.parent);
    assertSelectionUsable(input.selection, authority.policy);
    // The parent's own workspace wins over the renderer-supplied directory: a
    // sidechat runs where its parent runs, and a worker path is never treated
    // as a coordinator-local path.
    const currentCwd = identity?.workspacePath || input.currentCwd;
    const id = randomUUID();
    const name = normalizeChatName(input.name);
    const thread = await this.deps.ledger.startConversation({
      provider: 'orchestrator',
      workspacePath: currentCwd,
      title: name,
      metadata: { chatId: id, scope: 'side-chat', operatorThreadKind: 'side-chat' },
    });
    const selection = normalizeSelection(input.selection);
    const inserted = this.linkStore.insertWithBacker(
      { chatId: id, parent: input.parent, authority: 'inherit-parent', lastReadAssistantSequence: 0 },
      () => this.deps.chatStore.insert({
        id,
        name,
        provider: selection.provider,
        model: selection.model,
        reasoningEffort: selection.reasoning === undefined
          ? getDefaultReasoningEffort(selection.provider, selection.model)
          : selection.reasoning,
        modelRuntimeTarget: selection.modelRuntimeTarget,
        currentCwd,
        yolo: false,
        ledgerThreadId: thread.id,
      }),
    );
    // Re-read so the record carries its new ownership key.
    const chat = this.deps.chatStore.get(inserted.id) ?? inserted;
    if (!authority.policy.workspaceNode) {
      addAllowedRoot(currentCwd);
    }
    this.deps.chat.emit({ type: 'chat-created', chatId: chat.id, chat });
    this.scheduleAttention(input.parent);
    return this.deps.chat.detail(chat);
  }

  /**
   * Explicitly attach an existing unlinked chat to a parent. Ownership is never
   * guessed; this is the only way a pre-existing chat becomes a sidechat. Its
   * runtime is replaced so the next turn runs under the inherited policy.
   */
  async attach(chatId: string, parent: SideChatParentRef): Promise<ChatDetail> {
    const chat = this.requireChat(chatId);
    if (chat.archivedAt !== null) {
      throw new SideChatError('archived', 'Unarchive this chat before attaching it to a session');
    }
    if (this.linkStore.get(chatId)) {
      throw new SideChatError('already-linked', 'This chat is already a sidechat of another session');
    }
    if (this.isAncestorOrSelf(chatId, parent)) {
      throw new SideChatError('cycle', 'A chat cannot be attached to itself or to one of its own sidechats');
    }
    const authority = await this.requireAuthority(parent);
    if (chat.provider) {
      assertProviderEnforceable(chat.provider, authority.policy);
    }
    if (authority.policy.workspaceNode) {
      const identity = await this.resolver.resolveIdentity(parent);
      if (identity?.workspacePath !== chat.currentCwd) {
        throw new SideChatError(
          'workspace-mismatch',
          'This session runs on a worker machine with a different project, so this chat cannot follow it there',
        );
      }
    }
    // Existing answers were already visible as an ordinary chat; attaching must
    // not suddenly flag them unread.
    const latest = await this.latestAssistantSequenceForChat(chat);
    this.linkStore.insert({ chatId, parent, authority: 'inherit-parent', lastReadAssistantSequence: latest });
    this.linkStore.recordAssistantSequence(chatId, latest);
    const linked = this.requireChat(chatId);
    const updated = linked.currentInstanceId
      ? await this.deps.chat.clearRuntime(linked, 'policy')
      : linked;
    this.deps.chat.emit({ type: 'chat-updated', chatId, chat: updated });
    this.scheduleAttention(parent);
    return this.deps.chat.detail(updated);
  }

  async list(parent: SideChatParentRef): Promise<SideChatSummary[]> {
    return this.attentionTracker.summariesForParent(parent);
  }

  /** Archived sidechats of a parent: absent from active counts, reopenable from history. */
  listArchived(parent: SideChatParentRef): ChatRecord[] {
    return this.linkStore.listForParent(parent)
      .map((link) => this.deps.chatStore.get(link.chatId))
      .filter((chat): chat is ChatRecord => chat !== null && chat.archivedAt !== null);
  }

  async attention(parent: SideChatParentRef): Promise<SideChatAttention> {
    return this.attentionTracker.forParent(parent);
  }

  async attentionForAll(): Promise<SideChatAttention[]> {
    return this.attentionTracker.forAllParents();
  }

  /** Inherited permission posture plus which providers can enforce it. */
  async permissions(parent: SideChatParentRef): Promise<SideChatPermissionSummary> {
    const resolution = await this.authority.resolve(parent);
    if (!resolution.ok) {
      return {
        ok: false,
        code: resolution.code,
        error: resolution.error,
        providers: describeProviderCapabilities(null, resolution.error),
      };
    }
    return {
      ok: true,
      source: resolution.source,
      policy: resolution.policy,
      providers: describeProviderCapabilities(resolution.policy, null),
    };
  }

  // ── Read state ────────────────────────────────────────────────────────────

  /**
   * Advance one sidechat's read mark through a specific assistant sequence.
   * Rejects non-sidechats and sequences beyond the latest assistant output, so
   * an acknowledgement can never cover an answer that has not arrived.
   */
  async markRead(chatId: string, throughSequence: number): Promise<SideChatLink> {
    const link = this.linkStore.get(chatId);
    if (!link) {
      throw new SideChatError('not-linked', `Chat ${chatId} is not a sidechat`);
    }
    const latest = await this.latestAssistantSequence(link, { refresh: true });
    if (throughSequence > latest) {
      throw new SideChatError(
        'sequence-out-of-range',
        `Read sequence ${throughSequence} exceeds latest assistant output ${latest}`,
      );
    }
    const updated = this.linkStore.markRead(chatId, throughSequence) ?? link;
    this.scheduleAttention(link.parent);
    return updated;
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  async send(
    input: ChatSendMessageInput,
    options: { allowStaleContext?: boolean } = {},
  ): Promise<SideChatSendResult> {
    return this.coordinator.send(input, options);
  }

  /** Send for callers that expect the ordinary chat contract (throws on refusal). */
  async sendOrThrow(input: ChatSendMessageInput): Promise<void> {
    const result = await this.coordinator.send(input);
    if (!result.ok) {
      throw new SideChatError(result.code, result.error);
    }
  }

  /**
   * Change provider, model, reasoning and local runtime target together. Keeps
   * history and ownership; the next question rebuilds context on the new
   * runtime. Refused while a turn is running and for providers that cannot
   * enforce the parent's policy.
   */
  async setSelection(chatId: string, selection: SideChatProviderSelection): Promise<ChatDetail> {
    const chat = this.requireChat(chatId);
    const link = this.linkStore.get(chatId);
    if (!link) {
      throw new SideChatError('not-linked', `Chat ${chatId} is not a sidechat`);
    }
    this.assertNoActiveTurn(chat);
    const authority = await this.requireAuthority(link.parent);
    assertSelectionUsable(selection, authority.policy);
    const normalized = normalizeSelection(selection);
    const cleared = chat.currentInstanceId
      ? await this.deps.chat.clearRuntime(chat, 'provider')
      : chat;
    const updated = this.deps.chatStore.update(cleared.id, {
      provider: normalized.provider,
      model: normalized.model,
      reasoningEffort: normalized.reasoning === undefined
        ? getDefaultReasoningEffort(normalized.provider, normalized.model)
        : normalized.reasoning,
      modelRuntimeTarget: normalized.modelRuntimeTarget,
      lastActiveAt: Date.now(),
    });
    this.deps.chat.emit({ type: 'chat-updated', chatId: updated.id, chat: updated });
    return this.deps.chat.detail(updated);
  }

  // ── ChatService hooks ─────────────────────────────────────────────────────

  /**
   * Runtime fields that enforce the inherited policy for a sidechat's next
   * runtime, or null for an ordinary chat. Throws when the parent's policy
   * cannot be resolved or the chosen provider cannot enforce it.
   */
  async runtimeConfigFor(chat: ChatRecord): Promise<{
    config: Partial<InstanceCreateConfig>;
    fingerprint: string;
  } | null> {
    const link = this.linkStore.get(chat.id);
    if (!link) {
      return null;
    }
    const authority = await this.requireAuthority(link.parent);
    assertProviderEnforceable(chat.provider ?? 'claude', authority.policy);
    const target = chat.modelRuntimeTarget?.kind === 'local-model' ? chat.modelRuntimeTarget : null;
    return {
      config: {
        ...policyToRuntimeConfig(authority.policy),
        ...(target ? { modelOverride: target.modelId } : {}),
      },
      fingerprint: policyFingerprint(authority.policy),
    };
  }

  onRuntimeCreated(chatId: string, instanceId: string, fingerprint: string): void {
    this.runtimeFingerprint.set(instanceId, fingerprint);
    this.runtimeChat.set(instanceId, chatId);
  }

  onRuntimeCleared(instanceId: string): void {
    this.runtimeFingerprint.delete(instanceId);
    this.runtimeChat.delete(instanceId);
    this.coordinator.forgetRuntime(instanceId);
  }

  contextForTurn(chatId: string, instanceId: string, mode: 'rebuild' | 'resume'): string | null {
    return this.linkStore.get(chatId) ? this.coordinator.contextForTurn(chatId, instanceId, mode) : null;
  }

  /** Guard provider/model/reasoning changes made through the ordinary chat API. */
  async assertSelectionChangeAllowed(chat: ChatRecord, provider?: ChatProvider): Promise<void> {
    const link = this.linkStore.get(chat.id);
    if (!link) {
      return;
    }
    this.assertNoActiveTurn(chat);
    if (provider) {
      const authority = await this.requireAuthority(link.parent);
      assertProviderEnforceable(provider, authority.policy);
    }
  }

  /** Capture a sidechat's parent before its row (and link) are deleted. */
  onChatDeleting(chatId: string): void {
    const link = this.linkStore.get(chatId);
    this.contextStore.delete(chatId);
    if (link) {
      this.scheduleAttention(link.parent);
    }
  }

  /** Number of active sidechats owned by a parent (deletion confirmation copy). */
  countForParent(parent: SideChatParentRef): number {
    return this.linkStore.listActiveForParent(parent).length;
  }

  /** Test helper: emit any coalesced attention deltas immediately. */
  async flushAttention(): Promise<void> {
    if (this.attentionTimer) {
      clearTimeout(this.attentionTimer);
      this.attentionTimer = null;
      this.attentionFlush = this.emitPendingAttention();
    }
    await this.attentionFlush;
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private async preflight(chatId: string, link: SideChatLink): Promise<SideChatSendFailure | null> {
    const chat = this.deps.chatStore.get(chatId);
    const lastSnapshotAvailable = this.contextStore.get(chatId) !== null;
    if (!chat) {
      return { ok: false, code: 'not-linked', error: `Chat ${chatId} not found`, lastSnapshotAvailable };
    }
    const authority = await this.authority.resolve(link.parent);
    if (!authority.ok) {
      return { ok: false, code: 'unavailable-permissions', error: authority.error, lastSnapshotAvailable };
    }
    const enforcement = providerCanEnforcePolicy(chat.provider ?? 'claude', authority.policy);
    if (!enforcement.ok) {
      return { ok: false, code: 'provider-unavailable', error: enforcement.capability, lastSnapshotAvailable };
    }
    // Spawn-time restrictions cannot be edited in place, so a parent permission
    // change replaces the sidechat's runtime before this question is sent.
    const instance = chat.currentInstanceId
      ? this.deps.instanceManager.getInstance(chat.currentInstanceId)
      : undefined;
    if (instance && instance.status !== 'terminated'
      && this.runtimeFingerprint.get(instance.id) !== policyFingerprint(authority.policy)) {
      if (SIDE_CHAT_BUSY_STATUSES.has(instance.status)) {
        return {
          ok: false,
          code: 'busy',
          error: 'The parent session\'s permissions changed. Wait for the current answer or stop it before asking again.',
          lastSnapshotAvailable,
        };
      }
      logger.info('Replacing sidechat runtime after parent permission change', { chatId, instanceId: instance.id });
      await this.deps.chat.clearRuntime(chat, 'policy');
    }
    return null;
  }

  private async buildContextOptions(chatId: string): Promise<BuildParentContextOptions> {
    const chat = this.deps.chatStore.get(chatId);
    const instance = chat?.currentInstanceId
      ? this.deps.instanceManager.getInstance(chat.currentInstanceId)
      : undefined;
    const usage = instance?.contextUsage;
    if (usage && usage.total > 0) {
      // A live runtime reports its real window and what its history already uses.
      return { modelInputBudget: usage.total - usage.used, sidechatHistoryTokens: 0 };
    }
    if (!chat) {
      return {};
    }
    // A fresh runtime replays recent sidechat history; budget for it.
    const recent = await this.deps.ledger.getRecentConversation(chat.ledgerThreadId, HISTORY_ESTIMATE_MESSAGES);
    const historyTokens = recent.messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
    const window = getProviderModelContextWindow(chat.provider ?? 'claude', chat.model ?? undefined);
    return { modelInputBudget: window, sidechatHistoryTokens: historyTokens };
  }

  private async requireAuthority(parent: SideChatParentRef): Promise<{ policy: SideChatAuthorityPolicy }> {
    const resolution = await this.authority.resolve(parent);
    if (!resolution.ok) {
      throw new SideChatError(resolution.code, resolution.error);
    }
    return resolution;
  }

  private assertNoActiveTurn(chat: ChatRecord): void {
    const instance = chat.currentInstanceId
      ? this.deps.instanceManager.getInstance(chat.currentInstanceId)
      : undefined;
    if (instance && instance.status !== 'terminated' && SIDE_CHAT_BUSY_STATUSES.has(instance.status)) {
      throw new SideChatError('busy', 'Stop the current answer before changing provider, model or reasoning');
    }
  }

  private isAncestorOrSelf(chatId: string, parent: SideChatParentRef): boolean {
    let current: SideChatParentRef | null = parent;
    for (let depth = 0; current && depth < 8; depth += 1) {
      if (current.kind !== 'chat') return false;
      if (current.chatId === chatId) return true;
      current = this.linkStore.get(current.chatId)?.parent ?? null;
    }
    return false;
  }

  private requireChat(chatId: string): ChatRecord {
    const chat = this.deps.chatStore.get(chatId);
    if (!chat) {
      throw new SideChatError('not-found', `Chat ${chatId} not found`);
    }
    return chat;
  }

  /**
   * Persisted latest assistant sequence, backfilled from the ledger when it was
   * never observed (rows created before the column) or when `refresh` asks for
   * the authoritative value.
   */
  private async latestAssistantSequence(
    link: SideChatLink,
    options: { refresh?: boolean } = {},
  ): Promise<number> {
    const stored = this.linkStore.getLatestAssistantSequence(link.chatId);
    if (stored !== null && !options.refresh) {
      return stored;
    }
    const chat = this.deps.chatStore.get(link.chatId);
    if (!chat) {
      return stored ?? 0;
    }
    const latest = await this.latestAssistantSequenceForChat(chat);
    this.linkStore.recordAssistantSequence(link.chatId, latest);
    return Math.max(stored ?? 0, latest);
  }

  private async latestAssistantSequenceForChat(chat: ChatRecord): Promise<number> {
    const conversation = await this.deps.ledger.getRecentConversation(chat.ledgerThreadId, 200);
    return conversation.messages
      .filter((message) => message.role === 'assistant')
      .reduce((max, message) => Math.max(max, message.sequence), 0);
  }

  private onChatEvent(event: ChatEvent): void {
    if (event.type === 'side-chat-attention') {
      return;
    }
    const link = this.linkStore.get(event.chatId);
    if (!link) {
      return;
    }
    if (event.type === 'transcript-appended') {
      for (const message of event.messages) {
        if (message.role === 'assistant') {
          this.linkStore.recordAssistantSequence(event.chatId, message.sequence);
        }
      }
    }
    if (event.type === 'runtime-cleared' && event.previousInstanceId) {
      this.onRuntimeCleared(event.previousInstanceId);
    }
    this.scheduleAttention(link.parent);
  }

  private scheduleAttention(parent: SideChatParentRef): void {
    this.pendingAttention.set(sideChatParentKey(parent), parent);
    if (this.attentionTimer) {
      return;
    }
    this.attentionTimer = setTimeout(() => {
      this.attentionTimer = null;
      this.attentionFlush = this.emitPendingAttention();
    }, ATTENTION_FLUSH_MS);
    this.attentionTimer.unref?.();
  }

  private async emitPendingAttention(): Promise<void> {
    const parents = [...this.pendingAttention.values()];
    this.pendingAttention.clear();
    for (const parent of parents) {
      try {
        const attention = await this.attentionTracker.forParent(parent);
        this.deps.chat.emit({ type: 'side-chat-attention', attention });
      } catch (error) {
        logger.warn('Sidechat attention update failed', {
          parent: sideChatParentKey(parent),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

/** History-archive lookup backed by the main-process HistoryManager. */
export function createHistoryArchiveLookup(
  getManager: () => {
    getEntries(): import('../../shared/types/history.types').ConversationHistoryEntry[];
    loadConversation(entryId: string): Promise<{ messages: import('../../shared/types/instance.types').OutputMessage[] } | null>;
  },
): SideChatArchiveLookup {
  return {
    find(historyThreadId) {
      let newest: import('../../shared/types/history.types').ConversationHistoryEntry | null = null;
      for (const entry of getManager().getEntries()) {
        if (entry.historyThreadId === historyThreadId && (!newest || entry.endedAt > newest.endedAt)) {
          newest = entry;
        }
      }
      if (!newest) return null;
      return {
        entryId: newest.id,
        title: getConversationHistoryTitle(newest),
        workspacePath: newest.workingDirectory || null,
        originNodeId: newest.executionLocation?.type === 'remote' ? newest.executionLocation.nodeId : null,
      };
    },
    async loadMessages(entryId) {
      return (await getManager().loadConversation(entryId))?.messages ?? null;
    },
  };
}
