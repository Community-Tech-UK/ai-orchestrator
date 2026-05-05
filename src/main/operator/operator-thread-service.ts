import type { ConversationLedgerConversation } from '../../shared/types/conversation-ledger.types';
import {
  getConversationLedgerService,
  INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID,
  type ConversationLedgerService,
} from '../conversation-ledger';
import { getLogger } from '../logging/logger';
import { getOperatorEngine } from './operator-engine';

const logger = getLogger('OperatorThreadService');

interface OperatorEngineLike {
  handleUserMessage(input: { threadId: string; sourceMessageId: string; text: string }): Promise<unknown>;
}

const GLOBAL_OPERATOR_METADATA = {
  scope: 'global',
  operatorThreadKind: 'root',
} as const;

export interface OperatorThreadServiceConfig {
  ledger?: ConversationLedgerService;
  engine?: OperatorEngineLike | null;
}

export interface OperatorSendMessageInput {
  text: string;
  metadata?: Record<string, unknown>;
}

export class OperatorThreadService {
  private static instance: OperatorThreadService | null = null;
  private readonly ledger: ConversationLedgerService;
  private readonly engine: OperatorEngineLike | null;

  static getInstance(config?: OperatorThreadServiceConfig): OperatorThreadService {
    this.instance ??= new OperatorThreadService(config);
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  constructor(config: OperatorThreadServiceConfig = {}) {
    this.ledger = config.ledger ?? getConversationLedgerService();
    this.engine = config.engine === undefined ? getOperatorEngine() : config.engine;
  }

  async getThread(): Promise<ConversationLedgerConversation> {
    const existing = this.findExistingThread();
    if (existing) {
      return this.ledger.getConversation(existing.id);
    }

    const thread = await this.ledger.startConversation({
      provider: 'orchestrator',
      workspacePath: null,
      title: 'Orchestrator',
      metadata: GLOBAL_OPERATOR_METADATA,
    });
    return this.ledger.getConversation(thread.id);
  }

  async sendMessage(input: OperatorSendMessageInput): Promise<ConversationLedgerConversation> {
    const text = input.text.trim();
    if (!text) {
      throw new Error('Operator message text is required');
    }

    const conversation = await this.getThread();
    await this.ledger.sendTurn(conversation.thread.id, {
      text,
      metadata: {
        ...GLOBAL_OPERATOR_METADATA,
        ...(input.metadata ?? {}),
      },
    });
    const updated = this.ledger.getConversation(conversation.thread.id);
    const sourceMessage = [...updated.messages].reverse().find((message) =>
      message.role === 'user' && message.content === text
    );
    if (this.engine && sourceMessage) {
      void this.engine.handleUserMessage({
        threadId: updated.thread.id,
        sourceMessageId: sourceMessage.id,
        text,
      }).catch((error) => {
        logger.warn('Operator engine failed to handle message', {
          threadId: updated.thread.id,
          messageId: sourceMessage.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
    return updated;
  }

  private findExistingThread() {
    return this.ledger.listConversations({
      provider: 'orchestrator',
      sourceKind: 'orchestrator',
      limit: 50,
    }).find((thread) =>
      thread.nativeThreadId === INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID
      || (
        thread.metadata['scope'] === GLOBAL_OPERATOR_METADATA.scope
        && thread.metadata['operatorThreadKind'] === GLOBAL_OPERATOR_METADATA.operatorThreadKind
      )
    );
  }
}

export function getOperatorThreadService(config?: OperatorThreadServiceConfig): OperatorThreadService {
  return OperatorThreadService.getInstance(config);
}
