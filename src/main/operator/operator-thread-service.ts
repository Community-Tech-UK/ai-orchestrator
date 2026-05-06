import type { ConversationLedgerConversation } from '../../shared/types/conversation-ledger.types';
import type { OperatorRunGraph } from '../../shared/types/operator.types';
import {
  getConversationLedgerService,
  INTERNAL_ORCHESTRATOR_NATIVE_THREAD_ID,
  type ConversationLedgerService,
} from '../conversation-ledger';
import { getLogger } from '../logging/logger';
import { getOperatorEngine } from './operator-engine';

const logger = getLogger('OperatorThreadService');

interface OperatorEngineLike {
  handleUserMessage(input: { threadId: string; sourceMessageId: string; text: string }): Promise<OperatorRunGraph | null>;
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

export interface OperatorRecoveryNoticeInput {
  runId: string;
  title: string;
  status: string;
  message: string;
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
      this.appendAssistantMessage(
        updated.thread.id,
        `${sourceMessage.id}:operator-ack`,
        buildAcknowledgement(text),
        {
          kind: 'operator-ack',
          sourceMessageId: sourceMessage.id,
        },
      );
    }
    if (this.engine && sourceMessage) {
      void Promise.resolve().then(() => this.engine!.handleUserMessage({
        threadId: updated.thread.id,
        sourceMessageId: sourceMessage.id,
        text,
      })).then((graph) => {
        if (!graph) {
          return;
        }
        this.appendAssistantMessage(
          updated.thread.id,
          `${sourceMessage.id}:operator-result:${graph.run.id}`,
          buildRunResultMessage(graph),
          {
            kind: 'operator-result',
            sourceMessageId: sourceMessage.id,
            operatorRunId: graph.run.id,
            status: graph.run.status,
          },
        );
      }).catch((error) => {
        logger.warn('Operator engine failed to handle message', {
          threadId: updated.thread.id,
          messageId: sourceMessage.id,
          error: error instanceof Error ? error.message : String(error),
        });
        this.appendAssistantMessage(
          updated.thread.id,
          `${sourceMessage.id}:operator-error`,
          `I could not complete that Operator request: ${error instanceof Error ? error.message : String(error)}`,
          {
            kind: 'operator-error',
            sourceMessageId: sourceMessage.id,
          },
        );
      });
    }
    return this.ledger.getConversation(conversation.thread.id);
  }

  appendRecoveryNotice(input: OperatorRecoveryNoticeInput): ConversationLedgerConversation {
    const existing = this.findExistingThread();
    if (!existing) {
      throw new Error('Operator thread does not exist');
    }
    this.appendAssistantMessage(
      existing.id,
      `operator-recovery:${input.runId}:${Date.now()}`,
      `Recovered run ${input.status}: ${input.title}. ${input.message}`,
      {
        kind: 'operator-recovery',
        operatorRunId: input.runId,
        status: input.status,
      },
    );
    return this.ledger.getConversation(existing.id);
  }

  private appendAssistantMessage(
    threadId: string,
    nativeMessageId: string,
    content: string,
    metadata: Record<string, unknown>,
  ): void {
    this.ledger.appendMessage(threadId, {
      nativeMessageId,
      nativeTurnId: nativeMessageId,
      role: 'assistant',
      phase: 'final',
      content,
      createdAt: Date.now(),
      rawJson: { metadata },
    });
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

function buildAcknowledgement(text: string): string {
  if (/^\s*(hi|hello|hey)\s*[!.?]*\s*$/i.test(text)) {
    return 'Hi. I am here. Ask me to work in a project, audit a project, or run a workspace operation.';
  }
  if (/\bpull\b/i.test(text) && /\b(repos?|repositories)\b/i.test(text)) {
    return 'I received that. I will start a repository operation if the request is routable, and progress will appear in the Orchestrator run list.';
  }
  if (/\bp(?:roject|lroject)s?\b/i.test(text)) {
    return 'I received that. I will try to resolve the project and start the right Operator run; progress will appear above when work starts.';
  }
  return 'I received that, but I may not know how to route it yet. Name a project or ask for a workspace operation to start an Operator run.';
}

function buildRunResultMessage(graph: OperatorRunGraph): string {
  const synthesisSummary = readSynthesisSummary(graph);
  if (synthesisSummary) {
    return synthesisSummary;
  }

  if (graph.run.status === 'completed') {
    return `Completed: ${graph.run.title}.`;
  }
  if (graph.run.status === 'cancelled') {
    return `Cancelled: ${graph.run.title}.`;
  }
  if (graph.run.status === 'blocked') {
    return `Blocked: ${graph.run.title}. ${graph.run.error ?? 'See the run details for the blocker.'}`;
  }
  if (graph.run.status === 'failed') {
    return `Failed: ${graph.run.title}. ${graph.run.error ?? 'See the run details for the failure.'}`;
  }
  return `Operator run ${graph.run.status}: ${graph.run.title}.`;
}

function readSynthesisSummary(graph: OperatorRunGraph): string | null {
  const synthesis = graph.run.resultJson?.['synthesis'];
  if (!synthesis || typeof synthesis !== 'object' || Array.isArray(synthesis)) {
    return null;
  }
  const summary = (synthesis as Record<string, unknown>)['summaryMarkdown'];
  return typeof summary === 'string' && summary.trim() ? summary : null;
}
