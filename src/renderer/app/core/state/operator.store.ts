import { Injectable, computed, inject, signal } from '@angular/core';
import type { ConversationLedgerConversation } from '../../../../shared/types/conversation-ledger.types';
import type {
  OperatorProjectRecord,
  OperatorProjectRefreshOptions,
  OperatorRunEventNotification,
  OperatorRunRecord,
} from '../../../../shared/types/operator.types';
import { OperatorIpcService } from '../services/ipc/operator-ipc.service';

@Injectable({ providedIn: 'root' })
export class OperatorStore {
  private readonly ipc = inject(OperatorIpcService);
  private readonly _conversation = signal<ConversationLedgerConversation | null>(null);
  private readonly _selected = signal(false);
  private readonly _loading = signal(false);
  private readonly _sending = signal(false);
  private readonly _projectLoading = signal(false);
  private readonly _projects = signal<OperatorProjectRecord[]>([]);
  private readonly _runLoading = signal(false);
  private readonly _runs = signal<OperatorRunRecord[]>([]);
  private readonly _error = signal<string | null>(null);
  private initialized = false;
  private unsubscribeOperatorEvents: (() => void) | null = null;

  readonly conversation = this._conversation.asReadonly();
  readonly selected = this._selected.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly sending = this._sending.asReadonly();
  readonly projectLoading = this._projectLoading.asReadonly();
  readonly projects = this._projects.asReadonly();
  readonly runLoading = this._runLoading.asReadonly();
  readonly runs = this._runs.asReadonly();
  readonly error = this._error.asReadonly();
  readonly thread = computed(() => this._conversation()?.thread ?? null);
  readonly messages = computed(() => this._conversation()?.messages ?? []);

  async initialize(): Promise<void> {
    if (this.initialized || this._loading()) {
      return;
    }
    this.subscribeToOperatorEvents();
    await Promise.all([
      this.refresh(),
      this.loadProjects(),
      this.loadRuns(),
    ]);
    this.initialized = true;
  }

  async refresh(): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    try {
      const response = await this.ipc.getThread();
      if (response.success && response.data) {
        this._conversation.set(response.data);
        await this.loadRuns();
      } else {
        this._error.set(response.error?.message ?? 'Failed to load Orchestrator');
      }
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : 'Failed to load Orchestrator');
    } finally {
      this._loading.set(false);
    }
  }

  select(): void {
    this._selected.set(true);
    void this.initialize();
  }

  deselect(): void {
    this._selected.set(false);
  }

  async sendMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this._sending()) {
      return;
    }

    this._sending.set(true);
    this._error.set(null);
    try {
      const response = await this.ipc.sendMessage({ text: trimmed });
      if (response.success && response.data) {
        this._conversation.set(response.data);
        await this.loadRuns();
      } else {
        this._error.set(response.error?.message ?? 'Failed to send message');
      }
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : 'Failed to send message');
    } finally {
      this._sending.set(false);
    }
  }

  async loadProjects(): Promise<void> {
    this._projectLoading.set(true);
    try {
      const response = await this.ipc.listProjects();
      if (response.success && response.data) {
        this._projects.set(response.data);
      } else {
        this._error.set(response.error?.message ?? 'Failed to load projects');
      }
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : 'Failed to load projects');
    } finally {
      this._projectLoading.set(false);
    }
  }

  async loadRuns(): Promise<void> {
    this._runLoading.set(true);
    try {
      const response = await this.ipc.listRuns({
        threadId: this.thread()?.id,
        limit: 25,
      });
      if (response.success && response.data) {
        this._runs.set(response.data);
      } else {
        this._error.set(response.error?.message ?? 'Failed to load runs');
      }
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : 'Failed to load runs');
    } finally {
      this._runLoading.set(false);
    }
  }

  async rescanProjects(options: OperatorProjectRefreshOptions = {}): Promise<void> {
    if (this._projectLoading()) {
      return;
    }
    this._projectLoading.set(true);
    this._error.set(null);
    try {
      const response = await this.ipc.rescanProjects(options);
      if (response.success && response.data) {
        this._projects.set(response.data);
      } else {
        this._error.set(response.error?.message ?? 'Failed to rescan projects');
      }
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : 'Failed to rescan projects');
    } finally {
      this._projectLoading.set(false);
    }
  }

  async cancelRun(runId: string): Promise<void> {
    this._error.set(null);
    try {
      const response = await this.ipc.cancelRun(runId);
      if (!response.success) {
        this._error.set(response.error?.message ?? 'Failed to cancel run');
        return;
      }
      await this.loadRuns();
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : 'Failed to cancel run');
    }
  }

  async retryRun(runId: string): Promise<void> {
    this._error.set(null);
    try {
      const response = await this.ipc.retryRun(runId);
      if (!response.success) {
        this._error.set(response.error?.message ?? 'Failed to retry run');
        return;
      }
      await this.loadRuns();
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : 'Failed to retry run');
    }
  }

  disposeForTesting(): void {
    this.unsubscribeOperatorEvents?.();
    this.unsubscribeOperatorEvents = null;
    this.initialized = false;
  }

  private subscribeToOperatorEvents(): void {
    if (this.unsubscribeOperatorEvents) {
      return;
    }
    this.unsubscribeOperatorEvents = this.ipc.onOperatorEvent((payload: OperatorRunEventNotification) => {
      const currentThreadId = this.thread()?.id;
      const knownRun = this._runs().some((run) => run.id === payload.runId);
      if (!currentThreadId && !knownRun) {
        return;
      }
      void this.loadRuns();
    });
  }
}
