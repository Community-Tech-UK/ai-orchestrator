/**
 * Reviews Page
 * Container that wires review sessions to the review results UI.
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
import type {
  ReviewAgentConfig,
  ReviewIssue,
  ReviewSummary,
  SeverityLevel,
} from '../../../../shared/types/review-agent.types';
import { ReviewResultsComponent } from './review-results.component';
import { OrchestrationIpcService } from '../../core/services/ipc/orchestration-ipc.service';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

interface InstanceOption {
  id: string;
  displayName: string;
  status: string;
  workingDirectory?: string;
}

type ReviewStatus = 'idle' | 'pending' | 'running' | 'completed' | 'failed';

const SEVERITY_ORDER: SeverityLevel[] = ['critical', 'high', 'medium', 'low', 'info'];

@Component({
  selector: 'app-reviews-page',
  standalone: true,
  imports: [CommonModule, ReviewResultsComponent],
  template: `
    <div class="page">
      <div class="page-header">
        <div class="header-title">
          <span class="title">Reviews</span>
          <span class="subtitle">Session start, agent selection, issue acknowledgment, and export</span>
        </div>
      </div>

      <div class="toolbar">
        <label class="field">
          <span class="label">Instance</span>
          <select class="select" [value]="selectedInstanceId()" (change)="onInstanceChange($event)">
            <option value="">Select instance</option>
            @for (instance of instances(); track instance.id) {
              <option [value]="instance.id">{{ instance.displayName }} ({{ instance.status }})</option>
            }
          </select>
        </label>

        <label class="field field-wide">
          <span class="label">Files (one path per line)</span>
          <textarea
            class="textarea"
            [value]="filesInput()"
            placeholder="src/main/ipc/orchestration-ipc-handler.ts"
            (input)="onFilesInput($event)"
          ></textarea>
        </label>

        <label class="checkbox-row">
          <input type="checkbox" [checked]="diffOnly()" (change)="onDiffOnlyChange($event)" />
          Diff only
        </label>

        <div class="actions">
          <button class="btn primary" type="button" [disabled]="working() || !canStart()" (click)="startSession()">
            Start Session
          </button>
          <button class="btn" type="button" [disabled]="working() || !sessionId()" (click)="refreshSession()">
            Refresh
          </button>
        </div>
      </div>

      <div class="agent-strip">
        <span class="strip-title">Agents</span>
        <div class="agent-list">
          @for (agent of agents(); track agent.id) {
            <label class="agent-chip">
              <input
                type="checkbox"
                [checked]="isAgentSelected(agent.id)"
                (change)="toggleAgent(agent.id, $event)"
              />
              <span>{{ agent.name }}</span>
            </label>
          }
        </div>
      </div>

      <div class="status-bar">
        <span class="status-pill" [class]="'status-' + sessionStatus()">{{ sessionStatus() }}</span>
        @if (sessionId()) {
          <span class="status-text">Session: {{ sessionId() }}</span>
        }
        <span class="status-text">Issues: {{ issues().length }}</span>
      </div>

      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      @if (infoMessage()) {
        <div class="info-banner">{{ infoMessage() }}</div>
      }

      <div class="content">
        <app-review-results
          [issues]="issues()"
          [score]="summary()"
          (issueAcknowledged)="onIssueAcknowledged($event)"
          (suggestionApplied)="onSuggestionApplied($event)"
          (navigateTo)="onNavigateTo($event)"
          (exportData)="onExportData($event)"
        />
      </div>
    </div>
  `,
  styles: [
    `
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
        grid-template-columns: minmax(220px, 1fr) minmax(280px, 2fr) auto auto;
        gap: var(--spacing-sm);
        align-items: end;
        padding: var(--spacing-md);
        border-radius: var(--radius-md);
        border: 1px solid var(--border-color);
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
        font-size: 11px;
        color: var(--text-muted);
      }

      .select,
      .textarea {
        width: 100%;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-primary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
      }

      .textarea {
        min-height: 80px;
        resize: vertical;
        font-family: var(--font-family-mono);
      }

      .checkbox-row {
        display: inline-flex;
        align-items: center;
        gap: var(--spacing-xs);
        font-size: 12px;
        color: var(--text-secondary);
        align-self: center;
      }

      .actions {
        display: flex;
        gap: var(--spacing-xs);
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

      .agent-strip {
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        padding: var(--spacing-sm) var(--spacing-md);
        display: flex;
        gap: var(--spacing-sm);
        align-items: center;
      }

      .strip-title {
        font-size: 11px;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      .agent-list {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .agent-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        border: 1px solid var(--border-color);
        border-radius: 999px;
        padding: 2px 8px;
        font-size: 11px;
        color: var(--text-secondary);
      }

      .status-bar {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-xs) var(--spacing-md);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
      }

      .status-pill {
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        font-weight: 700;
        border-radius: 999px;
        padding: 2px 8px;
        border: 1px solid var(--border-color);
      }

      .status-idle,
      .status-pending {
        color: var(--text-muted);
      }

      .status-running {
        color: var(--warning-color);
      }

      .status-completed {
        color: var(--success-color);
      }

      .status-failed {
        color: var(--error-color);
      }

      .status-text {
        font-size: 12px;
        color: var(--text-secondary);
      }

      .error-banner,
      .info-banner {
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-sm);
        font-size: 12px;
      }

      .error-banner {
        border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
        background: color-mix(in srgb, var(--error-color) 14%, transparent);
        color: var(--error-color);
      }

      .info-banner {
        border: 1px solid color-mix(in srgb, var(--primary-color) 60%, transparent);
        background: color-mix(in srgb, var(--primary-color) 12%, transparent);
        color: var(--text-primary);
      }

      .content {
        flex: 1;
        min-height: 0;
        overflow: auto;
      }

      @media (max-width: 1100px) {
        .toolbar {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReviewsPageComponent implements OnInit, OnDestroy {
  private readonly orchestrationIpc = inject(OrchestrationIpcService);
  private readonly instanceIpc = inject(InstanceIpcService);
  private readonly fileIpc = inject(FileIpcService);

  readonly agents = signal<ReviewAgentConfig[]>([]);
  readonly instances = signal<InstanceOption[]>([]);

  readonly selectedInstanceId = signal('');
  readonly selectedAgentIds = signal<Set<string>>(new Set<string>());
  readonly filesInput = signal('');
  readonly diffOnly = signal(true);

  readonly sessionId = signal<string>('');
  readonly sessionStatus = signal<ReviewStatus>('idle');
  readonly issues = signal<ReviewIssue[]>([]);
  readonly summary = signal<ReviewSummary | null>(null);

  readonly working = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly infoMessage = signal<string | null>(null);

  readonly canStart = computed(() =>
    this.selectedInstanceId().length > 0 && this.selectedAgentIds().size > 0
  );

  private pollTimer: ReturnType<typeof setInterval> | null = null;

  async ngOnInit(): Promise<void> {
    await this.refreshAll();
    this.pollTimer = setInterval(() => {
      if (!this.sessionId()) {
        return;
      }
      const status = this.sessionStatus();
      if (status === 'running' || status === 'pending') {
        void this.refreshSession();
      }
    }, 2000);
  }

  ngOnDestroy(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async refreshAll(): Promise<void> {
    this.working.set(true);
    this.errorMessage.set(null);

    try {
      await Promise.all([this.loadInstances(), this.loadAgents()]);
      if (this.sessionId()) {
        await this.refreshSession();
      }
    } finally {
      this.working.set(false);
    }
  }

  async startSession(): Promise<void> {
    if (!this.canStart()) {
      return;
    }

    const files = this.parseFiles(this.filesInput());

    this.working.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);

    try {
      const response = await this.orchestrationIpc.reviewStartSession({
        instanceId: this.selectedInstanceId(),
        agentIds: Array.from(this.selectedAgentIds()),
        files,
        diffOnly: this.diffOnly(),
      });

      if (!response.success) {
        this.errorMessage.set(response.error?.message || 'Failed to start review session.');
        return;
      }

      const sessionId = this.extractSessionId(response);
      if (!sessionId) {
        this.errorMessage.set('Review session started but no session ID was returned.');
        return;
      }

      this.sessionId.set(sessionId);
      this.sessionStatus.set('pending');
      this.infoMessage.set('Review session started.');
      await this.refreshSession();
    } finally {
      this.working.set(false);
    }
  }

  async refreshSession(): Promise<void> {
    const sessionId = this.sessionId();
    if (!sessionId) {
      return;
    }

    this.errorMessage.set(null);

    const sessionResponse = await this.orchestrationIpc.reviewGetSession(sessionId);
    if (!sessionResponse.success) {
      this.errorMessage.set(sessionResponse.error?.message || 'Failed to load review session.');
      this.sessionStatus.set('failed');
      return;
    }

    const sessionData = (sessionResponse.data ?? null) as Record<string, unknown> | null;
    const status = this.toReviewStatus(sessionData?.['status']);
    this.sessionStatus.set(status);

    const sessionIssues = Array.isArray(sessionData?.['aggregatedIssues'])
      ? (sessionData?.['aggregatedIssues'] as ReviewIssue[])
      : [];

    const issuesResponse = await this.orchestrationIpc.reviewGetIssues({ sessionId });
    if (issuesResponse.success) {
      const issues = this.unwrapData<ReviewIssue[]>(issuesResponse, []);
      this.issues.set(this.sortIssues(issues));
      this.summary.set(this.buildSummary(this.issues()));
    } else {
      this.issues.set(this.sortIssues(sessionIssues));
      this.summary.set(this.buildSummary(sessionIssues));
    }
  }

  async onIssueAcknowledged(issue: ReviewIssue): Promise<void> {
    const sessionId = this.sessionId();
    if (!sessionId) {
      return;
    }

    const response = await this.orchestrationIpc.reviewAcknowledgeIssue(
      sessionId,
      issue.id,
      true
    );

    if (!response.success) {
      this.errorMessage.set(response.error?.message || 'Failed to acknowledge issue.');
      return;
    }

    this.issues.update((items) =>
      items.map((item) => (item.id === issue.id ? { ...item, acknowledged: true } : item))
    );
    this.infoMessage.set('Issue acknowledged.');
  }

  onSuggestionApplied(issue: ReviewIssue): void {
    if (!issue.suggestion) {
      return;
    }
    this.infoMessage.set('Suggestion captured. Apply it from your editor or command flow.');
  }

  async onNavigateTo(payload: { file: string; line: number }): Promise<void> {
    const response = await this.fileIpc.editorOpen(payload.file, { line: payload.line });
    if (!response.success) {
      this.errorMessage.set(response.error?.message || 'Failed to open location in editor.');
      return;
    }
    this.infoMessage.set(`Opened ${payload.file}:${payload.line}`);
  }

  onExportData(payload: { format: 'markdown' | 'json'; data: string }): void {
    const extension = payload.format === 'json' ? 'json' : 'md';
    const filename = `review-${this.sessionId() || 'session'}.${extension}`;
    const blob = new Blob([payload.data], {
      type: payload.format === 'json' ? 'application/json' : 'text/markdown',
    });

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);

    this.infoMessage.set(`Exported ${filename}.`);
  }

  onInstanceChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.selectedInstanceId.set(target.value);
  }

  onFilesInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.filesInput.set(target.value);
  }

  onDiffOnlyChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.diffOnly.set(target.checked);
  }

  isAgentSelected(agentId: string): boolean {
    return this.selectedAgentIds().has(agentId);
  }

  toggleAgent(agentId: string, event: Event): void {
    const target = event.target as HTMLInputElement;
    const checked = target.checked;

    this.selectedAgentIds.update((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(agentId);
      } else {
        next.delete(agentId);
      }
      return next;
    });
  }

  private async loadInstances(): Promise<void> {
    const response = await this.instanceIpc.listInstances();
    if (!response.success) {
      this.errorMessage.set(response.error?.message || 'Failed to load instances.');
      return;
    }

    const data = this.unwrapData<unknown[]>(response, []);
    const instances = data
      .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
      .map((item) => ({
        id: String(item['id']),
        displayName: String(item['displayName'] || item['id']),
        status: String(item['status'] || 'unknown'),
        workingDirectory:
          typeof item['workingDirectory'] === 'string' ? item['workingDirectory'] : undefined,
      }));

    this.instances.set(instances);

    if (!this.selectedInstanceId() && instances.length > 0) {
      this.selectedInstanceId.set(instances[0].id);
    }
  }

  private async loadAgents(): Promise<void> {
    const response = await this.orchestrationIpc.reviewListAgents();
    if (!response.success) {
      this.errorMessage.set(response.error?.message || 'Failed to load review agents.');
      return;
    }

    const agents = this.unwrapData<ReviewAgentConfig[]>(response, []);
    this.agents.set(agents);

    if (this.selectedAgentIds().size === 0 && agents.length > 0) {
      this.selectedAgentIds.set(new Set(agents.map((agent) => agent.id)));
    }
  }

  private parseFiles(raw: string): string[] {
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  private extractSessionId(response: IpcResponse): string | null {
    if (!response.success) {
      return null;
    }

    if (typeof response.data === 'string') {
      return response.data;
    }

    const data = response.data as Record<string, unknown> | undefined;
    if (data && typeof data['sessionId'] === 'string') {
      return data['sessionId'];
    }

    return null;
  }

  private toReviewStatus(value: unknown): ReviewStatus {
    if (value === 'pending' || value === 'running' || value === 'completed' || value === 'failed') {
      return value;
    }
    return 'idle';
  }

  private sortIssues(issues: ReviewIssue[]): ReviewIssue[] {
    const severityWeight = new Map(SEVERITY_ORDER.map((severity, index) => [severity, index]));

    return [...issues].sort((a, b) => {
      const severityDiff =
        (severityWeight.get(a.severity) ?? 99) - (severityWeight.get(b.severity) ?? 99);
      if (severityDiff !== 0) {
        return severityDiff;
      }
      return (b.confidence ?? 0) - (a.confidence ?? 0);
    });
  }

  private buildSummary(issues: ReviewIssue[]): ReviewSummary {
    const bySeverity: Record<SeverityLevel, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0,
    };

    const byAgent: Record<string, number> = {};
    const byFile: Record<string, number> = {};

    for (const issue of issues) {
      bySeverity[issue.severity] += 1;
      byAgent[issue.agentId] = (byAgent[issue.agentId] || 0) + 1;
      if (issue.file) {
        byFile[issue.file] = (byFile[issue.file] || 0) + 1;
      }
    }

    const topFiles = Object.entries(byFile)
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const penalty =
      bySeverity.critical * 20 +
      bySeverity.high * 10 +
      bySeverity.medium * 5 +
      bySeverity.low * 2;

    return {
      totalIssues: issues.length,
      bySeverity,
      byAgent,
      topFiles,
      overallScore: Math.max(0, 100 - penalty),
    };
  }

  private unwrapData<T>(response: IpcResponse, fallback: T): T {
    return response.success ? ((response.data as T) ?? fallback) : fallback;
  }
}
