import type { ConversationCheckpointRecord } from '../../shared/types/conversation-ledger.types';
import type { SideChatParentRef } from '../../shared/types/side-chat.types';
import type { ConversationLedgerService } from '../conversation-ledger';
import type { InstanceManager } from '../instance/instance-manager';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';
import type { ChatStore } from './chat-store';

const logger = getLogger('SideChatParentResolver');

/** One normalized parent transcript turn, regardless of source owner. */
export interface ParentTranscriptTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
  sequence: number;
  createdAt: number;
  phase: string | null;
}

export type ParentSourceKind =
  | 'chat-ledger'
  | 'session-ledger'
  | 'session-runtime'
  | 'session-archive';

export interface ResolvedParentSource {
  parent: SideChatParentRef;
  title: string;
  workspacePath: string | null;
  /** Workspace provenance (origin worker node). Never part of ownership. */
  originNodeId: string | null;
  /** Live instance status when a runtime is currently attached. */
  status: string | null;
  sourceKind: ParentSourceKind;
  checkpoint: ConversationCheckpointRecord | null;
  /** Durable transcript turns, ascending by sequence. */
  turns: ParentTranscriptTurn[];
  /** Runtime messages not yet flushed to the durable store, merged by identity. */
  pendingRuntimeTurns: ParentTranscriptTurn[];
  /** Newest durable sequence, used for revisioning. */
  newestSequence: number;
}

export class ParentUnavailableError extends Error {
  readonly code = 'parent-unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'ParentUnavailableError';
  }
}

export interface SideChatParentResolverDeps {
  ledger: ConversationLedgerService;
  chatStore: ChatStore;
  instanceManager: InstanceManager;
  /** Optional: load an archived conversation's messages by history entry id. */
  loadArchiveMessages?: (entryId: string) => Promise<OutputMessage[] | null>;
  /** Optional: resolve a history entry id from a historyThreadId. */
  findArchiveEntryId?: (historyThreadId: string) => string | null;
}

/**
 * Resolves a {@link SideChatParentRef} to the transcript source that actually
 * owns the parent's content.
 *
 * `historyThreadId` is deliberately NOT assumed to be a ledger conversation id.
 * Chat-backed runtimes reuse the chat's ledger thread id as their
 * `historyThreadId`, but standalone instances carry their own stable thread id
 * whose transcript lives in a live runtime buffer and/or a history archive.
 * Each source is therefore resolved through its actual owner, in a fixed order,
 * and the first hit wins.
 */
export class SideChatParentResolver {
  constructor(private readonly deps: SideChatParentResolverDeps) {}

  async resolve(parent: SideChatParentRef): Promise<ResolvedParentSource> {
    if (parent.kind === 'chat') {
      return this.resolveChatParent(parent.chatId);
    }
    return this.resolveSessionParent(parent);
  }

  private async resolveChatParent(chatId: string): Promise<ResolvedParentSource> {
    const chat = this.deps.chatStore.get(chatId);
    if (!chat) {
      throw new ParentUnavailableError(`Parent chat ${chatId} no longer exists`);
    }
    const thread = await this.deps.ledger.getThread(chat.ledgerThreadId);
    if (!thread) {
      throw new ParentUnavailableError(
        `Parent chat ${chatId} has no readable transcript`,
      );
    }
    const conversation = await this.deps.ledger.getRecentConversation(
      chat.ledgerThreadId,
      1000,
    );
    const checkpoint = await this.deps.ledger.getLatestCheckpoint(chat.ledgerThreadId);
    const instance = chat.currentInstanceId
      ? this.deps.instanceManager.getInstance(chat.currentInstanceId)
      : null;
    const pendingRuntimeTurns = instance
      ? outputMessagesToTurns(instance.outputBuffer, conversation.messages.length)
      : [];
    const turns = conversation.messages.map(recordToTurn);
    return {
      parent: { kind: 'chat', chatId },
      title: chat.name,
      workspacePath: chat.currentCwd,
      originNodeId: instance?.workerNodeId ?? null,
      status: instance?.status ?? null,
      sourceKind: 'chat-ledger',
      checkpoint,
      turns,
      pendingRuntimeTurns,
      newestSequence: turns[turns.length - 1]?.sequence ?? 0,
    };
  }

  private async resolveSessionParent(
    parent: Extract<SideChatParentRef, { kind: 'session' }>,
  ): Promise<ResolvedParentSource> {
    const historyThreadId = parent.historyThreadId;

    // 1. Chat-backed runtime: the chat's ledger thread IS the stable identity.
    const owningChat = this.deps.chatStore.getByLedgerThreadId(historyThreadId);
    if (owningChat) {
      const source = await this.resolveChatParent(owningChat.id);
      return { ...source, parent, originNodeId: parent.originNodeId ?? source.originNodeId };
    }

    // 2. Direct ledger thread (imported or provider-native conversation).
    const thread = await this.deps.ledger.getThread(historyThreadId);
    if (thread) {
      const conversation = await this.deps.ledger.getRecentConversation(historyThreadId, 1000);
      const checkpoint = await this.deps.ledger.getLatestCheckpoint(historyThreadId);
      const turns = conversation.messages.map(recordToTurn);
      return {
        parent,
        title: thread.title ?? 'Session',
        workspacePath: thread.workspacePath,
        originNodeId: parent.originNodeId,
        status: null,
        sourceKind: 'session-ledger',
        checkpoint,
        turns,
        pendingRuntimeTurns: [],
        newestSequence: turns[turns.length - 1]?.sequence ?? 0,
      };
    }

    // 3. Live instance carrying this history thread identity.
    const live = this.findLiveInstance(historyThreadId);
    if (live) {
      const turns = outputMessagesToTurns(live.outputBuffer, 0);
      return {
        parent,
        title: live.displayName,
        workspacePath: live.workingDirectory,
        originNodeId: live.workerNodeId ?? parent.originNodeId,
        status: live.status,
        sourceKind: 'session-runtime',
        checkpoint: null,
        turns: [],
        pendingRuntimeTurns: turns,
        newestSequence: turns[turns.length - 1]?.sequence ?? 0,
      };
    }

    // 4. History archive entry for a terminated session.
    const archive = await this.resolveArchive(historyThreadId, parent);
    if (archive) {
      return archive;
    }

    throw new ParentUnavailableError(
      `Parent session ${historyThreadId} could not be resolved to any transcript owner`,
    );
  }

  private findLiveInstance(historyThreadId: string): Instance | null {
    for (const instance of this.deps.instanceManager.getAllInstances()) {
      if (instance.historyThreadId === historyThreadId && instance.status !== 'terminated') {
        return instance;
      }
    }
    return null;
  }

  private async resolveArchive(
    historyThreadId: string,
    parent: Extract<SideChatParentRef, { kind: 'session' }>,
  ): Promise<ResolvedParentSource | null> {
    if (!this.deps.findArchiveEntryId || !this.deps.loadArchiveMessages) {
      return null;
    }
    const entryId = this.deps.findArchiveEntryId(historyThreadId);
    if (!entryId) {
      return null;
    }
    const messages = await this.deps.loadArchiveMessages(entryId);
    if (!messages) {
      return null;
    }
    const turns = outputMessagesToTurns(messages, 0);
    return {
      parent,
      title: 'Archived session',
      workspacePath: null,
      originNodeId: parent.originNodeId,
      status: null,
      sourceKind: 'session-archive',
      checkpoint: null,
      turns,
      pendingRuntimeTurns: [],
      newestSequence: turns[turns.length - 1]?.sequence ?? 0,
    };
  }
}

function recordToTurn(record: {
  role: string;
  content: string;
  sequence: number;
  createdAt: number;
  phase: string | null;
}): ParentTranscriptTurn {
  const role = record.role === 'user' || record.role === 'assistant' ? record.role : 'system';
  return {
    role,
    content: record.content,
    sequence: record.sequence,
    createdAt: record.createdAt,
    phase: record.phase,
  };
}

/**
 * Project runtime `OutputMessage`s into normalized turns. Runtime messages are
 * merged by identity against the durable turns so content pending a ledger
 * flush can be included without duplicating what already persisted. Sequence
 * numbers continue past `existingCount` so ordering stays stable.
 */
function outputMessagesToTurns(
  messages: readonly OutputMessage[],
  existingCount: number,
): ParentTranscriptTurn[] {
  const turns: ParentTranscriptTurn[] = [];
  let sequence = existingCount;
  for (const message of messages) {
    if (message.type !== 'user' && message.type !== 'assistant') {
      continue;
    }
    const content = String(message.content ?? '').trim();
    if (!content) {
      continue;
    }
    sequence += 1;
    turns.push({
      role: message.type === 'user' ? 'user' : 'assistant',
      content,
      sequence,
      createdAt: message.timestamp,
      phase: null,
    });
  }
  return turns;
}

/**
 * Merge durable turns with runtime turns pending flush, de-duplicating by
 * role+content identity so a message already persisted (and now re-appearing
 * from the runtime buffer) is not counted twice. Two genuinely distinct turns
 * with the same content in one merge batch are treated as the same pending
 * flush copy — which is the correct behavior for this dedup's purpose.
 */
export function mergePendingRuntimeTurns(
  durable: readonly ParentTranscriptTurn[],
  pending: readonly ParentTranscriptTurn[],
): ParentTranscriptTurn[] {
  if (pending.length === 0) {
    return [...durable];
  }
  const identity = (turn: ParentTranscriptTurn) => `${turn.role}:${turn.content}`;
  const seen = new Set(durable.map(identity));
  const merged = [...durable];
  for (const turn of pending) {
    const key = identity(turn);
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(turn);
    }
  }
  merged.sort((a, b) => a.sequence - b.sequence || a.createdAt - b.createdAt);
  return merged;
}
