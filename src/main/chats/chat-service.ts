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
import type { ConversationLedgerService } from '../conversation-ledger';
import {
  getConversationLedgerService,
  INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID,
} from '../conversation-ledger';
import type { InstanceManager } from '../instance/instance-manager';
import type { Instance } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';
import { getOperatorDatabase } from '../operator/operator-database';
import { ChatStore } from './chat-store';
import { ChatTranscriptBridge, createUserLedgerMessage } from './chat-transcript-bridge';
import type { SqliteDriver } from '../db/sqlite-driver';

const logger = getLogger('ChatService');
const UNTITLED_CHAT = 'Untitled chat';
const REPLAY_TURN_PAIR_LIMIT = 10;
const REPLAY_CHAR_BUDGET = 24_000;

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

  static getInstance(config: ChatServiceConfig): ChatService {
    this.instance ??= new ChatService(config);
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
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
    this.migrateLegacyOrchestratorThread();
    this.bridge.start();
  }

  listChats(options: { includeArchived?: boolean } = {}): ChatRecord[] {
    this.initialize();
    return this.store.list(options);
  }

  getChat(chatId: string): ChatDetail {
    this.initialize();
    return this.detailFor(this.requireChat(chatId));
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
    const detail = this.detailFor(chat);
    this.emit({ type: 'chat-created', chatId: chat.id, chat });
    return detail;
  }

  renameChat(chatId: string, name: string): ChatDetail {
    this.initialize();
    const chat = this.store.update(chatId, {
      name: normalizeChatName(name),
      lastActiveAt: Date.now(),
    });
    this.emit({ type: 'chat-updated', chatId: chat.id, chat });
    return this.detailFor(chat);
  }

  archiveChat(chatId: string): ChatRecord {
    this.initialize();
    const chat = this.store.update(chatId, {
      currentInstanceId: null,
      archivedAt: Date.now(),
      lastActiveAt: Date.now(),
    });
    this.emit({ type: 'chat-archived', chatId: chat.id });
    return chat;
  }

  async setProvider(chatId: string, provider: ChatProvider): Promise<ChatDetail> {
    this.initialize();
    const chat = this.requireChat(chatId);
    const messages = this.ledger.getConversation(chat.ledgerThreadId).messages;
    if (chat.provider && messages.length > 0) {
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

  setYolo(chatId: string, yolo: boolean): ChatDetail {
    this.initialize();
    const chat = this.store.update(chatId, {
      yolo,
      lastActiveAt: Date.now(),
    });
    this.emit({ type: 'chat-updated', chatId: chat.id, chat });
    return this.detailFor(chat);
  }

  async setCwd(chatId: string, cwd: string): Promise<ChatDetail> {
    this.initialize();
    const chat = this.requireChat(chatId);
    const previousInstanceId = chat.currentInstanceId;
    const previousCwd = chat.currentCwd;
    if (previousInstanceId) {
      this.bridge.unlink(previousInstanceId);
      await this.instanceManager.terminateInstance(previousInstanceId, true).catch((error) => {
        logger.warn('Failed to terminate old chat runtime during cwd switch', {
          chatId,
          previousInstanceId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    const updated = this.store.update(chat.id, {
      currentCwd: cwd,
      currentInstanceId: null,
      lastActiveAt: Date.now(),
    });
    this.ledger.appendMessage(updated.ledgerThreadId, {
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
    const named = maybeAutoName(chat, text);
    const workingChat = named
      ? this.store.update(chat.id, { name: named, lastActiveAt: Date.now() })
      : chat;
    const conversation = this.ledger.appendMessage(workingChat.ledgerThreadId, createUserLedgerMessage({
      text,
      chatId: workingChat.id,
      attachments: input.attachments,
    }));
    const instance = await this.ensureRuntime(workingChat);
    const messageForRuntime = this.withReplayIfNeeded(workingChat, conversation, text);
    await this.instanceManager.sendInput(instance.id, messageForRuntime, input.attachments);
    const updated = this.store.update(workingChat.id, {
      currentInstanceId: instance.id,
      lastActiveAt: Date.now(),
    });
    const detail = this.detailFor(updated);
    this.emit({
      type: 'transcript-updated',
      chatId: updated.id,
      detail,
    });
    return detail;
  }

  appendSystemEvent(input: ChatSystemEventInput): ChatDetail {
    this.initialize();
    const chat = this.requireChat(input.chatId);
    const existing = this.ledger
      .getConversation(chat.ledgerThreadId)
      .messages
      .some((message) => message.nativeMessageId === input.nativeMessageId);
    if (existing) {
      return this.detailFor(chat);
    }

    const autoNamed = input.autoName ? maybeAutoName(chat, input.content) : null;
    const workingChat = autoNamed
      ? this.store.update(chat.id, { name: autoNamed, lastActiveAt: Date.now() })
      : chat;

    this.ledger.appendMessage(workingChat.ledgerThreadId, {
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
    const detail = this.detailFor(updated);
    if (autoNamed) {
      this.emit({ type: 'chat-updated', chatId: updated.id, chat: updated });
    }
    this.emit({
      type: 'transcript-updated',
      chatId: updated.id,
      detail,
    });
    return detail;
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
    reason: 'provider' | 'model' | 'reasoning',
  ): Promise<string | null> {
    const previousInstanceId = chat.currentInstanceId;
    if (!previousInstanceId) {
      return null;
    }
    this.bridge.unlink(previousInstanceId);
    const inst = this.instanceManager.getInstance(previousInstanceId);
    if (inst && inst.status !== 'terminated') {
      await this.instanceManager.terminateInstance(previousInstanceId, true).catch((error) => {
        logger.warn('Failed to terminate chat runtime during config switch', {
          chatId: chat.id,
          previousInstanceId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return previousInstanceId;
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
    conversation: ChatDetail['conversation'],
    text: string,
  ): string {
    const messagesBeforeCurrent = conversation.messages.slice(0, -1);
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

  private detailFor(chat: ChatRecord): ChatDetail {
    const currentInstance = chat.currentInstanceId
      ? this.instanceManager.getInstance(chat.currentInstanceId) ?? null
      : null;
    return {
      chat,
      conversation: this.ledger.getConversation(chat.ledgerThreadId),
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

  private migrateLegacyOrchestratorThread(): void {
    const existingChats = this.store.list({ includeArchived: true });
    const migrated = existingChats.some((chat) => {
      const thread = this.ledger.getConversation(chat.ledgerThreadId).thread;
      return thread.nativeThreadId === INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID;
    });
    if (migrated) {
      return;
    }

    const thread = this.ledger.listConversations({
      provider: 'orchestrator',
      sourceKind: 'orchestrator',
      limit: 500,
    }).find((candidate) =>
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
}

export function getChatService(config: ChatServiceConfig): ChatService {
  return ChatService.getInstance(config);
}

function normalizeChatName(name: string | undefined): string {
  const trimmed = name?.trim();
  return trimmed || UNTITLED_CHAT;
}

function maybeAutoName(chat: ChatRecord, text: string): string | null {
  if (chat.name !== UNTITLED_CHAT) {
    return null;
  }
  const compact = text.replace(/\s+/g, ' ').trim();
  if (!compact) {
    return null;
  }
  if (compact.length <= 44) {
    return compact;
  }
  const slice = compact.slice(0, 44);
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
