import type {
  ConversationLedgerConversation,
  ConversationThreadRecord,
} from '../../shared/types/conversation-ledger.types';
import type {
  OperatorProjectSummary,
  OperatorRunSummary,
  OperatorSendMessageRequest,
  OperatorSendMessageResult,
  OperatorThreadResult,
} from '../../shared/types/operator.types';
import {
  GLOBAL_ORCHESTRATOR_NATIVE_THREAD_ID,
  ConversationLedgerService,
  getConversationLedgerService,
} from '../conversation-ledger';

export interface OperatorEngineConfig {
  ledger?: ConversationLedgerService;
}

export class OperatorEngine {
  private static instance: OperatorEngine | null = null;
  private readonly ledger: ConversationLedgerService;

  static getInstance(config: OperatorEngineConfig = {}): OperatorEngine {
    this.instance ??= new OperatorEngine(config);
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  constructor(config: OperatorEngineConfig = {}) {
    this.ledger = config.ledger ?? getConversationLedgerService();
  }

  async getThread(): Promise<OperatorThreadResult> {
    const thread = await this.ensureGlobalThread();
    return {
      conversation: this.ledger.getConversation(thread.id),
      runs: this.listRuns(),
      projects: this.listProjects(),
    };
  }

  async sendMessage(request: OperatorSendMessageRequest): Promise<OperatorSendMessageResult> {
    const text = request.text.trim();
    const thread = await this.ensureGlobalThread();
    await this.ledger.sendTurn(thread.id, {
      text,
      metadata: request.metadata,
    });
    return {
      conversation: this.ledger.getConversation(thread.id),
      run: null,
      runs: this.listRuns(),
      projects: this.listProjects(),
    };
  }

  listRuns(): OperatorRunSummary[] {
    return [];
  }

  getRun(_runId: string): OperatorRunSummary | null {
    return null;
  }

  listProjects(): OperatorProjectSummary[] {
    return [];
  }

  async rescanProjects(_roots?: string[]): Promise<OperatorProjectSummary[]> {
    return this.listProjects();
  }

  async cancelRun(_runId: string): Promise<OperatorThreadResult> {
    return this.getThread();
  }

  async retryRun(_runId: string): Promise<OperatorSendMessageResult> {
    const result = await this.getThread();
    return {
      ...result,
      run: null,
    };
  }

  private async ensureGlobalThread(): Promise<ConversationThreadRecord> {
    const existing = this.ledger.listConversations({
      provider: 'orchestrator',
      sourceKind: 'orchestrator',
      limit: 25,
    }).find((thread) => thread.nativeThreadId === GLOBAL_ORCHESTRATOR_NATIVE_THREAD_ID);
    if (existing) {
      return existing;
    }

    return this.ledger.startConversation({
      provider: 'orchestrator',
      workspacePath: null,
      title: 'Orchestrator',
      metadata: { operatorThreadKind: 'global' },
    });
  }
}

export function getOperatorEngine(config?: OperatorEngineConfig): OperatorEngine {
  return OperatorEngine.getInstance(config);
}

export type OperatorConversation = ConversationLedgerConversation;
