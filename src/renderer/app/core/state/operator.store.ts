import { Injectable, computed, inject, signal } from '@angular/core';
import type { ConversationLedgerConversation } from '../../../../shared/types/conversation-ledger.types';
import type {
  OperatorProjectRecord,
  OperatorProjectRefreshOptions,
  OperatorRunEventNotification,
  OperatorRunGraph,
  OperatorRunRecord,
} from '../../../../shared/types/operator.types';
import { OperatorIpcService } from '../services/ipc/operator-ipc.service';

export interface OperatorTargetChip {
  label: string;
  path: string;
}

export type OperatorGlobalStatusTone = 'idle' | 'running' | 'attention' | 'failed';

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
  private readonly _activeRunGraph = signal<OperatorRunGraph | null>(null);
  private readonly _error = signal<string | null>(null);
  private initialized = false;
  private initializationPromise: Promise<void> | null = null;
  private unsubscribeOperatorEvents: (() => void) | null = null;

  readonly conversation = this._conversation.asReadonly();
  readonly selected = this._selected.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly sending = this._sending.asReadonly();
  readonly projectLoading = this._projectLoading.asReadonly();
  readonly projects = this._projects.asReadonly();
  readonly runLoading = this._runLoading.asReadonly();
  readonly runs = this._runs.asReadonly();
  readonly activeRunGraph = this._activeRunGraph.asReadonly();
  readonly error = this._error.asReadonly();
  readonly thread = computed(() => this._conversation()?.thread ?? null);
  readonly messages = computed(() => this._conversation()?.messages ?? []);
  readonly messageCount = computed(() => this._conversation()?.messages.length ?? 0);
  readonly activeRunCount = computed(() => this._runs().filter((run) => isActiveRunStatus(run.status)).length);
  readonly statusTone = computed<OperatorGlobalStatusTone>(() => {
    if (this._error()) {
      return 'failed';
    }
    if (this._sending() || this._loading() || this._runLoading() || this._projectLoading()) {
      return 'running';
    }

    const latestRun = this._runs()[0];
    if (!latestRun) {
      return 'idle';
    }
    if (latestRun.status === 'failed') {
      return 'failed';
    }
    if (latestRun.status === 'blocked' || latestRun.status === 'waiting') {
      return 'attention';
    }
    if (this.activeRunCount() > 0) {
      return 'running';
    }
    return 'idle';
  });
  readonly statusLabel = computed(() => {
    const tone = this.statusTone();
    if (tone === 'running') return 'Running';
    if (tone === 'attention') return 'Attention';
    if (tone === 'failed') return 'Failed';
    return 'Idle';
  });
  readonly targetChips = computed<OperatorTargetChip[]>(() => {
    const graph = this._activeRunGraph();
    if (!graph) return [];

    const projectsById = new Map(this._projects().map((project) => [project.id, project]));
    const seen = new Set<string>();
    const chips: OperatorTargetChip[] = [];
    for (const node of graph.nodes) {
      if (!node.targetPath) continue;
      const key = node.targetProjectId ?? node.targetPath;
      if (seen.has(key)) continue;
      seen.add(key);
      const project = node.targetProjectId ? projectsById.get(node.targetProjectId) : undefined;
      chips.push({
        label: project?.displayName ?? lastPathSegment(node.targetPath),
        path: node.targetPath,
      });
    }
    return chips;
  });

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (this.initializationPromise) {
      return this.initializationPromise;
    }
    this.subscribeToOperatorEvents();
    this.initializationPromise = (async () => {
      await this.refresh();
      await this.loadProjectsForStartup();
      this.initialized = true;
    })();
    try {
      await this.initializationPromise;
    } finally {
      this.initializationPromise = null;
    }
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
        this._conversation.set(response.data.conversation);
        await this.loadRuns();
        if (response.data.runId) {
          await this.loadRunGraph(response.data.runId);
        }
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
        const activeRun = response.data[0] ?? null;
        if (activeRun) {
          await this.loadRunGraph(activeRun.id);
        } else {
          this._activeRunGraph.set(null);
        }
      } else {
        this._error.set(response.error?.message ?? 'Failed to load runs');
      }
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : 'Failed to load runs');
    } finally {
      this._runLoading.set(false);
    }
  }

  async loadRunGraph(runId: string): Promise<void> {
    try {
      const response = await this.ipc.getRun(runId);
      if (response.success) {
        this._activeRunGraph.set(response.data ?? null);
      } else {
        this._error.set(response.error?.message ?? 'Failed to load run');
      }
    } catch (error) {
      this._error.set(error instanceof Error ? error.message : 'Failed to load run');
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
      if (response.data) {
        this._activeRunGraph.set(response.data);
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
      if (response.data) {
        this._activeRunGraph.set(response.data);
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
    this.initializationPromise = null;
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
      void this.refresh();
    });
  }

  private async loadProjectsForStartup(): Promise<void> {
    await this.loadProjects();
    if (this._projects().length === 0) {
      await this.rescanProjects();
    }
  }
}

function lastPathSegment(value: string): string {
  const normalized = value.replace(/\/+$/, '');
  return normalized.split('/').pop() || value;
}

function isActiveRunStatus(status: OperatorRunRecord['status']): boolean {
  return status === 'queued' || status === 'running' || status === 'waiting';
}
