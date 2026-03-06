import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { SettingsStore } from '../../core/state/settings.store';
import { RepoJobIpcService } from '../../core/services/ipc/repo-job-ipc.service';
import { VcsIpcService } from '../../core/services/ipc/vcs-ipc.service';
import { TaskIpcService } from '../../core/services/ipc/task-ipc.service';
import { SessionShareIpcService } from '../../core/services/ipc/session-share-ipc.service';
import type { RepoJobRecord, RepoJobStatus, RepoJobType } from '../../../../shared/types/repo-job.types';
import type { TaskPreflightReport } from '../../../../shared/types/task-preflight.types';
import { TaskPreflightCardComponent } from '../../shared/components/task-preflight-card.component';

interface RepoInfo {
  isRepo: boolean;
  gitAvailable: boolean;
  gitRoot?: string | null;
}

@Component({
  selector: 'app-tasks-page',
  standalone: true,
  imports: [CommonModule, TaskPreflightCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="tasks-page">
      <header class="hero">
        <div>
          <p class="eyebrow">Local Background Jobs</p>
          <h1>Repo Jobs</h1>
          <p class="subtitle">
            Launch PR reviews, issue implementation runs, and repository health audits locally in this orchestrator.
          </p>
        </div>
        <button class="ghost" type="button" (click)="refresh()" [disabled]="loading()">
          Refresh
        </button>
      </header>

      <section class="stats-grid">
        <article class="stat-card">
          <span class="stat-label">Queued</span>
          <strong>{{ stats().queued }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">Running</span>
          <strong>{{ stats().running }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">Completed</span>
          <strong>{{ stats().completed }}</strong>
        </article>
        <article class="stat-card">
          <span class="stat-label">Failed</span>
          <strong>{{ stats().failed }}</strong>
        </article>
      </section>

      <section class="panel launch-panel">
        <div class="panel-header">
          <div>
            <h2>Launch Job</h2>
            <p>These jobs run on your machine and keep their instances and worktrees local.</p>
          </div>
          @if (repoInfo()) {
            <span class="repo-pill" [class.ready]="repoInfo()!.isRepo">
              {{ repoInfo()!.isRepo ? 'Git repo detected' : (repoInfo()!.gitAvailable ? 'Not a Git repo' : 'Git unavailable') }}
            </span>
          }
        </div>

        <label class="field">
          <span>Working Directory</span>
          <input
            type="text"
            [value]="workingDirectory()"
            (input)="workingDirectory.set(getInputValue($event)); onWorkingDirectoryChange()"
            placeholder="/path/to/repository"
          />
        </label>

        <div class="field-row">
          <label class="field">
            <span>Issue / PR URL</span>
            <input
              type="text"
              [value]="issueOrPrUrl()"
              (input)="issueOrPrUrl.set(getInputValue($event)); refreshPreflight()"
              placeholder="https://github.com/org/repo/pull/123"
            />
          </label>

          <label class="field">
            <span>Title</span>
            <input
              type="text"
              [value]="title()"
              (input)="title.set(getInputValue($event))"
              placeholder="Optional short label"
            />
          </label>
        </div>

        <div class="field-row">
          <label class="field">
            <span>Job Type</span>
            <select
              [value]="plannedJobType()"
              (change)="onPlannedJobTypeChange($event)"
            >
              <option value="pr-review">PR Review</option>
              <option value="issue-implementation">Issue Implementation</option>
              <option value="repo-health-audit">Repo Health Audit</option>
            </select>
          </label>

          <label class="field">
            <span>Base Branch</span>
            <input
              type="text"
              [value]="baseBranch()"
              (input)="baseBranch.set(getInputValue($event))"
              placeholder="main"
            />
          </label>

          <label class="field">
            <span>Branch Ref</span>
            <input
              type="text"
              [value]="branchRef()"
              (input)="branchRef.set(getInputValue($event))"
              placeholder="feature/my-branch"
            />
          </label>
        </div>

        <label class="field">
          <span>Description</span>
          <textarea
            rows="4"
            [value]="description()"
            (input)="description.set(getTextAreaValue($event))"
            placeholder="Optional issue or review context"
          ></textarea>
        </label>

        <label class="checkbox-row">
          <input
            type="checkbox"
            [checked]="useWorktree()"
            (change)="onUseWorktreeChange($event)"
          />
          <span>Use worktree isolation for issue implementation jobs</span>
        </label>

        <label class="checkbox-row">
          <input
            type="checkbox"
            [checked]="browserEvidence()"
            (change)="onBrowserEvidenceChange($event)"
          />
          <span>Capture browser evidence when the repo exposes a runnable UI or browser repro path</span>
        </label>

        <div class="preflight-card">
          <div class="panel-header">
            <div>
              <h3>Launch Preflight</h3>
              <p>Instructions, MCP state, and browser readiness that will shape a local background run.</p>
            </div>
            <button class="ghost" type="button" (click)="refreshPreflight()" [disabled]="loading() || submitting()">
              Recheck
            </button>
          </div>
          <app-task-preflight-card
            [report]="preflight()"
            [loading]="preflightLoading()"
            title="Launch Preflight"
            subtitle="Instructions, permissions, MCP readiness, and browser tooling for this background job."
            emptyMessage="Load a working directory to resolve launch readiness before submitting a repo job."
          />
        </div>

        <div class="button-row">
          <button class="primary" type="button" (click)="submit()" [disabled]="!canSubmit()">
            Launch {{ submitLabel() }}
          </button>
        </div>

        @if (error()) {
          <p class="error">{{ error() }}</p>
        }

        @if (info()) {
          <p class="info">{{ info() }}</p>
        }
      </section>

      <section class="panel jobs-panel">
        <div class="panel-header">
          <div>
            <h2>Jobs</h2>
            <p>Queued, running, and completed background work.</p>
          </div>

          <div class="filters">
            <label class="compact-field">
              <span>Status</span>
              <select [value]="statusFilter()" (change)="onStatusFilterChange($event)">
                <option value="all">All</option>
                <option value="queued">Queued</option>
                <option value="running">Running</option>
                <option value="completed">Completed</option>
                <option value="failed">Failed</option>
                <option value="cancelled">Cancelled</option>
              </select>
            </label>

            <label class="compact-field">
              <span>Type</span>
              <select [value]="typeFilter()" (change)="onTypeFilterChange($event)">
                <option value="all">All</option>
                <option value="pr-review">PR Review</option>
                <option value="issue-implementation">Issue Implementation</option>
                <option value="repo-health-audit">Repo Health Audit</option>
              </select>
            </label>
          </div>
        </div>

        @if (filteredJobs().length === 0) {
          <div class="empty-state">
            <p>No background repo jobs yet.</p>
          </div>
        } @else {
          <div class="job-list">
            @for (job of filteredJobs(); track job.id) {
              <article class="job-card">
                <div class="job-head">
                  <div>
                    <h3>{{ job.name }}</h3>
                    <p class="meta">
                      {{ job.type }} · {{ job.workingDirectory }}
                    </p>
                  </div>
                  <span class="status-pill" [class]="'status-pill ' + job.status">
                    {{ job.status }}
                  </span>
                </div>

                <div class="progress-row">
                  <div class="progress-track">
                    <div class="progress-fill" [style.width.%]="job.progress"></div>
                  </div>
                  <span class="progress-value">{{ job.progress }}%</span>
                </div>

                @if (job.progressMessage) {
                  <p class="progress-message">{{ job.progressMessage }}</p>
                }

                <div class="detail-grid">
                  <div>
                    <span class="detail-label">Workflow</span>
                    <strong>{{ job.workflowTemplateId }}</strong>
                  </div>
                  <div>
                    <span class="detail-label">Branch</span>
                    <strong>{{ job.result?.worktree?.branchName || job.repoContext.currentBranch || 'n/a' }}</strong>
                  </div>
                  <div>
                    <span class="detail-label">Git Root</span>
                    <strong>{{ job.repoContext.gitRoot || 'n/a' }}</strong>
                  </div>
                  <div>
                    <span class="detail-label">Instance</span>
                    <strong>{{ job.instanceId || 'pending' }}</strong>
                  </div>
                </div>

                @if (job.result?.summary) {
                  <pre class="summary">{{ job.result?.summary }}</pre>
                }

                @if (job.error) {
                  <p class="error">{{ job.error }}</p>
                }

                <div class="button-row">
                  <button class="ghost" type="button" (click)="openReplay(job)" [disabled]="!job.instanceId">
                    Observer
                  </button>
                  <button class="ghost" type="button" (click)="saveShareBundle(job)" [disabled]="!job.instanceId">
                    Share
                  </button>
                  <button class="ghost" type="button" (click)="rerun(job.id)" [disabled]="submitting()">
                    Rerun
                  </button>
                  <button
                    class="ghost danger"
                    type="button"
                    (click)="cancel(job.id)"
                    [disabled]="job.status !== 'queued' && job.status !== 'running'"
                  >
                    Cancel
                  </button>
                </div>
              </article>
            }
          </div>
        }
      </section>
    </div>
  `,
  styles: [`
    :host {
      display: block;
      min-height: 100%;
      background:
        radial-gradient(circle at top right, rgba(56, 189, 248, 0.12), transparent 28rem),
        linear-gradient(180deg, #07111c 0%, #091521 100%);
      color: #e5eef6;
    }

    .tasks-page {
      max-width: 72rem;
      margin: 0 auto;
      padding: 2rem 1.25rem 3rem;
    }

    .hero,
    .panel-header,
    .field-row,
    .button-row,
    .job-head,
    .progress-row {
      display: flex;
      gap: 1rem;
      align-items: center;
      justify-content: space-between;
    }

    .hero {
      margin-bottom: 1.5rem;
      align-items: flex-end;
    }

    .eyebrow {
      margin: 0 0 0.35rem;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      font-size: 0.72rem;
      color: #8dc5ff;
    }

    h1,
    h2,
    h3,
    p {
      margin: 0;
    }

    h1 {
      font-size: clamp(2rem, 4vw, 3rem);
      line-height: 0.98;
    }

    .subtitle,
    .panel-header p,
    .meta,
    .progress-message {
      color: #9fb3c7;
    }

    .stats-grid,
    .detail-grid {
      display: grid;
      gap: 0.9rem;
    }

    .stats-grid {
      grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
      margin-bottom: 1.25rem;
    }

    .stat-card,
    .panel,
    .job-card {
      border: 1px solid rgba(148, 163, 184, 0.18);
      background: rgba(7, 18, 30, 0.86);
      backdrop-filter: blur(10px);
      border-radius: 1rem;
      box-shadow: 0 1rem 2rem rgba(0, 0, 0, 0.18);
    }

    .stat-card {
      padding: 1rem 1.1rem;
    }

    .stat-label,
    .detail-label,
    .compact-field span {
      display: block;
      margin-bottom: 0.35rem;
      font-size: 0.72rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #82a2bf;
    }

    .panel {
      padding: 1.15rem;
      margin-bottom: 1.25rem;
    }

    .launch-panel {
      display: grid;
      gap: 1rem;
    }

    .field,
    .compact-field {
      display: grid;
      gap: 0.45rem;
      flex: 1;
    }

    .field input,
    .field textarea,
    .field select,
    .compact-field select {
      width: 100%;
      border-radius: 0.85rem;
      border: 1px solid rgba(148, 163, 184, 0.22);
      background: rgba(15, 23, 42, 0.72);
      color: #f8fafc;
      padding: 0.8rem 0.9rem;
      font: inherit;
    }

    .checkbox-row {
      display: flex;
      gap: 0.75rem;
      align-items: center;
      color: #d8e4ef;
    }

    .button-row {
      justify-content: flex-start;
      flex-wrap: wrap;
    }

    button {
      border: 0;
      border-radius: 999px;
      padding: 0.72rem 1rem;
      font: inherit;
      font-weight: 600;
      cursor: pointer;
      transition: transform 120ms ease, opacity 120ms ease, background 120ms ease;
    }

    button:hover:not(:disabled) {
      transform: translateY(-1px);
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
    }

    .primary {
      background: linear-gradient(135deg, #38bdf8 0%, #0ea5e9 100%);
      color: #04131e;
    }

    .ghost {
      background: rgba(148, 163, 184, 0.14);
      color: #f8fafc;
    }

    .ghost.danger {
      color: #fecaca;
      background: rgba(127, 29, 29, 0.24);
    }

    .repo-pill,
    .status-pill {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      padding: 0.4rem 0.7rem;
      font-size: 0.78rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .repo-pill {
      background: rgba(251, 191, 36, 0.16);
      color: #fde68a;
    }

    .repo-pill.ready {
      background: rgba(34, 197, 94, 0.18);
      color: #bbf7d0;
    }

    .filters {
      display: flex;
      gap: 0.75rem;
      flex-wrap: wrap;
    }

    .job-list {
      display: grid;
      gap: 1rem;
    }

    .job-card {
      padding: 1rem;
    }

    .progress-track {
      flex: 1;
      height: 0.5rem;
      background: rgba(148, 163, 184, 0.15);
      border-radius: 999px;
      overflow: hidden;
    }

    .progress-fill {
      height: 100%;
      border-radius: inherit;
      background: linear-gradient(90deg, #38bdf8 0%, #22c55e 100%);
    }

    .progress-value {
      min-width: 3rem;
      text-align: right;
      color: #c6d7e7;
      font-variant-numeric: tabular-nums;
    }

    .detail-grid {
      grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
      margin: 1rem 0;
    }

    .summary {
      margin: 0 0 1rem;
      padding: 0.9rem;
      white-space: pre-wrap;
      background: rgba(15, 23, 42, 0.78);
      border-radius: 0.85rem;
      border: 1px solid rgba(148, 163, 184, 0.12);
      color: #dce7f2;
      font: inherit;
    }

    .error {
      color: #fca5a5;
    }

    .info {
      color: #86efac;
    }

    .preflight-card {
      display: grid;
      gap: 0.85rem;
    }

    .empty-state {
      padding: 2rem 0.5rem 0.5rem;
      color: #9fb3c7;
      text-align: center;
    }

    .status-pill.queued {
      background: rgba(250, 204, 21, 0.16);
      color: #fde68a;
    }

    .status-pill.running {
      background: rgba(56, 189, 248, 0.18);
      color: #bae6fd;
    }

    .status-pill.completed {
      background: rgba(34, 197, 94, 0.18);
      color: #bbf7d0;
    }

    .status-pill.failed,
    .status-pill.cancelled {
      background: rgba(248, 113, 113, 0.18);
      color: #fecaca;
    }

    @media (max-width: 840px) {
      .hero,
      .panel-header,
      .field-row,
      .progress-row {
        flex-direction: column;
        align-items: stretch;
      }

      .field-row {
        gap: 1rem;
      }

      .button-row {
        width: 100%;
      }

      .button-row button {
        width: 100%;
      }
    }
  `],
})
export class TasksPageComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly repoJobs = inject(RepoJobIpcService);
  private readonly vcs = inject(VcsIpcService);
  private readonly tasks = inject(TaskIpcService);
  private readonly sessionShare = inject(SessionShareIpcService);
  private readonly settingsStore = inject(SettingsStore);
  private readonly destroyRef = inject(DestroyRef);

  readonly workingDirectory = signal('');
  readonly issueOrPrUrl = signal('');
  readonly title = signal('');
  readonly description = signal('');
  readonly baseBranch = signal('');
  readonly branchRef = signal('');
  readonly plannedJobType = signal<RepoJobType>('pr-review');
  readonly useWorktree = signal(true);
  readonly browserEvidence = signal(false);

  readonly jobs = signal<RepoJobRecord[]>([]);
  readonly stats = signal({ queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, total: 0 });
  readonly repoInfo = signal<RepoInfo | null>(null);
  readonly preflight = signal<TaskPreflightReport | null>(null);
  readonly preflightLoading = signal(false);
  readonly loading = signal(false);
  readonly submitting = signal(false);
  readonly error = signal<string | null>(null);
  readonly info = signal<string | null>(null);

  readonly statusFilter = signal<RepoJobStatus | 'all'>('all');
  readonly typeFilter = signal<RepoJobType | 'all'>('all');

  readonly filteredJobs = computed(() => this.jobs().filter((job) => {
    const statusMatches = this.statusFilter() === 'all' || job.status === this.statusFilter();
    const typeMatches = this.typeFilter() === 'all' || job.type === this.typeFilter();
    return statusMatches && typeMatches;
  }));
  readonly hasPreflightBlockers = computed(() => (this.preflight()?.blockers.length || 0) > 0);
  readonly canSubmit = computed(() =>
    this.workingDirectory().trim().length > 0 &&
    !this.submitting() &&
    !this.preflightLoading() &&
    !this.hasPreflightBlockers()
  );
  readonly submitLabel = computed(() => {
    switch (this.plannedJobType()) {
      case 'pr-review':
        return 'PR Review';
      case 'issue-implementation':
        return 'Issue Implementation';
      case 'repo-health-audit':
        return 'Health Audit';
    }
  });

  constructor() {
    this.applyRoutePrefill();

    effect(() => {
      const defaultDir = this.settingsStore.defaultWorkingDirectory();
      if (!this.workingDirectory() && defaultDir) {
        this.workingDirectory.set(defaultDir);
        void this.refreshRepoInfo();
      }
    });

    void this.refresh();
    const handle = window.setInterval(() => {
      void this.refresh(false);
    }, 4000);
    this.destroyRef.onDestroy(() => window.clearInterval(handle));
  }

  async refresh(showLoading = true): Promise<void> {
    if (showLoading) {
      this.loading.set(true);
    }
    this.error.set(null);
    this.info.set(null);

    try {
      const [jobsResponse, statsResponse] = await Promise.all([
        this.repoJobs.listJobs(),
        this.repoJobs.getStats(),
      ]);

      if (jobsResponse.success && Array.isArray(jobsResponse.data)) {
        this.jobs.set(jobsResponse.data);
      }
      if (statsResponse.success && statsResponse.data) {
        this.stats.set(statsResponse.data);
      }
      await this.refreshRepoInfo();
      await this.refreshPreflight();
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      if (showLoading) {
        this.loading.set(false);
      }
    }
  }

  async submit(): Promise<void> {
    const workingDirectory = this.workingDirectory().trim();
    if (!workingDirectory) {
      this.error.set('Working directory is required.');
      return;
    }

    if (this.hasPreflightBlockers()) {
      this.error.set('Resolve the launch blockers in preflight before submitting this repo job.');
      return;
    }

    const type = this.plannedJobType();

    this.submitting.set(true);
    this.error.set(null);
    this.info.set(null);

    try {
      const response = await this.repoJobs.submitJob({
        type,
        workingDirectory,
        issueOrPrUrl: this.normalizeOptional(this.issueOrPrUrl()),
        title: this.normalizeOptional(this.title()),
        description: this.normalizeOptional(this.description()),
        baseBranch: this.normalizeOptional(this.baseBranch()),
        branchRef: this.normalizeOptional(this.branchRef()),
        useWorktree: type === 'issue-implementation' ? this.useWorktree() : false,
        browserEvidence: this.browserEvidence(),
      });

      if (!response.success) {
        throw new Error(response.error?.message || 'Failed to submit background job');
      }

      await this.refresh(false);
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      this.submitting.set(false);
    }
  }

  async rerun(jobId: string): Promise<void> {
    try {
      this.info.set(null);
      const response = await this.repoJobs.rerunJob(jobId);
      if (!response.success) {
        throw new Error(response.error?.message || 'Failed to rerun background job');
      }
      await this.refresh(false);
    } catch (error) {
      this.error.set((error as Error).message);
    }
  }

  async cancel(jobId: string): Promise<void> {
    try {
      this.info.set(null);
      const response = await this.repoJobs.cancelJob(jobId);
      if (!response.success) {
        throw new Error(response.error?.message || 'Failed to cancel background job');
      }
      await this.refresh(false);
    } catch (error) {
      this.error.set((error as Error).message);
    }
  }

  onWorkingDirectoryChange(): void {
    void this.refreshRepoInfo();
    void this.refreshPreflight();
  }

  onPlannedJobTypeChange(event: Event): void {
    this.plannedJobType.set(this.getSelectValue(event) as RepoJobType);
    void this.refreshPreflight();
  }

  onUseWorktreeChange(event: Event): void {
    this.useWorktree.set(this.getCheckedValue(event));
    void this.refreshPreflight();
  }

  onBrowserEvidenceChange(event: Event): void {
    this.browserEvidence.set(this.getCheckedValue(event));
    void this.refreshPreflight();
  }

  getInputValue(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  getTextAreaValue(event: Event): string {
    return (event.target as HTMLTextAreaElement).value;
  }

  getSelectValue(event: Event): string {
    return (event.target as HTMLSelectElement).value;
  }

  getCheckedValue(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }

  onStatusFilterChange(event: Event): void {
    this.statusFilter.set(this.getSelectValue(event) as RepoJobStatus | 'all');
  }

  onTypeFilterChange(event: Event): void {
    this.typeFilter.set(this.getSelectValue(event) as RepoJobType | 'all');
  }

  openReplay(job: RepoJobRecord): void {
    if (!job.instanceId) {
      return;
    }

    void this.router.navigate(['/replay'], {
      queryParams: { instanceId: job.instanceId },
    });
  }

  async saveShareBundle(job: RepoJobRecord): Promise<void> {
    if (!job.instanceId) {
      return;
    }

    this.error.set(null);
    this.info.set(null);

    try {
      const response = await this.sessionShare.saveForInstance(job.instanceId);
      if (!response.success || !response.data || typeof response.data !== 'object') {
        throw new Error(response.error?.message || 'Failed to save share bundle.');
      }

      const filePath = (response.data as { filePath?: string }).filePath;
      this.info.set(filePath ? `Saved share bundle to ${filePath}` : 'Saved share bundle.');
    } catch (error) {
      this.error.set((error as Error).message);
    }
  }

  private normalizeOptional(value: string): string | undefined {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private applyRoutePrefill(): void {
    const query = this.route.snapshot.queryParamMap;
    const workingDirectory = query.get('workingDirectory');
    const issueOrPrUrl = query.get('issueOrPrUrl');
    const title = query.get('title');
    const description = query.get('description');
    const baseBranch = query.get('baseBranch');
    const branchRef = query.get('branchRef');
    const useWorktree = query.get('useWorktree');
    const launchType = window.history.state?.['launchType'];

    if (workingDirectory) {
      this.workingDirectory.set(workingDirectory);
    }
    if (issueOrPrUrl) {
      this.issueOrPrUrl.set(issueOrPrUrl);
    }
    if (title) {
      this.title.set(title);
    }
    if (description) {
      this.description.set(description);
    }
    if (baseBranch) {
      this.baseBranch.set(baseBranch);
    }
    if (branchRef) {
      this.branchRef.set(branchRef);
    }
    if (useWorktree !== null) {
      this.useWorktree.set(!['0', 'false', 'no'].includes(useWorktree.toLowerCase()));
    }
    if (launchType === 'pr-review' || launchType === 'issue-implementation' || launchType === 'repo-health-audit') {
      this.plannedJobType.set(launchType);
    }
  }

  private async refreshRepoInfo(): Promise<void> {
    const workingDirectory = this.workingDirectory().trim();
    if (!workingDirectory) {
      this.repoInfo.set(null);
      return;
    }

    const response = await this.vcs.vcsIsRepo(workingDirectory);
    if (!response.success || !response.data || typeof response.data !== 'object') {
      this.repoInfo.set(null);
      return;
    }

    const data = response.data as RepoInfo;
    this.repoInfo.set({
      isRepo: Boolean(data.isRepo),
      gitAvailable: Boolean(data.gitAvailable),
      gitRoot: data.gitRoot,
    });
  }

  async refreshPreflight(): Promise<void> {
    const workingDirectory = this.workingDirectory().trim();
    if (!workingDirectory) {
      this.preflight.set(null);
      this.preflightLoading.set(false);
      return;
    }
    this.preflightLoading.set(true);

    try {
      const response = await this.tasks.taskGetPreflight({
        workingDirectory,
        surface: 'repo-job',
        taskType: this.plannedJobType(),
        requiresWrite: this.plannedJobType() === 'issue-implementation',
        requiresNetwork: Boolean(this.normalizeOptional(this.issueOrPrUrl())) || this.browserEvidence(),
        requiresBrowser: this.browserEvidence(),
      });

      if (response.success && response.data) {
        this.preflight.set(response.data);
        return;
      }

      this.preflight.set(null);
      if (response.error?.message) {
        this.error.set(response.error.message);
      }
    } finally {
      this.preflightLoading.set(false);
    }
  }
}
