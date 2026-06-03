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
import { frontLoadTitle } from '../../shared/types/history.types';
import { deriveAttachmentTaskTitle, isLowSignalTitle } from '../../shared/types/title-derivation';
import { getLogger } from '../logging/logger';
import { getOperatorDatabase } from '../operator/operator-database';
import { addAllowedRoot } from '../security/path-validator';
import { ChatStore } from './chat-store';
import { ChatTranscriptBridge, createUserLedgerMessage } from './chat-transcript-bridge';
import type { SqliteDriver } from '../db/sqlite-driver';

const logger = getLogger('ChatService');
const UNTITLED_CHAT = 'Untitled chat';
const REPLAY_TURN_PAIR_LIMIT = 10;
const REPLAY_CHAR_BUDGET = 24_000;
const CHAT_DETAIL_MESSAGE_LIMIT = 200;
const CHAT_LOAD_OLDER_LIMIT = 200;
const CHAT_REPLAY_MESSAGE_LIMIT = (REPLAY_TURN_PAIR_LIMIT * 2) + 2;

export interface ChatServiceConfig {
  db?: SqliteDriver;
  ledger?: ConversationLedgerService;
  instanceManager: InstanceManager;
  eventBus?: EventEmitter;
}

export interface ChatSystemEventInput {
  chatId: string;
  nativeMessageId: string;
  nativeTurnId?: string;
  phase?: string;
  content: string;
  createdAt?: number;
  metadata?: Record<string, unknown>;
  /**
   * Ledger role for the appended event. Defaults to `'system'`. Use `'user'`
   * for synthesized events that represent the user's intent (e.g. the loop
   * kickoff prompt) so they render as user bubbles in the transcript.
   */
  role?: 'user' | 'system';
  /**
   * When `true`, run the same `maybeAutoName(chat, content)` heuristic that
   * `sendMessage` runs on first-message arrival — derives the chat title from
   * the content if the chat is still `'Untitled chat'`. Intended for synthetic
   * user-role events that semantically *are* the user's first message (loop
   * kickoff prompts). No-op when the chat already has a custom name.
   */
  autoName?: boolean;
}

export class ChatService {
  private static instance: ChatService | null = null;
  readonly events: EventEmitter;
  private readonly ledger: ConversationLedgerService;
  private readonly instanceManager: InstanceManager;
  private readonly store: ChatStore;
  private readonly bridge: ChatTranscriptBridge;
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
    this.store = new ChatStore(config.db ?? getOperatorDatabase().db);
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
    const instance = await this.ensureRuntime(workingChat);
    const messageForRuntime = this.withReplayIfNeeded(workingChat, replayMessages, text);
    await this.instanceManager.sendInput(instance.id, messageForRuntime, input.attachments);
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

  private async ensureRuntime(chat: ChatRecord): Promise<Instance> {
    const existing = chat.currentInstanceId
      ? this.instanceManager.getInstance(chat.currentInstanceId)
      : undefined;
    if (existing && existing.status !== 'terminated') {
      this.bridge.link(chat.id, existing.id);
      return existing;
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
    return instance;
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

function normalizeChatName(name: string | undefined): string {
  const trimmed = name?.trim();
  return trimmed || UNTITLED_CHAT;
}

function maybeAutoName(
  chat: ChatRecord,
  text: string,
  attachmentNames: readonly string[] = [],
): string | null {
  if (chat.name !== UNTITLED_CHAT) {
    return null;
  }
  // Strip generic lead-ins ("Please …", "review this PR", a bare URL) so the
  // stored chat name is recognizable within its first ~30 chars — the same
  // treatment the workspace rail applies to thread titles.
  const compact = frontLoadTitle(text);

  // Generic filler ("Please implement this") with a file attached: the file is
  // the subject. Fold its (cleaned) name in subject-first so the name stays
  // recognizable once the rail truncates — matching AutoTitleService's instant
  // title. Also covers the no-prose case (compact === '').
  if (attachmentNames.length > 0 && (!compact || isLowSignalTitle(compact))) {
    const fromAttachment = deriveAttachmentTaskTitle(text, attachmentNames);
    if (fromAttachment) {
      return truncateChatName(fromAttachment);
    }
  }

  if (!compact) {
    return null;
  }
  return truncateChatName(compact);
}

/** Trim an auto-derived chat name to the rail-visible length at a word boundary. */
function truncateChatName(name: string): string {
  if (name.length <= 44) {
    return name;
  }
  const slice = name.slice(0, 44);
  const lastSpace = slice.lastIndexOf(' ');
  return `${slice.slice(0, lastSpace > 20 ? lastSpace : 44).trim()}...`;
}

function buildReplayBlock(
  messages: ChatDetail['conversation']['messages'],
  previousCwd: string,
  currentCwd: string,
): string {
  const turns = messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .slice(-REPLAY_TURN_PAIR_LIMIT * 2)
    .map((message) => `${message.role}: ${message.content.trim()}`)
    .filter((line) => line.length > 0);

  while (turns.join('\n\n').length > REPLAY_CHAR_BUDGET && turns.length > 1) {
    turns.shift();
  }

  if (turns.length === 0) {
    return '';
  }

  return [
    `[Context from prior conversation, working directory was ${previousCwd}:]`,
    turns.join('\n\n'),
    `[Continue, working directory is now ${currentCwd}.]`,
  ].join('\n');
}
