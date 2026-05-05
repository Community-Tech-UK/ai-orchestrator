import { Injectable, computed, inject, signal } from '@angular/core';
import type { ConversationLedgerConversation } from '../../../../shared/types/conversation-ledger.types';
import type {
  OperatorProjectSummary,
  OperatorRunSummary,
  OperatorSendMessageResult,
  OperatorThreadResult,
} from '../../../../shared/types/operator.types';
import { OperatorIpcService } from '../services/ipc/operator-ipc.service';

@Injectable({ providedIn: 'root' })
export class OperatorStore {
  private ipc = inject(OperatorIpcService);

  private _conversation = signal<ConversationLedgerConversation | null>(null);
  private _runs = signal<OperatorRunSummary[]>([]);
  private _projects = signal<OperatorProjectSummary[]>([]);
  private _loading = signal(false);
  private _sending = signal(false);
  private _initialized = signal(false);
  private _error = signal<string | null>(null);

  conversation = this._conversation.asReadonly();
  thread = computed(() => this._conversation()?.thread ?? null);
  messages = computed(() => this._conversation()?.messages ?? []);
  runs = this._runs.asReadonly();
  projects = this._projects.asReadonly();
  loading = this._loading.asReadonly();
  sending = this._sending.asReadonly();
  initialized = this._initialized.asReadonly();
  error = this._error.asReadonly();
  messageCount = computed(() => this.messages().length);

  async initialize(): Promise<void> {
    if (this._initialized()) {
      return;
    }
    await this.refresh();
    this._initialized.set(true);
  }

  async refresh(): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    try {
      const response = await this.ipc.getThread();
      if (!response.success || !response.data) {
        this._error.set(response.error?.message ?? 'Failed to load operator thread');
        return;
      }
      this.applyThreadResult(response.data);
    } finally {
      this._loading.set(false);
    }
  }

  async sendMessage(text: string): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed || this._sending()) {
      return false;
    }

    this._sending.set(true);
    this._error.set(null);
    try {
      const response = await this.ipc.sendMessage({ text: trimmed });
      if (!response.success || !response.data) {
        this._error.set(response.error?.message ?? 'Failed to send operator message');
        return false;
      }
      this.applySendResult(response.data);
      this._initialized.set(true);
      return true;
    } finally {
      this._sending.set(false);
    }
  }

  private applyThreadResult(result: OperatorThreadResult): void {
    this._conversation.set(result.conversation);
    this._runs.set(result.runs);
    this._projects.set(result.projects);
  }

  private applySendResult(result: OperatorSendMessageResult): void {
    this._conversation.set(result.conversation);
    this._runs.set(result.runs);
    this._projects.set(result.projects);
  }
}
