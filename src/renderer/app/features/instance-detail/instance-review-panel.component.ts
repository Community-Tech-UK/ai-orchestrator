/**
 * Instance Review Panel
 *
 * Runs the built-in review agents against the current working directory files and
 * displays results inline using ReviewResultsComponent.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal
} from '@angular/core';
import { ElectronIpcService } from '../../core/services/ipc';
import { VcsIpcService } from '../../core/services/ipc/vcs-ipc.service';
import { ReviewResultsComponent } from '../review/review-results.component';
import type {
  ReviewIssue,
  ReviewSummary,
  ReviewSessionStatus,
  SeverityLevel
} from '../../../../shared/types/review-agent.types';

interface ReviewAgent {
  id: string;
  name: string;
  description: string;
}

interface ReviewAgentRecord {
  id: unknown;
  name: unknown;
  description?: unknown;
}

interface GitRepoStatus {
  isRepo?: boolean;
}

interface GitStatusFileChange {
  path: string;
}

interface GitStatusPayload {
  staged?: GitStatusFileChange[];
  unstaged?: GitStatusFileChange[];
  untracked?: string[];
}

interface ReviewStartSessionData {
  sessionId?: string;
}

interface ReviewSessionData {
  status?: ReviewSessionStatus;
  aggregatedIssues?: ReviewIssue[];
}

@Component({
  selector: 'app-instance-review-panel',
  standalone: true,
  imports: [ReviewResultsComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="panel">
        <div class="header" role="button" tabindex="0" (click)="expanded.set(!expanded())" (keydown.enter)="expanded.set(!expanded())" (keydown.space)="expanded.set(!expanded()); $event.preventDefault()">
          <div class="title">
            <span class="chevron" [class.open]="expanded()">&#9656;</span>
            <span>Review</span>
            @if (sessionStatus(); as s) {
              <span class="badge" [class.running]="s === 'running'">{{ s }}</span>
            }
          </div>
          @if (expanded()) {
            <div class="actions" role="toolbar" tabindex="-1" (click)="$event.stopPropagation()" (keydown.enter)="$event.stopPropagation()" (keydown.space)="$event.stopPropagation()">
              <label class="toggle">
                <input type="checkbox" [checked]="diffOnly()" (change)="onToggleDiffOnly($event)" />
                <span>Diff only</span>
              </label>
              <button class="btn" (click)="refreshChangedFiles()" [disabled]="busy()">Refresh files</button>
              <button class="btn primary" (click)="runReview()" [disabled]="busy() || selectedAgentIds().length === 0 || files().length === 0">
                Run review
              </button>
            </div>
          }
        </div>

        @if (expanded()) {
          @if (error()) {
            <div class="error">{{ error() }}</div>
          }

          <div class="body">
            <div class="config">
              <div class="block">
                <div class="block-title">Agents</div>
                <div class="agent-list">
                  @for (a of agents(); track a.id) {
                    <label class="agent">
                      <input
                        type="checkbox"
                        [checked]="selectedAgentSet().has(a.id)"
                        (change)="toggleAgent(a.id)"
                        [disabled]="busy()"
                      />
                      <span class="agent-name">{{ a.name }}</span>
                      <span class="agent-desc">{{ a.description }}</span>
                    </label>
                  }
                  @if (agents().length === 0) {
                    <div class="muted">No review agents available.</div>
                  }
                </div>
              </div>

              <div class="block">
                <div class="block-title">Files</div>
                <div class="files">
                  @if (files().length === 0) {
                    <div class="muted">No changed files detected.</div>
                  } @else {
                    <div class="file-count">{{ files().length }} files</div>
                    <div class="file-list">
                      @for (f of files(); track f) {
                        <div class="file">{{ f }}</div>
                      }
                    </div>
                  }
                </div>
              </div>
            </div>

            @if (issues().length > 0) {
              <app-review-results
                [issues]="issues()"
                [score]="summary()"
                (issueAcknowledged)="acknowledgeIssue($event)"
                (navigateTo)="openAtLine($event)"
              />
            } @else if (sessionStatus() === 'completed') {
              <div class="muted">No issues found.</div>
            }
          </div>
        }
      </div>
  `,
  styles: [
    `
      .panel {
        border: 1px solid var(--border-subtle);
        background: var(--bg-secondary);
        border-radius: var(--radius-lg);
        margin: var(--spacing-md) 0;
        overflow: hidden;
      }

      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-md);
        padding: 10px 12px;
        background: var(--bg-tertiary);
        border-bottom: 1px solid var(--border-subtle);
        cursor: pointer;
        user-select: none;
      }

      .title {
        display: flex;
        align-items: center;
        gap: 10px;
        font-family: var(--font-display);
        font-weight: 800;
      }

      .chevron {
        display: inline-block;
        font-size: 12px;
        transition: transform 0.15s ease;
        color: var(--text-muted);
      }

      .chevron.open {
        transform: rotate(90deg);
      }

      .badge {
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--border-subtle);
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }

      .badge.running {
        color: #fbbf24;
        border-color: rgba(251, 191, 36, 0.35);
      }

      .actions {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        flex-wrap: wrap;
        justify-content: flex-end;
      }

      .toggle {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
        color: var(--text-secondary);
      }

      .btn {
        padding: 6px 10px;
        border-radius: var(--radius-md);
        border: 1px solid var(--border-subtle);
        background: transparent;
        color: var(--text-primary);
        cursor: pointer;
      }

      .btn.primary {
        border-color: transparent;
        background: linear-gradient(
          135deg,
          var(--primary-color) 0%,
          var(--primary-hover) 100%
        );
        color: var(--bg-primary);
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .body {
        padding: 12px;
      }

      .config {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--spacing-md);
        margin-bottom: var(--spacing-md);
      }

      .block-title {
        font-size: 12px;
        color: var(--text-muted);
        margin-bottom: 6px;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }

      .agent-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        max-height: 180px;
        overflow: auto;
        padding-right: 6px;
      }

      .agent {
        display: grid;
        grid-template-columns: 18px 120px 1fr;
        gap: 8px;
        align-items: center;
        font-size: 12px;
      }

      .agent-name {
        font-family: var(--font-display);
        font-weight: 700;
      }

      .agent-desc {
        color: var(--text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .files {
        max-height: 180px;
        overflow: auto;
      }

      .file-count {
        font-size: 12px;
        color: var(--text-secondary);
        margin-bottom: 8px;
      }

      .file-list {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .file {
        font-size: 12px;
        padding: 6px 8px;
        border: 1px solid rgba(255, 255, 255, 0.06);
        border-radius: var(--radius-md);
        background: rgba(0, 0, 0, 0.12);
        color: var(--text-primary);
        word-break: break-word;
      }

      .muted {
        font-size: 12px;
        color: var(--text-muted);
      }

      .error {
        padding: 10px 12px;
        font-size: 12px;
        color: var(--error-color);
      }
    `
  ]
})
export class InstanceReviewPanelComponent {
  private ipc = inject(ElectronIpcService);
  private vcs = inject(VcsIpcService);

  instanceId = input.required<string>();
  workingDirectory = input.required<string>();
  reviewStarted = output<void>();
  reviewCompleted = output<{ issueCount: number; hasErrors: boolean }>();

  agents = signal<ReviewAgent[]>([]);
  selectedAgentSet = signal(new Set<string>());

  files = signal<string[]>([]);
  diffOnly = signal(true);

  busy = signal(false);
  error = signal<string | null>(null);

  sessionId = signal<string | null>(null);
  sessionStatus = signal<'pending' | 'running' | 'completed' | 'failed' | null>(null);

  issues = signal<ReviewIssue[]>([]);
  summary = signal<ReviewSummary | null>(null);

  selectedAgentIds = computed(() => Array.from(this.selectedAgentSet()));

  expanded = signal(false);

  constructor() {
    effect(() => {
      const wd = this.workingDirectory();
      const id = this.instanceId();
      if (!wd || !id) return;
      void this.loadAgents();
      void this.refreshChangedFiles();
    });
  }

  async loadAgents(): Promise<void> {
    this.error.set(null);
    const resp = await this.ipc.getApi()?.reviewListAgents();
    if (!resp?.success) {
      this.error.set(resp?.error?.message || 'Failed to load review agents');
      return;
    }
    const agents = Array.isArray(resp.data)
      ? (resp.data as ReviewAgentRecord[])
      : [];
    const list: ReviewAgent[] = agents.map((a) => ({
      id: String(a.id),
      name: String(a.name),
      description: String(a.description || '')
    }));
    this.agents.set(list);
    if (this.selectedAgentSet().size === 0) {
      this.selectedAgentSet.set(new Set(list.map((a) => a.id)));
    }
  }

  toggleAgent(agentId: string): void {
    this.selectedAgentSet.update((set) => {
      const next = new Set(set);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  onToggleDiffOnly(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.diffOnly.set(Boolean(target.checked));
  }

  async refreshChangedFiles(): Promise<void> {
    this.error.set(null);
    const wd = this.workingDirectory();
    const repoResp = await this.vcs.vcsIsRepo(wd);
    const repoStatus = repoResp.data as GitRepoStatus | undefined;
    if (!repoResp.success || !repoStatus?.isRepo) {
      this.files.set([]);
      return;
    }
    const statusResp = await this.vcs.vcsGetStatus(wd);
    if (!statusResp.success) {
      this.error.set(statusResp.error?.message || 'Failed to read git status');
      return;
    }
    const st = (statusResp.data as GitStatusPayload | undefined) ?? {};
    const files = [
      ...(st.staged ?? []).map((c) => c.path),
      ...(st.unstaged ?? []).map((c) => c.path),
      ...(st.untracked ?? []),
    ]
      .filter(Boolean)
      .slice(0, 200);
    // De-dupe
    const seen = new Set<string>();
    const out: string[] = [];
    for (const f of files) {
      if (seen.has(f)) continue;
      seen.add(f);
      out.push(String(f));
    }
    this.files.set(out);
  }

  async runReview(): Promise<void> {
    const instanceId = this.instanceId();
    const agentIds = this.selectedAgentIds();
    const files = this.files();
    if (agentIds.length === 0 || files.length === 0) return;

    this.reviewStarted.emit();
    this.busy.set(true);
    this.error.set(null);
    this.sessionStatus.set('pending');
    this.issues.set([]);
    this.summary.set(null);
    try {
      const resp = await this.ipc.getApi()?.reviewStartSession({
        agentId: agentIds[0],
        instanceId,
        workingDirectory: this.workingDirectory() || '',
        files,
        options: { agentIds, diffOnly: this.diffOnly() }
      });
      if (!resp?.success) {
        this.error.set(resp?.error?.message || 'Failed to start review');
        this.sessionStatus.set('failed');
        return;
      }
      const sessionData = resp.data as ReviewStartSessionData | undefined;
      const sessionId = sessionData?.sessionId;
      if (!sessionId) {
        this.error.set('Invalid review session response');
        this.sessionStatus.set('failed');
        return;
      }
      this.sessionId.set(sessionId);
      await this.pollSession(sessionId);
    } catch (e) {
      this.error.set(e instanceof Error ? e.message : String(e));
      this.sessionStatus.set('failed');
    } finally {
      this.busy.set(false);
    }
  }

  private buildSummary(issues: ReviewIssue[]): ReviewSummary {
    const bySeverity: Record<SeverityLevel, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      info: 0
    };
    const byAgent: Record<string, number> = {};
    const fileCount: Record<string, number> = {};

    for (const i of issues) {
      bySeverity[i.severity] = (bySeverity[i.severity] || 0) + 1;
      byAgent[i.agentId] = (byAgent[i.agentId] || 0) + 1;
      if (i.file) fileCount[i.file] = (fileCount[i.file] || 0) + 1;
    }

    const topFiles = Object.entries(fileCount)
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const penalty =
      bySeverity.critical * 20 +
      bySeverity.high * 10 +
      bySeverity.medium * 5 +
      bySeverity.low * 2 +
      bySeverity.info * 0;

    return {
      totalIssues: issues.length,
      bySeverity,
      byAgent,
      topFiles,
      overallScore: Math.max(0, 100 - penalty),
    };
  }

  private async pollSession(sessionId: string): Promise<void> {
    this.sessionStatus.set('running');
    const start = Date.now();

    while (Date.now() - start < 5 * 60 * 1000) {
      const resp = await this.ipc.getApi()?.reviewGetSession(sessionId);
      if (!resp?.success) {
        this.error.set(resp?.error?.message || 'Failed to get review session');
        this.sessionStatus.set('failed');
        return;
      }

      const session = (resp.data as ReviewSessionData | undefined) ?? {};
      const status = session.status;
      if (status === 'failed') {
        this.sessionStatus.set('failed');
        return;
      }
      if (status === 'completed') {
        this.sessionStatus.set('completed');
        const issues = (session?.aggregatedIssues || []) as ReviewIssue[];
        this.issues.set(issues);
        this.summary.set(this.buildSummary(issues));
        const hasErrors = issues.some(
          (issue) => issue.severity === 'critical' || issue.severity === 'high'
        );
        this.reviewCompleted.emit({ issueCount: issues.length, hasErrors });
        return;
      }

      await new Promise((r) => setTimeout(r, 1500));
    }

    this.error.set('Review timed out');
    this.sessionStatus.set('failed');
  }

  async acknowledgeIssue(issue: ReviewIssue): Promise<void> {
    const sessionId = this.sessionId();
    if (!sessionId) return;
    await this.ipc.getApi()?.reviewAcknowledgeIssue({
      sessionId,
      issueId: issue.id,
      action: 'acknowledge',
    });
  }

  async openAtLine(payload: { file: string; line: number }): Promise<void> {
    const wd = this.workingDirectory();
    const filePath = payload.file.startsWith('/') ? payload.file : `${wd}/${payload.file}`;
    await this.ipc.getApi()?.editorOpenFileAtLine({
      filePath,
      line: payload.line,
      column: 1,
    });
  }
}
