import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ChatCreateInput,
  ChatDetail,
  ChatEvent,
  ChatProvider,
  ChatRecord,
  ChatSendMessageInput,
  ChatUiState,
} from '../../shared/types/chat.types';
import type { ReasoningEffort } from '../../shared/types/provider.types';
import type {
  ConversationMessagePage,
  ConversationMessageRecord,
} from '../../shared/types/conversation-ledger.types';
import type { ConversationLedgerService } from '../conversation-ledger';
import {
  getConversationLedgerService,
  INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID,
} from '../conversation-ledger';
import type { InstanceManager } from '../instance/instance-manager';
import type { Instance } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';
import { getOperatorDatabase } from '../operator/operator-database';
import { addAllowedRoot } from '../security/path-validator';
import { ChatStore } from './chat-store';
import {
  buildReplayBlock,
  CHAT_REPLAY_MESSAGE_LIMIT,
  maybeAutoName,
  normalizeChatName,
} from './chat-service-helpers';
import type { ChatServiceConfig, ChatSystemEventInput } from './chat-service.types';
export type { ChatServiceConfig, ChatSystemEventInput } from './chat-service.types';
import { ChatTranscriptBridge, createUserLedgerMessage } from './chat-transcript-bridge';
import { ChatUiStateStore } from './chat-ui-state-store';
import { ChatSessionBindingStore, evaluateLineage } from './chat-session-binding-store';
import { buildLedgerRebuildPreamble, maybeProduceCheckpoint } from './chat-continuity';

const logger = getLogger('ChatService');
const CHAT_DETAIL_MESSAGE_LIMIT = 200;
const CHAT_LOAD_OLDER_LIMIT = 200;

export class ChatService {
  private static instance: ChatService | null = null;
  readonly events: EventEmitter;
  private readonly ledger: ConversationLedgerService;
  private readonly instanceManager: InstanceManager;
  private readonly store: ChatStore;
  private readonly uiStateStore: ChatUiStateStore;
  private readonly bridge: ChatTranscriptBridge;
  private readonly sessionBindingStore: ChatSessionBindingStore;
  private initialized = false;
  private migrationDone: Promise<void> = Promise.resolve();

  static getInstance(config: ChatServiceConfig): ChatService {
    this.instance ??= new ChatService(config);
    return this.instance;
  }

  static getIfInitialized(): ChatService | null {
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance?.dispose();
    this.instance = null;
  }

  /** Stop background work (the transcript bridge's deferred flush). Call on
   *  teardown so a pending flush can't fire against a closed store. */
  dispose(): void {
    this.bridge.stop();
  }

  /** Resolves once lazy init and the one-time legacy migration have completed.
   *  Production code doesn't need this; tests use it for determinism. */
  async whenReady(): Promise<void> {
    this.initialize();
    await this.migrationDone;
  }

  /** Drain the transcript bridge's pending writes immediately (tests/shutdown).
   *  Normally writes flush on a short timer off the event hot path. */
  async flushTranscript(): Promise<void> {
    await this.bridge.drainForShutdown();
  }

  constructor(config: ChatServiceConfig) {
    this.ledger = config.ledger ?? getConversationLedgerService();
    this.instanceManager = config.instanceManager;
    this.events = config.eventBus ?? new EventEmitter();
    const db = config.db ?? getOperatorDatabase().db;
    this.store = new ChatStore(db);
    this.uiStateStore = new ChatUiStateStore(db);
    this.sessionBindingStore = new ChatSessionBindingStore(db);
    this.bridge = new ChatTranscriptBridge({
      ledger: this.ledger,
      chatStore: this.store,
      instanceManager: this.instanceManager,
      eventBus: this.events,
    });
  }

  initialize(): void {
    if (this.initialized) {
      return;
    }
    this.initialized = true;
    this.store.clearRuntimeLinks();
    // One-time legacy backfill — runs off the init critical path (it now reads
    // the ledger through the worker, which is async). A slight delay before a
    // migrated chat appears is acceptable. The promise is retained so callers
    // (and tests) can await completion via whenReady().
    this.migrationDone = this.migrateLegacyOrchestratorThread().catch((error) => {
      logger.warn('Legacy orchestrator thread migration failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    // Trust each persisted chat's working directory in the renderer-facing
    // path sandbox so file drags into a returning chat session work after
    // a restart. Includes archived chats (cheap) since the user could
    // un-archive at any time.
    for (const chat of this.store.list({ includeArchived: true })) {
      if (chat.currentCwd) {
        addAllowedRoot(chat.currentCwd);
      }
    }
    this.bridge.start();
  }

  listChats(options: { includeArchived?: boolean } = {}): ChatRecord[] {
    this.initialize();
    return this.store.list(options);
  }

  getUiState(): ChatUiState {
    this.initialize();
    return this.filterUiState(this.uiStateStore.get());
  }

  setUiState(input: Pick<ChatUiState, 'selectedChatId' | 'openChatIds'>): ChatUiState {
    this.initialize();
    this.uiStateStore.set(input);
    return this.getUiState();
  }

  async getChat(chatId: string): Promise<ChatDetail> {
    this.initialize();
    return this.detailFor(this.requireChat(chatId));
  }

  async loadOlderMessages(
    chatId: string,
    options: { beforeSequence: number; limit?: number },
  ): Promise<ConversationMessagePage> {
    this.initialize();
    const chat = this.requireChat(chatId);
    return this.ledger.getConversationPageBefore(
      chat.ledgerThreadId,
      options.beforeSequence,
      Math.max(1, Math.min(options.limit ?? CHAT_LOAD_OLDER_LIMIT, 500)),
    );
  }

  async createChat(input: ChatCreateInput): Promise<ChatDetail> {
    this.initialize();
    const id = randomUUID();
    const name = normalizeChatName(input.name);
    const thread = await this.ledger.startConversation({
      provider: 'orchestrator',
      workspacePath: input.currentCwd,
      title: name,
      metadata: {
        chatId: id,
        scope: 'chat',
        operatorThreadKind: 'chat',
      },
    });
    const chat = this.store.insert({
      id,
      name,
      provider: input.provider,
      model: input.model ?? null,
      reasoningEffort: input.reasoningEffort ?? null,
      currentCwd: input.currentCwd,
      yolo: input.yolo ?? false,
      ledgerThreadId: thread.id,
    });
    addAllowedRoot(input.currentCwd);
    const detail = await this.detailFor(chat);
    this.emit({ type: 'chat-created', chatId: chat.id, chat });
    return detail;
  }

  async renameChat(chatId: string, name: string): Promise<ChatDetail> {
    this.initialize();
    const chat = this.store.update(chatId, {
      name: normalizeChatName(name),
      lastActiveAt: Date.now(),
    });
    this.emit({ type: 'chat-updated', chatId: chat.id, chat });
    return this.detailFor(chat);
  }

  async archiveChat(chatId: string): Promise<ChatRecord> {
    this.initialize();
    const existing = this.requireChat(chatId);
    const previousInstanceId = await this.terminateRuntimeIfRunning(existing, 'archive');
    const chat = this.store.update(chatId, {
      currentInstanceId: null,
      archivedAt: Date.now(),
      lastActiveAt: Date.now(),
    });
    if (previousInstanceId) {
      this.emit({ type: 'runtime-cleared', chatId: chat.id, previousInstanceId, chat });
    }
    this.emit({ type: 'chat-archived', chatId: chat.id });
    return chat;
  }

  async setProvider(chatId: string, provider: ChatProvider): Promise<ChatDetail> {
    this.initialize();
    const chat = this.requireChat(chatId);
    if (chat.provider && await this.ledger.hasMessages(chat.ledgerThreadId)) {
      throw new Error('Chat provider can only be changed before the first message');
    }
    const previousInstanceId = await this.terminateRuntimeIfRunning(chat, 'provider');
    const updated = this.store.update(chat.id, {
      provider,
      currentInstanceId: null,
      lastActiveAt: Date.now(),
    });
    this.emit({ type: 'runtime-cleared', chatId: updated.id, previousInstanceId, chat: updated });
    this.emit({ type: 'chat-updated', chatId: updated.id, chat: updated });
    return this.detailFor(updated);
  }

  async setModel(chatId: string, model: string | null): Promise<ChatDetail> {
    this.initialize();
    const chat = this.requireChat(chatId);
    if (!chat.provider) {
      throw new Error('Set a provider before setting a model');
    }
    const previousInstanceId = await this.terminateRuntimeIfRunning(chat, 'model');
    const updated = this.store.update(chat.id, {
      model,
      currentInstanceId: null,
      lastActiveAt: Date.now(),
    });
    this.emit({ type: 'runtime-cleared', chatId: updated.id, previousInstanceId, chat: updated });
    this.emit({ type: 'chat-updated', chatId: updated.id, chat: updated });
    return this.detailFor(updated);
  }

  async setReasoning(chatId: string, reasoningEffort: ReasoningEffort | null): Promise<ChatDetail> {
    this.initialize();
    const chat = this.requireChat(chatId);
    if (!chat.provider) {
      throw new Error('Set a provider before setting a reasoning level');
    }
    const previousInstanceId = await this.terminateRuntimeIfRunning(chat, 'reasoning');
    const updated = this.store.update(chat.id, {
      reasoningEffort,
      currentInstanceId: null,
      lastActiveAt: Date.now(),
    });
    this.emit({ type: 'runtime-cleared', chatId: updated.id, previousInstanceId, chat: updated });
    this.emit({ type: 'chat-updated', chatId: updated.id, chat: updated });
    return this.detailFor(updated);
  }

  async setYolo(chatId: string, yolo: boolean): Promise<ChatDetail> {
    this.initialize();
    const chat = this.store.update(chatId, {
      yolo,
      lastActiveAt: Date.now(),
    });
    // Propagate to the live instance so the new mode takes effect immediately.
    // `instance.yoloMode` is the single source of truth consulted by the
    // Browser Gateway auto-approve, the permission enforcer and the bash
    // validators — without this, toggling YOLO mid-chat only updated the stored
    // record and left the running instance (and its browser prompts) unchanged.
    const instanceId = chat.currentInstanceId;
    if (instanceId) {
      const inst = this.instanceManager.getInstance(instanceId);
      if (inst && inst.status !== 'terminated' && inst.yoloMode !== yolo) {
        try {
          await this.instanceManager.setYoloMode(instanceId, yolo);
        } catch (error) {
          // Respawn can fail (e.g. the instance is busy). Still flip the flag so
          // approval gates honor YOLO right away; the CLI's own spawn flags catch
          // up on the next respawn.
          inst.yoloMode = yolo;
          logger.warn('Could not respawn instance for chat YOLO change; updated flag in place', {
            chatId,
            instanceId,
            yolo,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    this.emit({ type: 'chat-updated', chatId: chat.id, chat });
    return this.detailFor(chat);
  }

  async setCwd(chatId: string, cwd: string): Promise<ChatDetail> {
    this.initialize();
    const chat = this.requireChat(chatId);
    const previousInstanceId = chat.currentInstanceId;
    const previousCwd = chat.currentCwd;
    addAllowedRoot(cwd);
    if (previousInstanceId) {
      await this.terminateRuntime(chat, previousInstanceId, 'cwd');
    }
    const updated = this.store.update(chat.id, {
      currentCwd: cwd,
      currentInstanceId: null,
      lastActiveAt: Date.now(),
    });
    await this.ledger.appendMessageReturningRecord(updated.ledgerThreadId, {
      nativeMessageId: `chat-cwd-switch:${Date.now()}:${randomUUID()}`,
      nativeTurnId: `chat-cwd-switch:${randomUUID()}`,
      role: 'system',
      phase: 'event',
      content: `Project switched to ${cwd}.`,
      createdAt: Date.now(),
      rawJson: {
        metadata: {
          kind: 'cwd-switch',
          previousCwd,
          currentCwd: cwd,
        },
      },
    });
    this.emit({
      type: 'runtime-cleared',
      chatId: updated.id,
      previousInstanceId,
      chat: updated,
    });
    this.emit({ type: 'chat-updated', chatId: updated.id, chat: updated });
    return this.detailFor(updated);
  }

  async sendMessage(input: ChatSendMessageInput): Promise<ChatDetail> {
    this.initialize();
    const chat = this.requireChat(input.chatId);
    this.assertBootstrapComplete(chat);
    const text = input.text.trim();
    if (!text) {
      throw new Error('Chat message cannot be empty');
    }
    const named = maybeAutoName(chat, text, input.attachments?.map((a) => a.name) ?? []);
    const workingChat = named
      ? this.store.update(chat.id, { name: named, lastActiveAt: Date.now() })
      : chat;
    const appended = await this.ledger.appendMessageReturningRecord(workingChat.ledgerThreadId, createUserLedgerMessage({
      text,
      chatId: workingChat.id,
      attachments: input.attachments,
    }));
    const replayMessages = (await this.ledger.getRecentConversation(
      workingChat.ledgerThreadId,
      CHAT_REPLAY_MESSAGE_LIMIT,
    )).messages;
    const { instance, isFresh } = await this.ensureRuntime(workingChat);
    const replayed = this.withReplayIfNeeded(workingChat, replayMessages, text);
    // `withReplayIfNeeded` already prepends a bounded replay block on a cwd
    // switch; skip the rebuild preamble in that case so context isn't injected
    // twice.
    const cwdReplayApplied = replayed !== text;
    await this.prepareTurnContext(workingChat, instance, replayMessages, {
      isFresh,
      skipReplay: cwdReplayApplied,
    });
    await this.instanceManager.sendInput(instance.id, replayed, input.attachments);
    // The turn went out through `instance`'s session; rebind so the NEXT turn
    // can take the native-resume fast path instead of rebuilding (§5.1). Records
    // the just-appended user turn as the ledger-tail reconciliation marker.
    this.recordSessionBinding(workingChat, instance, appended?.nativeMessageId ?? null);
    // Off the hot path: keep the rebuild bounded under huge histories by folding
    // old turns into a durable summary checkpoint (§4.4). Best-effort.
    void maybeProduceCheckpoint(this.ledger, workingChat.id, workingChat.ledgerThreadId).catch(
      (error) => {
        logger.warn('Conversation checkpoint production failed', {
          chatId: workingChat.id,
          error: error instanceof Error ? error.message : String(error),
        });
      },
    );
    const updated = this.store.update(workingChat.id, {
      currentInstanceId: instance.id,
      lastActiveAt: Date.now(),
    });
    this.emitAppended(updated, appended ? [appended] : []);
    return this.detailFor(updated);
  }

  async appendSystemEvent(input: ChatSystemEventInput): Promise<ChatDetail> {
    this.initialize();
    const chat = this.requireChat(input.chatId);
    const existing = await this.ledger.hasMessage(chat.ledgerThreadId, input.nativeMessageId);
    if (existing) {
      return this.detailFor(chat);
    }

    const autoNamed = input.autoName ? maybeAutoName(chat, input.content) : null;
    const workingChat = autoNamed
      ? this.store.update(chat.id, { name: autoNamed, lastActiveAt: Date.now() })
      : chat;

    const appended = await this.ledger.appendMessageReturningRecord(workingChat.ledgerThreadId, {
      nativeMessageId: input.nativeMessageId,
      nativeTurnId: input.nativeTurnId,
      role: input.role ?? 'system',
      phase: input.phase ?? null,
      content: input.content,
      createdAt: input.createdAt ?? Date.now(),
      tokenInput: null,
      tokenOutput: null,
      rawRef: null,
      rawJson: input.metadata ? { metadata: input.metadata } : null,
      sourceChecksum: null,
    });
    const updated = this.store.update(workingChat.id, { lastActiveAt: Date.now() });
    if (autoNamed) {
      this.emit({ type: 'chat-updated', chatId: updated.id, chat: updated });
    }
    this.emitAppended(updated, appended ? [appended] : []);
    return this.detailFor(updated);
  }

  /**
   * Non-throwing lookup. Mirrors `requireChat` but returns `null` when the
   * chat doesn't exist, so callers can branch (e.g. dispatch to an instance
   * path when the id turns out to be an instance id, not a chat id).
   */
  tryGetChat(chatId: string): ChatRecord | null {
    this.initialize();
    return this.store.get(chatId);
  }

  private async terminateRuntimeIfRunning(
    chat: ChatRecord,
    reason: 'provider' | 'model' | 'reasoning' | 'archive',
  ): Promise<string | null> {
    const previousInstanceId = chat.currentInstanceId;
    if (!previousInstanceId) {
      return null;
    }
    await this.terminateRuntime(chat, previousInstanceId, reason);
    return previousInstanceId;
  }

  private async terminateRuntime(
    chat: ChatRecord,
    instanceId: string,
    reason: 'provider' | 'model' | 'reasoning' | 'archive' | 'cwd',
  ): Promise<void> {
    const inst = this.instanceManager.getInstance(instanceId);
    if (inst && inst.status !== 'terminated') {
      try {
        await this.instanceManager.terminateInstance(instanceId, true);
      } catch (error) {
        logger.warn('Failed to terminate chat runtime during transition', {
          chatId: chat.id,
          instanceId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    await this.bridge.flushAndUnlink(instanceId);
  }

  private async ensureRuntime(chat: ChatRecord): Promise<{ instance: Instance; isFresh: boolean }> {
    const existing = chat.currentInstanceId
      ? this.instanceManager.getInstance(chat.currentInstanceId)
      : undefined;
    if (existing && existing.status !== 'terminated') {
      this.bridge.link(chat.id, existing.id);
      return { instance: existing, isFresh: false };
    }

    this.assertBootstrapComplete(chat);
    const instance = await this.instanceManager.createInstance({
      workingDirectory: chat.currentCwd!,
      displayName: chat.name || basename(chat.currentCwd!) || 'Chat',
      yoloMode: chat.yolo,
      provider: chat.provider!,
      modelOverride: chat.model ?? undefined,
      reasoningEffort: chat.reasoningEffort ?? undefined,
      agentId: 'build',
    });
    this.bridge.link(chat.id, instance.id);
    const updated = this.store.update(chat.id, {
      currentInstanceId: instance.id,
      lastActiveAt: Date.now(),
    });
    this.emit({
      type: 'runtime-linked',
      chatId: chat.id,
      instanceId: instance.id,
      chat: updated,
    });
    return { instance, isFresh: true };
  }

  private withReplayIfNeeded(
    chat: ChatRecord,
    messages: ConversationMessageRecord[],
    text: string,
  ): string {
    const messagesBeforeCurrent = messages.slice(0, -1);
    const last = messagesBeforeCurrent[messagesBeforeCurrent.length - 1];
    const metadata = last?.rawJson?.['metadata'];
    if (
      !last
      || last.role !== 'system'
      || !metadata
      || typeof metadata !== 'object'
      || Array.isArray(metadata)
      || (metadata as Record<string, unknown>)['kind'] !== 'cwd-switch'
    ) {
      return text;
    }

    const previousCwd = typeof (metadata as Record<string, unknown>)['previousCwd'] === 'string'
      ? (metadata as Record<string, unknown>)['previousCwd'] as string
      : 'the previous project';
    const replay = buildReplayBlock(messagesBeforeCurrent.slice(0, -1), previousCwd, chat.currentCwd ?? homedir());
    return replay ? `${replay}\n\n${text}` : text;
  }

  /**
   * Mark this chat's session lineage as broken — called by the loop IPC
   * handlers when a non-borrowed loop terminates. The loop ran in its own CLI
   * session, so the interactive model has no memory of the loop iterations.
   * Because Phase 1 writes every iteration into the chat's ledger thread as
   * assistant turns, the next `sendMessage` can rebuild context from the ledger
   * and inject it as a continuity preamble before the user's turn reaches the
   * model.
   *
   * The flag is durable (persisted to the operator DB), so it survives an app
   * restart — unlike the previous in-memory `pendingLoopHandoffs` mechanism.
   */
  bumpLineageEpoch(chatId: string): void {
    this.sessionBindingStore.markNeedsRebuild(chatId);
    logger.info('Bumped loop lineage epoch — will rebuild from ledger on next send', { chatId });
  }

  /**
   * Implements §4.3 + §5.1 of the continuity plan: the ledger is the single
   * source of truth, and native provider `--resume` is only a fast path valid
   * while session lineage is provably intact (`evaluateLineage`). Whenever it is
   * not, the model's context is deterministically rebuilt from the ledger and
   * injected as a continuity preamble before the user's turn reaches the
   * provider.
   *
   * The lineage rules collapse every prior special case — loop divergence, fresh
   * sessions after restart/eviction, provider/model switches, ledger rewrites —
   * into one predicate. A valid binding ⇒ native resume, zero replay cost. Any
   * doubt ⇒ rebuild (conservative by default; correctness over a cache hit).
   *
   * `messages` is the recent ledger tail *including* the just-appended current
   * user turn; we replay only the prior turns so the current message isn't
   * duplicated into the rebuilt history. The binding is (re)written after the
   * send by {@link recordSessionBinding}, so this method only decides + injects.
   */
  private async prepareTurnContext(
    chat: ChatRecord,
    instance: Instance,
    messages: ConversationMessageRecord[],
    options: { isFresh: boolean; skipReplay: boolean },
  ): Promise<void> {
    const binding = this.sessionBindingStore.get(chat.id);
    const lastTurnStillInLedger = binding?.lastTurnNativeId
      ? await this.ledger.hasMessage(chat.ledgerThreadId, binding.lastTurnNativeId)
      : true;
    const verdict = evaluateLineage(binding, {
      requestedProvider: chat.provider ?? instance.provider ?? 'unknown',
      liveSessionId: instance.providerSessionId || instance.sessionId || '',
      isFresh: options.isFresh,
      lastTurnStillInLedger,
    });
    if (verdict.valid) {
      return; // native-resume fast path — the bound session already has context.
    }
    if (options.skipReplay) {
      // A cwd-switch replay block was already prepended to the outgoing message
      // by `withReplayIfNeeded`, replaying the same prior ledger turns (including
      // any loop iterations). Context is delivered by that path; don't double
      // inject. The binding is reset after the send regardless.
      return;
    }
    const currentSequence = messages[messages.length - 1]?.sequence ?? Number.MAX_SAFE_INTEGER;
    const priorTurns = messages.slice(0, -1);
    if (!priorTurns.some((m) => m.role === 'user' || m.role === 'assistant')) {
      return; // brand-new chat (or only system events) — nothing to replay.
    }
    const preamble = await buildLedgerRebuildPreamble(
      this.ledger,
      chat.ledgerThreadId,
      priorTurns,
      currentSequence,
      verdict.reason,
    );
    if (preamble) {
      this.instanceManager.queueContinuityPreamble(instance.id, preamble);
      logger.info('Rebuilt turn context from ledger', {
        chatId: chat.id,
        reason: verdict.reason,
      });
    }
  }

  /**
   * Record that the chat's context now lives in the live instance's session and
   * is reconciled with the ledger up to `lastTurnNativeId`. Clears the durable
   * rebuild flag so the next turn can take the native-resume fast path (§5.1).
   */
  private recordSessionBinding(
    chat: ChatRecord,
    instance: Instance,
    lastTurnNativeId: string | null,
  ): void {
    this.sessionBindingStore.recordValidSession({
      chatId: chat.id,
      provider: chat.provider ?? instance.provider ?? 'unknown',
      sessionId: instance.providerSessionId || instance.sessionId || '',
      lastTurnNativeId,
    });
  }

  private async detailFor(chat: ChatRecord): Promise<ChatDetail> {
    const currentInstance = chat.currentInstanceId
      ? this.instanceManager.getInstance(chat.currentInstanceId) ?? null
      : null;
    return {
      chat,
      conversation: await this.ledger.getRecentConversation(
        chat.ledgerThreadId,
        CHAT_DETAIL_MESSAGE_LIMIT,
      ),
      currentInstance,
    };
  }

  private requireChat(chatId: string): ChatRecord {
    const chat = this.store.get(chatId);
    if (!chat) {
      throw new Error(`Chat ${chatId} not found`);
    }
    return chat;
  }

  private filterUiState(state: ChatUiState): ChatUiState {
    const activeChatIds = new Set(this.store.list().map((chat) => chat.id));
    const openChatIds = state.openChatIds.filter((id) => activeChatIds.has(id));
    const selectedChatId = state.selectedChatId && activeChatIds.has(state.selectedChatId)
      ? state.selectedChatId
      : openChatIds[0] ?? null;
    const filtered = { selectedChatId, openChatIds, updatedAt: state.updatedAt };
    if (
      filtered.selectedChatId !== state.selectedChatId
      || filtered.openChatIds.length !== state.openChatIds.length
      || filtered.openChatIds.some((id, index) => id !== state.openChatIds[index])
    ) {
      return this.uiStateStore.set(filtered);
    }
    return filtered;
  }

  private assertBootstrapComplete(chat: ChatRecord): void {
    if (!chat.provider || !chat.currentCwd) {
      throw new Error('Pick a provider and working directory before sending a chat message');
    }
  }

  private async migrateLegacyOrchestratorThread(): Promise<void> {
    const existingChats = this.store.list({ includeArchived: true });
    for (const chat of existingChats) {
      const thread = await this.ledger.getThread(chat.ledgerThreadId);
      if (thread?.nativeThreadId === INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID) {
        return; // already migrated
      }
    }

    const thread = (await this.ledger.listConversations({
      provider: 'orchestrator',
      sourceKind: 'orchestrator',
      limit: 500,
    })).find((candidate) =>
      candidate.nativeThreadId === INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID
      || (
        candidate.metadata['scope'] === 'global'
        && candidate.metadata['operatorThreadKind'] === 'root'
      )
    );
    if (!thread || this.store.getByLedgerThreadId(thread.id)) {
      return;
    }
    const now = Date.now();
    const chat = this.store.insert({
      id: randomUUID(),
      name: thread.title?.trim() || 'Orchestrator',
      provider: null,
      model: null,
      currentCwd: null,
      yolo: false,
      ledgerThreadId: thread.id,
      createdAt: thread.createdAt || now,
      lastActiveAt: thread.updatedAt || now,
    });
    this.emit({ type: 'chat-created', chatId: chat.id, chat });
  }

  private emit(event: ChatEvent): void {
    this.events.emit('chat:event', event);
  }

  /**
   * Emit an incremental transcript delta. Carries only the freshly-appended
   * message(s) — never the whole conversation — so the renderer (and any other
   * window) merges a small payload instead of re-rendering the entire
   * transcript on every append.
   */
  private emitAppended(chat: ChatRecord, messages: ConversationMessageRecord[]): void {
    const currentInstance = chat.currentInstanceId
      ? this.instanceManager.getInstance(chat.currentInstanceId) ?? null
      : null;
    this.emit({
      type: 'transcript-appended',
      chatId: chat.id,
      chat,
      messages,
      currentInstance,
    });
  }
}

export function getChatService(config: ChatServiceConfig): ChatService {
  return ChatService.getInstance(config);
}

export function getChatServiceIfInitialized(): ChatService | null {
  return ChatService.getIfInitialized();
}
