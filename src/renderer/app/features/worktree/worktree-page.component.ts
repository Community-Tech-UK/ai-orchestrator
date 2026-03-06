/**
 * Worktree Page
 * Container that wires worktree panel UI to worktree IPC APIs.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import type {
  MergeStrategy,
  WorktreeMergePreview,
  WorktreeSession,
} from '../../../../shared/types/worktree.types';
import { WorktreePanelComponent } from './worktree-panel.component';
import { OrchestrationIpcService } from '../../core/services/ipc/orchestration-ipc.service';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { TaskIpcService } from '../../core/services/ipc/task-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import type { TaskPreflightReport } from '../../../../shared/types/task-preflight.types';
import { TaskPreflightCardComponent } from '../../shared/components/task-preflight-card.component';

interface WorktreeActionPayload {
  sessionId: string;
  action: 'view' | 'merge' | 'abandon' | 'complete';
}

interface InstanceOption {
  id: string;
  displayName: string;
  status: string;
  workingDirectory?: string;
}

@Component({
  selector: 'app-worktree-page',
  standalone: true,
  imports: [CommonModule, WorktreePanelComponent, TaskPreflightCardComponent],
  template: `
    <div class="page">
      <div class="page-header">
        <button class="header-btn" type="button" (click)="goBack()">← Back</button>
        <div class="header-title">
          <span class="title">Worktrees</span>
          <span class="subtitle">Parallel branch workflow with merge/conflict visibility</span>
        </div>
      </div>

      <div class="toolbar">
        <label class="field">
          <span class="label">Instance</span>
          <select class="select" [value]="selectedInstanceId()" (change)="onInstanceChange($event)">
            <option value="">Select instance</option>
            @for (instance of instances(); track instance.id) {
              <option [value]="instance.id">
                {{ instance.displayName }} ({{ instance.status }})
              </option>
            }
          </select>
        </label>

        <label class="field field-wide">
          <span class="label">Task Description</span>
          <input
            class="input"
            type="text"
            [value]="taskDescription()"
            placeholder="e.g. migrate verification dashboard filters"
            (input)="onTaskDescriptionInput($event)"
          />
        </label>

        <label class="field">
          <span class="label">Base Branch</span>
          <input
            class="input"
            type="text"
            [value]="baseBranch()"
            placeholder="main"
            (input)="onBaseBranchInput($event)"
          />
        </label>

        <label class="field">
          <span class="label">Merge Strategy</span>
          <select class="select" [value]="mergeStrategy()" (change)="onStrategyChange($event)">
            <option value="auto">auto</option>
            <option value="squash">squash</option>
            <option value="rebase">rebase</option>
            <option value="manual">manual</option>
          </select>
        </label>

        <div class="actions">
          <button class="btn primary" type="button" [disabled]="working() || !canCreate()" (click)="createWorktree()">
            Create
          </button>
          <button class="btn" type="button" [disabled]="!selectedInstance()" (click)="openRepoJobLaunch()">
            Implement as Background Job
          </button>
          <button class="btn" type="button" [disabled]="working()" (click)="refreshAll()">
            Refresh
          </button>
          <button class="btn" type="button" [disabled]="working() || sessions().length < 2" (click)="detectConflicts()">
            Detect Conflicts
          </button>
        </div>
      </div>

      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      <div class="content">
        <div class="main-panel">
          <app-worktree-panel
            [sessions]="sessions()"
            (action)="onWorktreeAction($event)"
            (mergeAll)="mergeAllCompleted()"
          />
        </div>

        <div class="side-panel">
          <div class="panel-card">
            <div class="panel-title">Launch Preflight</div>
            <app-task-preflight-card
              [report]="preflight()"
              [loading]="preflightLoading()"
              title="Worktree Preflight"
              subtitle="Filesystem permissions, instructions, and tool readiness for worktree creation."
              emptyMessage="Select an instance to inspect worktree readiness."
            />
          </div>

          <div class="panel-card">
            <div class="panel-title">Merge Preview</div>
            @if (preview(); as p) {
              <div class="meta-row">
                <span>Auto merge: {{ p.canAutoMerge ? 'yes' : 'no' }}</span>
                <span>Files: {{ p.filesChanged.length }}</span>
              </div>
              @if (p.conflictFiles.length > 0) {
                <div class="section-label">Conflict Files</div>
                <ul class="list">
                  @for (file of p.conflictFiles.slice(0, 12); track file) {
                    <li>{{ file }}</li>
                  }
                </ul>
              }
              @if (p.crossConflicts && p.crossConflicts.length > 0) {
                <div class="section-label">Cross-Worktree Conflicts</div>
                <ul class="list">
                  @for (conflict of p.crossConflicts.slice(0, 8); track conflict.file) {
                    <li>
                      <span class="severity" [class]="'sev-' + conflict.severity">
                        {{ conflict.severity }}
                      </span>
                      {{ conflict.file }}
                    </li>
                  }
                </ul>
              }
            } @else {
              <div class="hint">Select “View” on a worktree to inspect merge preview.</div>
            }
          </div>

          <div class="panel-card">
            <div class="panel-title">Conflict Detection</div>
            @if (detectedConflicts().length > 0) {
              <ul class="list">
                @for (conflict of detectedConflicts(); track conflict.file + ':' + conflict.worktrees.join(',')) {
                  <li>
                    <span class="severity" [class]="'sev-' + conflict.severity">{{ conflict.severity }}</span>
                    {{ conflict.file }}
                  </li>
                }
              </ul>
            } @else {
              <div class="hint">No cross-worktree conflicts detected.</div>
            }
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      width: 100%;
      height: 100%;
    }

    .page {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      padding: var(--spacing-lg);
      background: var(--bg-primary);
      color: var(--text-primary);
    }

    .page-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
    }

    .header-btn {
      padding: var(--spacing-xs) var(--spacing-md);
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      cursor: pointer;
    }

    .header-title {
      display: flex;
      flex-direction: column;
    }

    .title {
      font-size: 18px;
      font-weight: 700;
    }

    .subtitle {
      font-size: 12px;
      color: var(--text-muted);
    }

    .toolbar {
      display: grid;
      grid-template-columns: minmax(190px, 1fr) minmax(260px, 2fr) minmax(140px, 1fr) minmax(120px, 1fr) auto;
      gap: var(--spacing-sm);
      align-items: end;
      padding: var(--spacing-md);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
    }

    .field {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      min-width: 0;
    }

    .field-wide {
      min-width: 0;
    }

    .label {
      font-size: 12px;
      color: var(--text-muted);
    }

    .input,
    .select {
      width: 100%;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
    }

    .actions {
      display: flex;
      gap: var(--spacing-xs);
      justify-content: flex-end;
    }

    .btn {
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
      cursor: pointer;
    }

    .btn.primary {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: #fff;
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .error-banner {
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-sm);
      border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
      background: color-mix(in srgb, var(--error-color) 14%, transparent);
      color: var(--error-color);
      font-size: 12px;
    }

    .content {
      flex: 1;
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(0, 2fr) minmax(300px, 1fr);
      gap: var(--spacing-md);
    }

    .main-panel,
    .side-panel {
      min-height: 0;
    }

    .side-panel {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
    }

    .panel-card {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      overflow: auto;
    }

    .panel-title {
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 2px;
    }

    .section-label {
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      margin-top: var(--spacing-xs);
    }

    .meta-row {
      display: flex;
      justify-content: space-between;
      gap: var(--spacing-sm);
      font-size: 11px;
      color: var(--text-secondary);
    }

    .list {
      margin: 0;
      padding-left: 18px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 11px;
      color: var(--text-secondary);
    }

    .severity {
      text-transform: uppercase;
      font-size: 10px;
      font-weight: 700;
      margin-right: 6px;
    }

    .sev-high { color: var(--error-color); }
    .sev-medium { color: var(--warning-color); }
    .sev-low { color: var(--text-muted); }

    .hint {
      font-size: 12px;
      color: var(--text-muted);
    }

    @media (max-width: 1200px) {
      .toolbar {
        grid-template-columns: 1fr;
      }

      .actions {
        justify-content: flex-start;
      }

      .content {
        grid-template-columns: 1fr;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorktreePageComponent implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  private readonly orchestrationIpc = inject(OrchestrationIpcService);
  private readonly instanceIpc = inject(InstanceIpcService);
  private readonly taskIpc = inject(TaskIpcService);

  readonly sessions = signal<WorktreeSession[]>([]);
  readonly instances = signal<InstanceOption[]>([]);
  readonly selectedInstanceId = signal('');
  readonly taskDescription = signal('');
  readonly baseBranch = signal('');
  readonly mergeStrategy = signal<MergeStrategy>('auto');

  readonly preview = signal<WorktreeMergePreview | null>(null);
  readonly preflight = signal<TaskPreflightReport | null>(null);
  readonly preflightLoading = signal(false);
  readonly detectedConflicts = signal<{
    file: string;
    worktrees: string[];
    description: string;
    severity: 'high' | 'medium' | 'low';
  }[]>([]);

  readonly working = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly selectedInstance = computed(() =>
    this.instances().find((instance) => instance.id === this.selectedInstanceId()) || null
  );

  readonly canCreate = computed(() =>
    this.selectedInstanceId().trim().length > 0 &&
    this.taskDescription().trim().length > 0 &&
    !this.preflightLoading() &&
    (this.preflight()?.blockers.length || 0) === 0
  );

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  async ngOnInit(): Promise<void> {
    await this.refreshAll();
    this.pollTimer = setInterval(() => {
      void this.refreshSessions();
    }, 3000);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  goBack(): void {
    this.router.navigate(['/']);
  }

  openRepoJobLaunch(): void {
    const selectedInstance = this.selectedInstance();
    const workingDirectory = selectedInstance?.workingDirectory?.trim();
    if (!workingDirectory) {
      this.errorMessage.set('The selected instance does not expose a working directory for repo jobs.');
      return;
    }

    const queryParams: Record<string, string> = {
      workingDirectory,
      useWorktree: 'true',
    };

    const taskDescription = this.taskDescription().trim();
    if (taskDescription) {
      queryParams['description'] = taskDescription;
      queryParams['title'] = taskDescription;
    }

    const baseBranch = this.baseBranch().trim();
    if (baseBranch) {
      queryParams['baseBranch'] = baseBranch;
    }

    this.router.navigate(['/tasks'], {
      queryParams,
      state: {
        launchType: 'issue-implementation',
      },
    });
  }

  async refreshAll(): Promise<void> {
    this.errorMessage.set(null);
    this.working.set(true);

    try {
      await Promise.all([this.loadInstances(), this.refreshSessions()]);
    } finally {
      this.working.set(false);
    }
  }

  async createWorktree(): Promise<void> {
    if (!this.canCreate()) {
      return;
    }

    this.errorMessage.set(null);
    this.working.set(true);

    try {
      const response = await this.orchestrationIpc.worktreeCreate({
        instanceId: this.selectedInstanceId(),
        taskDescription: this.taskDescription().trim(),
        baseBranch: this.baseBranch().trim() || undefined,
      });
      this.unwrapData(response, null);
      this.taskDescription.set('');
      await this.refreshSessions();
    } finally {
      this.working.set(false);
    }
  }

  async onWorktreeAction(action: WorktreeActionPayload): Promise<void> {
    this.errorMessage.set(null);
    this.working.set(true);

    try {
      switch (action.action) {
        case 'view': {
          await this.loadPreview(action.sessionId);
          break;
        }
        case 'complete': {
          const response = await this.orchestrationIpc.worktreeComplete(action.sessionId);
          this.unwrapData(response, null);
          await this.refreshSessions();
          break;
        }
        case 'merge': {
          const preview = await this.loadPreview(action.sessionId);
          if (preview && !preview.canAutoMerge) {
            this.errorMessage.set('Cannot merge automatically: conflicts detected.');
            break;
          }
          const response = await this.orchestrationIpc.worktreeMerge({
            sessionId: action.sessionId,
            strategy: this.mergeStrategy(),
          });
          this.unwrapData(response, null);
          await this.refreshSessions();
          break;
        }
        case 'abandon': {
          const response = await this.orchestrationIpc.worktreeAbandon(
            action.sessionId,
            'Abandoned from worktree panel'
          );
          this.unwrapData(response, null);
          await this.refreshSessions();
          break;
        }
      }
    } finally {
      this.working.set(false);
    }
  }

  async mergeAllCompleted(): Promise<void> {
    const mergeable = this.sessions().filter((session) => session.status === 'completed');
    if (mergeable.length === 0) return;

    this.errorMessage.set(null);
    this.working.set(true);

    try {
      for (const session of mergeable) {
        const preview = await this.loadPreview(session.id);
        if (preview && !preview.canAutoMerge) {
          continue;
        }
        await this.orchestrationIpc.worktreeMerge({
          sessionId: session.id,
          strategy: this.mergeStrategy(),
        });
      }
      await this.refreshSessions();
    } finally {
      this.working.set(false);
    }
  }

  async detectConflicts(): Promise<void> {
    const sessionIds = this.sessions().map((session) => session.id);
    if (sessionIds.length < 2) {
      this.detectedConflicts.set([]);
      return;
    }

    this.errorMessage.set(null);
    this.working.set(true);

    try {
      const response = await this.orchestrationIpc.worktreeDetectConflicts(sessionIds);
      const conflicts = this.unwrapData<{
        file: string;
        worktrees: string[];
        description: string;
        severity: 'high' | 'medium' | 'low';
      }[]>(response, []);
      this.detectedConflicts.set(conflicts);
    } finally {
      this.working.set(false);
    }
  }

  onInstanceChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.selectedInstanceId.set(target.value);
    void this.refreshPreflight();
  }

  onTaskDescriptionInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.taskDescription.set(target.value);
  }

  onBaseBranchInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.baseBranch.set(target.value);
  }

  onStrategyChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.mergeStrategy.set(target.value as MergeStrategy);
  }

  private async refreshSessions(): Promise<void> {
    const response = await this.orchestrationIpc.worktreeList();
    const sessions = this.unwrapData<WorktreeSession[]>(response, []);
    this.sessions.set(sessions);
  }

  private async loadInstances(): Promise<void> {
    const response = await this.instanceIpc.listInstances();
    const data = this.unwrapData<unknown[]>(response, []);
    const options = data
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item) => ({
        id: String(item['id']),
        displayName: String(item['displayName'] || item['id']),
        status: String(item['status'] || 'unknown'),
        workingDirectory: typeof item['workingDirectory'] === 'string' ? item['workingDirectory'] : undefined,
      }));

    this.instances.set(options);

    if (!this.selectedInstanceId() && options.length > 0) {
      this.selectedInstanceId.set(options[0].id);
    }

    await this.refreshPreflight();
  }

  private async loadPreview(sessionId: string): Promise<WorktreeMergePreview | null> {
    const response = await this.orchestrationIpc.worktreePreviewMerge(sessionId);
    const preview = this.unwrapData<WorktreeMergePreview | null>(response, null);
    this.preview.set(preview);
    return preview;
  }

  private async refreshPreflight(): Promise<void> {
    const workingDirectory = this.selectedInstance()?.workingDirectory?.trim();
    if (!workingDirectory) {
      this.preflight.set(null);
      this.preflightLoading.set(false);
      return;
    }

    this.preflightLoading.set(true);
    try {
      const response = await this.taskIpc.taskGetPreflight({
        workingDirectory,
        surface: 'worktree',
        taskType: 'parallel-worktree',
        requiresWrite: true,
      });

      if (response.success && response.data) {
        this.preflight.set(response.data);
        return;
      }

      this.preflight.set(null);
    } finally {
      this.preflightLoading.set(false);
    }
  }

  private unwrapData<T>(response: IpcResponse, fallback: T): T {
    if (!response.success) {
      this.errorMessage.set(response.error?.message || 'IPC request failed');
      return fallback;
    }
    return (response.data as T) ?? fallback;
  }
}
