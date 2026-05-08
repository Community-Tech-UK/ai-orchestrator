import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type {
  ConversationLedgerConversation,
  ConversationMessageRecord,
  ConversationRole,
} from '../../shared/types/conversation-ledger.types';
import type { ChatEvent, ChatRecord } from '../../shared/types/chat.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { OutputMessage } from '../../shared/types/instance.types';
import { getConversationLedgerService, type ConversationLedgerService } from '../conversation-ledger';
import { toOutputMessageFromProviderEnvelope } from '../providers/provider-output-event';
import { getLogger } from '../logging/logger';
import { ChatStore } from './chat-store';

const logger = getLogger('ChatTranscriptBridge');

export interface ChatTranscriptBridgeConfig {
  ledger?: ConversationLedgerService;
  chatStore: ChatStore;
  instanceManager: InstanceManager;
  eventBus: EventEmitter;
}

export class ChatTranscriptBridge {
  private readonly ledger: ConversationLedgerService;
  private readonly chatStore: ChatStore;
  private readonly instanceManager: InstanceManager;
  private readonly eventBus: EventEmitter;
  private started = false;
  private readonly instanceToChat = new Map<string, string>();

  constructor(config: ChatTranscriptBridgeConfig) {
    this.ledger = config.ledger ?? getConversationLedgerService();
    this.chatStore = config.chatStore;
    this.instanceManager = config.instanceManager;
    this.eventBus = config.eventBus;
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
        this.instanceToChat.delete(instanceId);
      }
    });
  }

  link(chatId: string, instanceId: string): void {
    this.instanceToChat.set(instanceId, chatId);
  }

  unlink(instanceId: string): void {
    this.instanceToChat.delete(instanceId);
  }

  private onProviderEvent(envelope: ProviderRuntimeEventEnvelope): void {
    const chatId = this.instanceToChat.get(envelope.instanceId)
      ?? this.chatStore.getByInstanceId(envelope.instanceId)?.id
      ?? null;
    if (!chatId) {
      return;
    }

    const chat = this.chatStore.get(chatId);
    if (!chat) {
      this.instanceToChat.delete(envelope.instanceId);
      return;
    }

    try {
      const message = this.messageFromEnvelope(envelope);
      if (!message) {
        return;
      }
      const conversation = this.ledger.appendMessage(chat.ledgerThreadId, message);
      const updated = this.chatStore.update(chat.id, { lastActiveAt: Date.now() });
      this.emitTranscriptUpdated(updated, conversation);
    } catch (error) {
      logger.warn('Failed to bridge chat transcript event', {
        chatId,
        instanceId: envelope.instanceId,
        eventKind: envelope.event.kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private messageFromEnvelope(
    envelope: ProviderRuntimeEventEnvelope
  ): Omit<ConversationMessageRecord, 'id' | 'threadId' | 'sequence'> | null {
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
  ): Omit<ConversationMessageRecord, 'id' | 'threadId' | 'sequence'> | null {
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

  private emitTranscriptUpdated(
    chat: ChatRecord,
    conversation: ConversationLedgerConversation,
  ): void {
    const currentInstance = chat.currentInstanceId
      ? this.instanceManager.getInstance(chat.currentInstanceId) ?? null
      : null;
    const event: ChatEvent = {
      type: 'transcript-updated',
      chatId: chat.id,
      detail: {
        chat,
        conversation,
        currentInstance,
      },
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
