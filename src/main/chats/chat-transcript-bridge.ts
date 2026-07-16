import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type {
  ConversationMessageRecord,
  ConversationRole,
} from '../../shared/types/conversation-ledger.types';
import type { ChatEvent, ChatRecord } from '../../shared/types/chat.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { OutputMessage } from '../../shared/types/instance.types';
import { getConversationLedgerService, type ConversationLedgerService } from '../conversation-ledger';
import { toOutputMessageFromProviderEnvelope } from '../providers/provider-output-event';
import { getLogger } from '../logging/logger';
import { EvidenceConversationResolver } from '../context-evidence/evidence-conversation-resolver';
import { ChatStore } from './chat-store';

const logger = getLogger('ChatTranscriptBridge');

export interface ChatTranscriptBridgeConfig {
  ledger?: ConversationLedgerService;
  chatStore: ChatStore;
  instanceManager: InstanceManager;
  eventBus: EventEmitter;
  /**
   * How long settled provider events are batched before the durable, off-thread
   * flush. Defaults to 150ms. Lower bounds the at-risk-on-crash window; higher
   * coalesces more aggressively.
   */
  flushIntervalMs?: number;
}

/** A message awaiting persistence — the sequence and id are assigned by the
 *  ledger worker inside the flush transaction, never on the event hot path. */
type QueuedMessage = Omit<ConversationMessageRecord, 'id' | 'threadId' | 'sequence'>;

const DEFAULT_FLUSH_INTERVAL_MS = 150;
/** Flush immediately once a single instance's queue reaches this, to bound
 *  latency and memory under a burst rather than waiting for the timer. */
const FLUSH_WHEN_PENDING_REACHES = 200;
/** Hard cap on a single instance's pending queue. If the worker is wedged long
 *  enough to exceed this, the oldest queued messages are dropped (logged). */
const MAX_PENDING_PER_INSTANCE = 2_000;

/**
 * Bridges normalized provider events into the conversation ledger as a chat
 * transcript.
 *
 * The event handler (`onProviderEvent`) does ZERO synchronous SQLite: it builds
 * the message in memory and queues it. A trailing, coalesced flush resolves the
 * chat, performs ONE off-thread batched ledger write per thread (through the
 * conversation worker), coalesces the operator-db `lastActiveAt` touch, and
 * broadcasts the appended records to the renderer. This removes the per-event
 * write amplification that was the dominant streaming-time main-thread stall.
 *
 * On a flush failure (e.g. the worker is restarting) the batch is re-queued and
 * retried on the next flush, so nothing is lost while the worker recovers.
 */
export class ChatTranscriptBridge {
  private readonly ledger: ConversationLedgerService;
  private readonly chatStore: ChatStore;
  private readonly instanceManager: InstanceManager;
  private readonly eventBus: EventEmitter;
  private readonly conversationResolver: EvidenceConversationResolver;
  private readonly flushIntervalMs: number;
  private started = false;
  private readonly instanceToChat = new Map<string, string>();

  // ── Deferred-write batching (off the event hot path) ──────────────────────────
  private readonly pendingByInstance = new Map<string, QueuedMessage[]>();
  private readonly pendingLastActiveByInstance = new Map<string, number>();
  private readonly pendingUnlinkInstances = new Set<string>();
  private readonly pendingTeardownFlushes = new Set<Promise<void>>();
  private flushTimer: NodeJS.Timeout | null = null;
  private flushPromise: Promise<void> | null = null;
  private stopped = false;

  constructor(config: ChatTranscriptBridgeConfig) {
    this.ledger = config.ledger ?? getConversationLedgerService();
    this.chatStore = config.chatStore;
    this.instanceManager = config.instanceManager;
    this.eventBus = config.eventBus;
    this.conversationResolver = new EvidenceConversationResolver({
      ledger: this.ledger,
      chatStore: this.chatStore,
    });
    this.flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  }

  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;
    this.instanceManager.on('provider:normalized-event', (envelope) => {
      this.onProviderEvent(envelope as ProviderRuntimeEventEnvelope);
    });
    this.instanceManager.on('instance:removed', (instanceId) => {
      if (typeof instanceId === 'string') {
        // Persist this instance's tail before forgetting the mapping.
        this.trackPendingTeardown(this.flushAndUnlink(instanceId));
      }
    });
  }

  link(chatId: string, instanceId: string): void {
    this.instanceToChat.set(instanceId, chatId);
  }

  unlink(instanceId: string): void {
    this.finalizeUnlink(instanceId);
  }

  async flushAndUnlink(instanceId: string): Promise<void> {
    this.pendingUnlinkInstances.add(instanceId);
    if (!this.pendingByInstance.has(instanceId) && !this.flushPromise) {
      this.finalizeUnlink(instanceId);
      return;
    }
    await this.flush();
    if (this.pendingUnlinkInstances.has(instanceId) && !this.pendingByInstance.has(instanceId)) {
      this.finalizeUnlink(instanceId);
    }
  }

  async drainForShutdown(timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.flushPromise) {
        await this.flushPromise;
      } else if (this.pendingByInstance.size > 0) {
        await this.flush();
      }
      if (this.pendingByInstance.size === 0 && this.pendingTeardownFlushes.size === 0) {
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    if (this.pendingByInstance.size > 0 || this.pendingTeardownFlushes.size > 0) {
      logger.warn('Timed out draining chat transcript bridge during shutdown', {
        pendingInstances: this.pendingByInstance.size,
        pendingTeardowns: this.pendingTeardownFlushes.size,
      });
    }
  }

  /**
   * Stop bridging: cancel any pending flush and ignore further events. Called on
   * teardown/shutdown. Any messages queued but not yet flushed are dropped (the
   * renderer already received them as live provider events); flush before
   * stopping if durability of the tail matters.
   */
  stop(): void {
    this.stopped = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private onProviderEvent(envelope: ProviderRuntimeEventEnvelope): void {
    if (this.stopped) {
      return;
    }
    try {
      const message = this.messageFromEnvelope(envelope);
      if (!message) {
        return;
      }
      // Queue in memory only — no chat resolution, no SQLite. The flush resolves
      // the chat and persists off the main thread.
      const queue = this.pendingByInstance.get(envelope.instanceId);
      if (queue) {
        queue.push(message);
      } else {
        this.pendingByInstance.set(envelope.instanceId, [message]);
      }
      this.pendingLastActiveByInstance.set(envelope.instanceId, Date.now());

      const queued = this.pendingByInstance.get(envelope.instanceId)!;
      if (queued.length >= FLUSH_WHEN_PENDING_REACHES) {
        void this.flush();
      } else {
        this.scheduleFlush();
      }
    } catch (error) {
      logger.warn('Failed to queue chat transcript event', {
        instanceId: envelope.instanceId,
        eventKind: envelope.event.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.stopped) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushIntervalMs);
    // Don't keep the event loop alive solely for a pending flush.
    this.flushTimer.unref?.();
  }

  /**
   * Drain queued transcript writes: one off-thread batched ledger write per
   * thread plus a coalesced operator-db touch. Safe to call any time (timer,
   * instance teardown, shutdown). Serialized via `flushPromise` so overlapping
   * calls don't double-write; any items that arrive (or are re-queued) during a
   * drain trigger a follow-up flush.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.stopped) {
      return;
    }
    if (this.flushPromise) {
      return this.flushPromise;
    }
    this.flushPromise = this.runFlush().finally(() => {
      this.flushPromise = null;
      if (this.pendingByInstance.size > 0) {
        this.scheduleFlush();
      }
    });
    return this.flushPromise;
  }

  private async runFlush(): Promise<void> {
    const batches = this.drainPending();
    for (const [instanceId, entry] of batches) {
      await this.flushInstance(instanceId, entry.messages, entry.lastActiveAt);
    }
  }

  private drainPending(): [string, { messages: QueuedMessage[]; lastActiveAt: number }][] {
    const entries: [string, { messages: QueuedMessage[]; lastActiveAt: number }][] = [];
    for (const [instanceId, messages] of this.pendingByInstance) {
      entries.push([
        instanceId,
        { messages, lastActiveAt: this.pendingLastActiveByInstance.get(instanceId) ?? Date.now() },
      ]);
    }
    this.pendingByInstance.clear();
    this.pendingLastActiveByInstance.clear();
    return entries;
  }

  private async flushInstance(
    instanceId: string,
    messages: QueuedMessage[],
    lastActiveAt: number,
  ): Promise<void> {
    if (messages.length === 0) {
      return;
    }
    let chat: ChatRecord | null;
    try {
      const chatId = this.resolveChatId(instanceId);
      if (!chatId) {
        // No chat linked to this instance — drop its transcript events.
        this.finalizeUnlink(instanceId);
        return;
      }
      chat = this.chatStore.get(chatId);
    } catch (error) {
      // operator-db read failed (e.g. closed during teardown). Drop rather than
      // spin — this connection doesn't transiently recover the way the worker does.
      logger.warn('Failed to resolve chat for transcript flush; dropping batch', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (!chat) {
      this.finalizeUnlink(instanceId);
      return;
    }

    try {
      const instance = this.instanceManager.getInstance(instanceId);
      const mode = instance?.contextEvidence?.mode ?? 'off';
      let conversationId = chat.ledgerThreadId;
      if (mode !== 'off') {
        const ownership = await this.conversationResolver.resolve(
          instance ?? {
            id: instanceId,
            historyThreadId: '',
            provider: chat.provider ?? 'unknown',
            workingDirectory: chat.currentCwd ?? undefined,
          },
          { mode },
        );
        if (ownership.status === 'unresolved') {
          if (instance) {
            const previousFailures = instance.contextEvidence?.captureFailureCount ?? 0;
            instance.contextEvidence = {
              mode,
              captureFailureCount: previousFailures + ownership.metric.increment,
              lastCaptureFailure: {
                code: ownership.metric.reason,
                reason: ownership.reason,
                disposition: ownership.disposition,
                occurredAt: Date.now(),
              },
            };
          }
          logger.warn('Chat transcript ownership could not be resolved; dropping batch', {
            chatId: chat.id,
            instanceId,
            reason: ownership.reason,
            disposition: ownership.disposition,
          });
          return;
        }
        conversationId = ownership.conversationId;
      }
      const records = await this.ledger.appendMessagesReturningRecords(conversationId, messages);
      let updated = chat;
      try {
        updated = this.chatStore.update(chat.id, { lastActiveAt });
      } catch (error) {
        logger.warn('Failed to flush chat lastActiveAt', {
          chatId: chat.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (records.length > 0) {
        this.emitTranscriptAppended(updated, records);
      }
      if (this.pendingUnlinkInstances.has(instanceId) && !this.pendingByInstance.has(instanceId)) {
        this.finalizeUnlink(instanceId);
      }
    } catch (error) {
      // The worker is likely restarting; re-queue and retry on the next flush.
      logger.warn('Failed to flush transcript batch to ledger; will retry', {
        chatId: chat.id,
        instanceId,
        messageCount: messages.length,
        error: error instanceof Error ? error.message : String(error),
      });
      this.requeue(instanceId, messages, lastActiveAt);
    }
  }

  private finalizeUnlink(instanceId: string): void {
    this.pendingUnlinkInstances.delete(instanceId);
    this.pendingByInstance.delete(instanceId);
    this.pendingLastActiveByInstance.delete(instanceId);
    this.instanceToChat.delete(instanceId);
  }

  private trackPendingTeardown(promise: Promise<void>): void {
    this.pendingTeardownFlushes.add(promise);
    void promise.finally(() => {
      this.pendingTeardownFlushes.delete(promise);
    });
  }

  private resolveChatId(instanceId: string): string | null {
    const cached = this.instanceToChat.get(instanceId);
    if (cached) {
      return cached;
    }
    const resolved = this.chatStore.getByInstanceId(instanceId)?.id ?? null;
    if (resolved) {
      this.instanceToChat.set(instanceId, resolved);
    }
    return resolved;
  }

  private requeue(instanceId: string, messages: QueuedMessage[], lastActiveAt: number): void {
    const existing = this.pendingByInstance.get(instanceId) ?? [];
    // Failed (older) messages go in front to preserve ascending order.
    const combined = [...messages, ...existing];
    const bounded =
      combined.length > MAX_PENDING_PER_INSTANCE
        ? combined.slice(combined.length - MAX_PENDING_PER_INSTANCE)
        : combined;
    if (bounded.length < combined.length) {
      logger.warn('Transcript queue exceeded cap; dropped oldest pending messages', {
        instanceId,
        dropped: combined.length - bounded.length,
      });
    }
    this.pendingByInstance.set(instanceId, bounded);
    const priorLastActive = this.pendingLastActiveByInstance.get(instanceId) ?? 0;
    this.pendingLastActiveByInstance.set(instanceId, Math.max(priorLastActive, lastActiveAt));
  }

  private messageFromEnvelope(
    envelope: ProviderRuntimeEventEnvelope
  ): QueuedMessage | null {
    const outputMessage = toOutputMessageFromProviderEnvelope(envelope);
    if (outputMessage) {
      if (outputMessage.type === 'user') {
        return null;
      }
      if (outputMessage.metadata?.['streaming'] === true) {
        return null;
      }
      return this.messageFromOutput(envelope, outputMessage);
    }

    if (envelope.event.kind === 'tool_use') {
      return {
        nativeMessageId: `chat-tool-use:${envelope.eventId}`,
        nativeTurnId: envelope.turnId ?? envelope.event.toolUseId ?? envelope.eventId,
        role: 'tool',
        phase: 'tool_call',
        content: `${envelope.event.toolName}(${JSON.stringify(envelope.event.input ?? {})})`,
        createdAt: envelope.timestamp,
        tokenInput: null,
        tokenOutput: null,
        rawRef: null,
        rawJson: {
          metadata: {
            kind: 'tool_call',
            toolName: envelope.event.toolName,
            toolUseId: envelope.event.toolUseId,
            instanceId: envelope.instanceId,
          },
        },
        sourceChecksum: null,
      };
    }

    if (envelope.event.kind === 'tool_result') {
      return {
        nativeMessageId: `chat-tool-result:${envelope.eventId}`,
        nativeTurnId: envelope.turnId ?? envelope.event.toolUseId ?? envelope.eventId,
        role: 'tool',
        phase: 'tool_result',
        content: envelope.event.output ?? envelope.event.error ?? '',
        createdAt: envelope.timestamp,
        tokenInput: null,
        tokenOutput: null,
        rawRef: null,
        rawJson: {
          metadata: {
            kind: 'tool_result',
            toolName: envelope.event.toolName,
            toolUseId: envelope.event.toolUseId,
            success: envelope.event.success,
            instanceId: envelope.instanceId,
          },
        },
        sourceChecksum: null,
      };
    }

    if (envelope.event.kind === 'error') {
      return {
        nativeMessageId: `chat-error:${envelope.eventId}`,
        nativeTurnId: envelope.turnId ?? envelope.eventId,
        role: 'assistant',
        phase: 'error',
        content: envelope.event.message,
        createdAt: envelope.timestamp,
        tokenInput: null,
        tokenOutput: null,
        rawRef: null,
        rawJson: {
          metadata: {
            kind: 'error',
            recoverable: envelope.event.recoverable,
            instanceId: envelope.instanceId,
          },
        },
        sourceChecksum: null,
      };
    }

    return null;
  }

  private messageFromOutput(
    envelope: ProviderRuntimeEventEnvelope,
    output: OutputMessage,
  ): QueuedMessage | null {
    const role = outputTypeToRole(output.type);
    if (!role) {
      return null;
    }
    return {
      nativeMessageId: output.id || `chat-output:${envelope.eventId}`,
      nativeTurnId: envelope.turnId ?? output.metadata?.['turnId'] as string | undefined ?? envelope.eventId,
      role,
      phase: output.type === 'error' ? 'error' : output.metadata?.['phase'] as string | undefined ?? null,
      content: output.content,
      createdAt: output.timestamp || envelope.timestamp,
      tokenInput: null,
      tokenOutput: null,
      rawRef: null,
      rawJson: {
        metadata: {
          ...(output.metadata ?? {}),
          kind: output.type,
          instanceId: envelope.instanceId,
        },
        attachments: output.attachments,
        thinking: output.thinking,
        thinkingExtracted: output.thinkingExtracted,
      },
      sourceChecksum: null,
    };
  }

  private emitTranscriptAppended(
    chat: ChatRecord,
    messages: ConversationMessageRecord[],
  ): void {
    const currentInstance = chat.currentInstanceId
      ? this.instanceManager.getInstance(chat.currentInstanceId) ?? null
      : null;
    const event: ChatEvent = {
      type: 'transcript-appended',
      chatId: chat.id,
      chat,
      messages,
      currentInstance,
    };
    this.eventBus.emit('chat:event', event);
  }
}

export function createUserLedgerMessage(input: {
  text: string;
  chatId: string;
  attachments?: OutputMessage['attachments'];
}): Omit<ConversationMessageRecord, 'id' | 'threadId' | 'sequence'> {
  const turnId = `chat-user-turn:${randomUUID()}`;
  return {
    nativeMessageId: `${turnId}:user`,
    nativeTurnId: turnId,
    role: 'user',
    phase: null,
    content: input.text,
    createdAt: Date.now(),
    tokenInput: null,
    tokenOutput: null,
    rawRef: null,
    rawJson: {
      metadata: {
        fromBridge: true,
        chatId: input.chatId,
      },
      attachments: input.attachments,
    },
    sourceChecksum: null,
  };
}

function outputTypeToRole(type: OutputMessage['type']): ConversationRole | null {
  switch (type) {
    case 'assistant':
      return 'assistant';
    case 'system':
      return 'system';
    case 'tool_use':
    case 'tool_result':
      return 'tool';
    case 'error':
      return 'assistant';
    case 'user':
      return null;
    default:
      return null;
  }
}
