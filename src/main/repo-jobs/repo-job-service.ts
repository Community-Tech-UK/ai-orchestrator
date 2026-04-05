import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import type { Instance, InstanceCreateConfig, OutputMessage } from '../../shared/types/instance.types';
import type {
  RepoJobListOptions,
  RepoJobRecord,
  RepoJobRepoContext,
  RepoJobResult,
  RepoJobStats,
  RepoJobSubmission,
  RepoJobType,
  RepoJobWorktreeContext,
} from '../../shared/types/repo-job.types';
import { getWorkflowManager } from '../workflows/workflow-manager';
import { createVcsManager, isGitAvailable, type DiffStats, type FileChange } from '../workspace/git/vcs-manager';
import { getBackgroundTaskManager, type Task, type TaskExecutionContext } from '../tasks/background-task-manager';
import { getWorktreeManager, type WorktreeManager } from '../workspace/git/worktree-manager';
import { getLogger } from '../logging/logger';
import { resolveGitHostMetadata } from '../vcs/remotes/git-host-connector';
import { getChildResultStorage } from '../orchestration/child-result-storage';
import { getReactionEngine } from '../reactions';
import { getRepoJobStore } from './repo-job-store';

const logger = getLogger('RepoJobService');

type RepoJobEventName =
  | 'repo-job:submitted'
  | 'repo-job:started'
  | 'repo-job:progress'
  | 'repo-job:completed'
  | 'repo-job:failed'
  | 'repo-job:cancelled';

interface RepoJobInstanceManager {
  createInstance(config: InstanceCreateConfig): Promise<Instance>;
  getInstance(id: string): Instance | undefined;
  terminateInstance?(instanceId: string, graceful?: boolean): Promise<void>;
}

interface RepoJobWorktreeManager {
  createWorktree: WorktreeManager['createWorktree'];
  completeWorktree: WorktreeManager['completeWorktree'];
  previewMerge: WorktreeManager['previewMerge'];
}

interface RepoJobServiceDependencies {
  instanceManager: RepoJobInstanceManager;
  worktreeManager: RepoJobWorktreeManager;
  sleep: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUTS_MS: Record<RepoJobType, number> = {
  'pr-review': 20 * 60 * 1000,
  'issue-implementation': 45 * 60 * 1000,
  'repo-health-audit': 20 * 60 * 1000,
};

function taskTypeForRepoJob(type: RepoJobType): string {
  return `repo-job:${type}`;
}

export class RepoJobService extends EventEmitter {
  private static instance: RepoJobService | null = null;

  private readonly taskManager = getBackgroundTaskManager();
  private readonly workflowManager = getWorkflowManager();
  private readonly jobs = new Map<string, RepoJobRecord>();
  private deps: Partial<RepoJobServiceDependencies> = {
    worktreeManager: getWorktreeManager(),
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  private boundTaskEvents = false;

  static getInstance(): RepoJobService {
    if (!this.instance) {
      this.instance = new RepoJobService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private readonly store = getRepoJobStore();

  private constructor() {
    super();
    this.loadPersistedJobs();
    this.registerExecutors();
    this.bindTaskEvents();
  }

  initialize(deps: Partial<RepoJobServiceDependencies>): void {
    this.deps = {
      ...this.deps,
      ...deps,
    };
  }

  /**
   * Load previously persisted jobs from disk into the in-memory map.
   * Only restores terminal jobs (completed/failed/cancelled) for history;
   * active jobs can't be meaningfully resumed after an app restart.
   */
  private loadPersistedJobs(): void {
    const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
    try {
      const persisted = this.store.loadAll();
      for (const [id, job] of persisted) {
        if (!this.jobs.has(id) && terminalStatuses.has(job.status)) {
          this.jobs.set(id, job);
        }
      }
    } catch (error) {
      logger.warn('Failed to load persisted repo jobs', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Persist a job to disk (called on every state transition).
   */
  private persistJob(job: RepoJobRecord): void {
    try {
      this.store.saveJob(job);
    } catch (error) {
      logger.warn('Failed to persist repo job', {
        jobId: job.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Run pruning after a job reaches a terminal state.
   * Syncs pruned IDs from disk back to the in-memory map to prevent
   * unbounded growth over long-running sessions.
   */
  private pruneIfNeeded(): void {
    try {
      const prunedIds = this.store.prune();
      for (const id of prunedIds) {
        this.jobs.delete(id);
      }
    } catch (error) {
      logger.warn('Repo job pruning failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  submitJob(submission: RepoJobSubmission): RepoJobRecord {
    this.ensureReady();

    const type = submission.type;
    const workflowTemplateId = submission.workflowTemplateId || this.resolveWorkflowTemplateId(type);
    const repoContext = this.prepareRepoContext(
      submission.workingDirectory,
      submission.branchRef,
      submission.baseBranch,
    );
    const jobId = submission.id || `repo-job-${randomUUID()}`;
    const job: RepoJobRecord = {
      id: jobId,
      taskId: jobId,
      name: this.buildJobName(submission, workflowTemplateId),
      type,
      status: 'queued',
      workingDirectory: submission.workingDirectory,
      issueOrPrUrl: submission.issueOrPrUrl,
      title: submission.title,
      description: submission.description,
      baseBranch: submission.baseBranch || repoContext.currentBranch,
      branchRef: submission.branchRef,
      workflowTemplateId,
      useWorktree: submission.useWorktree ?? type === 'issue-implementation',
      progress: 0,
      createdAt: Date.now(),
      repoContext,
      submission: {
        ...submission,
        id: jobId,
        workflowTemplateId,
      },
    };

    this.jobs.set(job.id, job);
    this.persistJob(job);

    this.taskManager.submit({
      id: job.id,
      name: job.name,
      type: taskTypeForRepoJob(type),
      payload: job.submission as unknown as Record<string, unknown>,
      priority: type === 'issue-implementation' ? 'high' : 'normal',
      timeout: DEFAULT_TIMEOUTS_MS[type],
      cancellable: true,
    });

    this.emitRepoJobEvent('repo-job:submitted', job);
    return job;
  }

  rerunJob(jobId: string): RepoJobRecord {
    const existing = this.getJob(jobId);
    if (!existing) {
      throw new Error(`Repo job not found: ${jobId}`);
    }

    const submission: RepoJobSubmission = {
      ...existing.submission,
      id: undefined,
    };
    return this.submitJob(submission);
  }

  listJobs(options?: RepoJobListOptions): RepoJobRecord[] {
    let jobs = Array.from(this.jobs.values())
      .sort((a, b) => b.createdAt - a.createdAt);

    if (options?.status) {
      jobs = jobs.filter((job) => job.status === options.status);
    }

    if (options?.type) {
      jobs = jobs.filter((job) => job.type === options.type);
    }

    if (options?.limit) {
      jobs = jobs.slice(0, options.limit);
    }

    return jobs;
  }

  getActiveJobs(): RepoJobRecord[] {
    return this.listJobs().filter((job) => job.status === 'queued' || job.status === 'running');
  }

  getJob(jobId: string): RepoJobRecord | undefined {
    return this.jobs.get(jobId);
  }

  async waitForJob(jobId: string, timeout?: number): Promise<RepoJobRecord> {
    await this.taskManager.waitFor(jobId, timeout);
    const job = this.getJob(jobId);
    if (!job) {
      throw new Error(`Repo job not found after completion: ${jobId}`);
    }
    return job;
  }

  cancelJob(jobId: string): boolean {
    const cancelled = this.taskManager.cancel(jobId);
    if (cancelled) {
      const job = this.jobs.get(jobId);
      if (job && job.status === 'queued') {
        job.status = 'cancelled';
        job.completedAt = Date.now();
        job.progressMessage = 'Cancelled before execution';
        this.persistJob(job);
        this.emitRepoJobEvent('repo-job:cancelled', job);
      }
    }
    return cancelled;
  }

  getStats(): RepoJobStats {
    const jobs = Array.from(this.jobs.values());
    return {
      queued: jobs.filter((job) => job.status === 'queued').length,
      running: jobs.filter((job) => job.status === 'running').length,
      completed: jobs.filter((job) => job.status === 'completed').length,
      failed: jobs.filter((job) => job.status === 'failed').length,
      cancelled: jobs.filter((job) => job.status === 'cancelled').length,
      total: jobs.length,
    };
  }

  private ensureReady(): void {
    if (!this.deps.instanceManager) {
      throw new Error('RepoJobService has not been initialized with an InstanceManager');
    }
  }

  private registerExecutors(): void {
    this.taskManager.registerExecutor(
      taskTypeForRepoJob('pr-review'),
      (task, context) => this.executePrReview(task, context),
    );
    this.taskManager.registerExecutor(
      taskTypeForRepoJob('issue-implementation'),
      (task, context) => this.executeIssueImplementation(task, context),
    );
    this.taskManager.registerExecutor(
      taskTypeForRepoJob('repo-health-audit'),
      (task, context) => this.executeRepoHealthAudit(task, context),
    );
  }

  private bindTaskEvents(): void {
    if (this.boundTaskEvents) {
      return;
    }

    this.boundTaskEvents = true;

    this.taskManager.on('task-started', (task: Task) => {
      const job = this.jobs.get(task.id);
      if (!job) return;
      job.status = 'running';
      job.startedAt = task.startedAt || Date.now();
      job.progress = task.progress;
      job.progressMessage = task.progressMessage;
      this.persistJob(job);
      this.emitRepoJobEvent('repo-job:started', job);
    });

    this.taskManager.on('task-progress', (payload: {
      taskId: string;
      progress: number;
      message?: string;
    }) => {
      const job = this.jobs.get(payload.taskId);
      if (!job) return;
      job.progress = payload.progress;
      job.progressMessage = payload.message;
      // Skip disk write for progress updates (too frequent) — only persist on state changes
      this.emitRepoJobEvent('repo-job:progress', job);
    });

    this.taskManager.on('task-completed', (task: Task) => {
      const job = this.jobs.get(task.id);
      if (!job) return;
      job.status = 'completed';
      job.progress = 100;
      job.progressMessage = 'Completed';
      job.completedAt = task.completedAt || Date.now();
      job.result = task.result as RepoJobResult | undefined;
      job.instanceId = job.result?.instanceId || job.instanceId;
      job.repoContext = job.result?.repoContext || job.repoContext;
      this.persistJob(job);
      this.pruneIfNeeded();
      this.emitRepoJobEvent('repo-job:completed', job);
    });

    this.taskManager.on('task-failed', (task: Task) => {
      const job = this.jobs.get(task.id);
      if (!job) return;
      job.status = 'failed';
      job.completedAt = task.completedAt || Date.now();
      job.error = task.error || 'Repo job failed';
      job.progressMessage = job.error;
      this.persistJob(job);
      this.pruneIfNeeded();
      this.emitRepoJobEvent('repo-job:failed', job);
    });

    this.taskManager.on('task-cancelled', (task: Task) => {
      const job = this.jobs.get(task.id);
      if (!job) return;
      job.status = 'cancelled';
      job.completedAt = task.completedAt || Date.now();
      job.progressMessage = 'Cancelled';
      this.persistJob(job);
      this.pruneIfNeeded();
      this.emitRepoJobEvent('repo-job:cancelled', job);
    });
  }

  private async executePrReview(
    task: Task,
    context: TaskExecutionContext,
  ): Promise<RepoJobResult> {
    const submission = context.getPayload<RepoJobSubmission>();
    const job = this.requireJob(task.id);
    await this.enrichJobFromRemoteMetadata(job, submission.workingDirectory, context);
    const repoContext = this.prepareRepoContext(
      submission.workingDirectory,
      job.branchRef,
      job.baseBranch,
    );

    job.repoContext = repoContext;
    context.reportProgress(10, 'Collecting repository context');

    const workingDirectory = repoContext.gitRoot || submission.workingDirectory;
    const instance = await this.launchJobInstance(
      job,
      workingDirectory,
      this.buildPrReviewPrompt(job, repoContext),
      'review',
    );

    job.instanceId = instance.id;

    // Track PR for CI/review reaction monitoring
    if (job.issueOrPrUrl) {
      getReactionEngine().trackInstance(instance.id, job.issueOrPrUrl);
    }

    context.reportProgress(30, 'Running PR review agent');

    const settled = await this.waitForInstanceSettled(job, instance.id, context, DEFAULT_TIMEOUTS_MS['pr-review']);
    await this.persistStructuredResult(job, settled, task.startedAt || Date.now());
    return {
      instanceId: instance.id,
      summary: this.extractInstanceSummary(settled),
      repoContext,
    };
  }

  private async executeIssueImplementation(
    task: Task,
    context: TaskExecutionContext,
  ): Promise<RepoJobResult> {
    const submission = context.getPayload<RepoJobSubmission>();
    const job = this.requireJob(task.id);
    await this.enrichJobFromRemoteMetadata(job, submission.workingDirectory, context);
    const repoContext = this.prepareRepoContext(
      submission.workingDirectory,
      job.branchRef,
      job.baseBranch,
    );

    job.repoContext = repoContext;

    const useWorktree = submission.useWorktree ?? true;
    if (useWorktree && !repoContext.isRepo) {
      throw new Error('Issue implementation jobs require a Git repository when worktree isolation is enabled');
    }

    let worktree: RepoJobWorktreeContext | undefined;
    let workingDirectory = repoContext.gitRoot || submission.workingDirectory;

    if (useWorktree) {
      context.reportProgress(10, 'Creating isolated worktree');
      const session = await this.getWorktreeManager().createWorktree(
        job.id,
        submission.title || submission.description || job.name,
        {
          baseBranch: job.baseBranch || repoContext.currentBranch,
          branchName: `repo-job-${job.id.slice(-8)}`,
          taskType: 'feature',
          repoRoot: repoContext.gitRoot || submission.workingDirectory,
        },
      );
      workingDirectory = session.worktreePath;
      worktree = {
        sessionId: session.id,
        worktreePath: session.worktreePath,
        branchName: session.branchName,
        baseBranch: session.baseBranch,
        filesChanged: [],
        totalAdditions: 0,
        totalDeletions: 0,
      };
    }

    const instance = await this.launchJobInstance(
      job,
      workingDirectory,
      this.buildIssueImplementationPrompt(job, repoContext, worktree),
      'build',
    );
    job.instanceId = instance.id;

    // Track PR for CI/review reaction monitoring
    if (job.issueOrPrUrl) {
      getReactionEngine().trackInstance(instance.id, job.issueOrPrUrl);
    }

    context.reportProgress(30, 'Running implementation agent');
    const settled = await this.waitForInstanceSettled(
      job,
      instance.id,
      context,
      DEFAULT_TIMEOUTS_MS['issue-implementation'],
    );
    await this.persistStructuredResult(job, settled, task.startedAt || Date.now());

    if (worktree && !context.isCancelled()) {
      context.reportProgress(85, 'Collecting worktree merge preview');
      const completed = await this.getWorktreeManager().completeWorktree(worktree.sessionId);
      const preview = await this.getWorktreeManager().previewMerge(worktree.sessionId);
      worktree = {
        sessionId: completed.id,
        worktreePath: completed.worktreePath,
        branchName: completed.branchName,
        baseBranch: completed.baseBranch,
        filesChanged: preview.filesChanged,
        totalAdditions: preview.totalAdditions,
        totalDeletions: preview.totalDeletions,
        canAutoMerge: preview.canAutoMerge,
        conflictFiles: preview.conflictFiles,
      };
    }

    return {
      instanceId: instance.id,
      summary: this.extractInstanceSummary(settled),
      repoContext,
      worktree,
    };
  }

  private async executeRepoHealthAudit(
    task: Task,
    context: TaskExecutionContext,
  ): Promise<RepoJobResult> {
    const submission = context.getPayload<RepoJobSubmission>();
    const job = this.requireJob(task.id);
    await this.enrichJobFromRemoteMetadata(job, submission.workingDirectory, context);
    const repoContext = this.prepareRepoContext(
      submission.workingDirectory,
      job.branchRef,
      job.baseBranch,
    );

    job.repoContext = repoContext;
    context.reportProgress(10, 'Collecting repository health context');

    const workingDirectory = repoContext.gitRoot || submission.workingDirectory;
    const instance = await this.launchJobInstance(
      job,
      workingDirectory,
      this.buildRepoHealthAuditPrompt(job, repoContext),
      'review',
    );

    job.instanceId = instance.id;
    context.reportProgress(30, 'Running health audit');

    const settled = await this.waitForInstanceSettled(
      job,
      instance.id,
      context,
      DEFAULT_TIMEOUTS_MS['repo-health-audit'],
    );
    await this.persistStructuredResult(job, settled, task.startedAt || Date.now());

    return {
      instanceId: instance.id,
      summary: this.extractInstanceSummary(settled),
      repoContext,
    };
  }

  private async launchJobInstance(
    job: RepoJobRecord,
    workingDirectory: string,
    prompt: string,
    agentId: 'build' | 'review',
  ): Promise<Instance> {
    const instanceManager = this.getInstanceManager();
    const instance = await instanceManager.createInstance({
      displayName: job.name,
      workingDirectory,
      initialPrompt: prompt,
      agentId,
      yoloMode: false,
    });
    return instance;
  }

  private async waitForInstanceSettled(
    job: RepoJobRecord,
    instanceId: string,
    context: TaskExecutionContext,
    timeoutMs: number,
  ): Promise<Instance | undefined> {
    const deadline = Date.now() + timeoutMs;
    let loopCount = 0;

    while (Date.now() < deadline) {
      if (context.isCancelled()) {
        await this.safeTerminateInstance(instanceId);
        return this.getInstanceManager().getInstance(instanceId);
      }

      const instance = this.getInstanceManager().getInstance(instanceId);
      if (!instance) {
        throw new Error(`Background instance not found: ${instanceId}`);
      }

      const hasOutput = instance.outputBuffer.some(
        (message) => message.type === 'assistant' || message.type === 'error',
      );

      if (
        hasOutput &&
        (
          instance.status === 'idle' ||
          instance.status === 'waiting_for_input' ||
          instance.status === 'terminated' ||
          instance.status === 'error'
        )
      ) {
        return instance;
      }

      loopCount += 1;
      context.reportProgress(
        Math.min(95, 35 + loopCount * 2),
        `Waiting for ${job.name} to finish`,
      );
      await this.getSleep()(1000);
    }

    await this.safeTerminateInstance(instanceId);
    throw new Error(`Timed out waiting for ${job.name} to finish`);
  }

  private async safeTerminateInstance(instanceId: string): Promise<void> {
    try {
      await this.getInstanceManager().terminateInstance?.(instanceId, true);
    } catch (error) {
      logger.warn('Failed to terminate background job instance during cleanup', {
        instanceId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private prepareRepoContext(
    workingDirectory: string,
    branchRef?: string,
    explicitBaseBranch?: string,
  ): RepoJobRepoContext {
    const gitAvailable = isGitAvailable();
    const fallback: RepoJobRepoContext = {
      gitAvailable,
      isRepo: false,
      changedFiles: [],
    };

    if (!gitAvailable) {
      return fallback;
    }

    const vcs = createVcsManager(workingDirectory);
    if (!vcs.isGitRepository()) {
      return fallback;
    }

    const gitRoot = vcs.findGitRoot() || undefined;
    const currentBranch = vcs.getCurrentBranch() || undefined;
    const baseBranch = explicitBaseBranch || this.guessBaseBranch(vcs, currentBranch);
    const defaultRemote = vcs.getDefaultRemote() || undefined;

    let changedFiles = this.collectChangedFiles(vcs.getStatus());
    let diffStats: DiffStats | undefined;

    if (branchRef && baseBranch) {
      const diff = vcs.getDiffBetween(baseBranch, branchRef);
      changedFiles = diff.files.map((file) => file.path);
      diffStats = {
        filesChanged: diff.files.length,
        insertions: diff.totalAdditions,
        deletions: diff.totalDeletions,
      };
    } else {
      diffStats = vcs.getDiffStats(false);
    }

    return {
      gitAvailable: true,
      isRepo: true,
      gitRoot,
      currentBranch,
      defaultRemote,
      changedFiles,
      diffStats,
    };
  }

  private collectChangedFiles(status: {
    staged: FileChange[];
    unstaged: FileChange[];
    untracked: string[];
  }): string[] {
    return Array.from(
      new Set([
        ...status.staged.map((file) => file.path),
        ...status.unstaged.map((file) => file.path),
        ...status.untracked,
      ]),
    );
  }

  private guessBaseBranch(
    vcs: ReturnType<typeof createVcsManager>,
    currentBranch?: string,
  ): string | undefined {
    const branches = vcs.getBranches();
    const candidates = ['main', 'master', 'develop'];
    for (const candidate of candidates) {
      const branch = branches.find((item) => item.name === candidate || item.name.endsWith(`/${candidate}`));
      if (branch) {
        return branch.name;
      }
    }
    return currentBranch;
  }

  private resolveWorkflowTemplateId(type: RepoJobType): string {
    switch (type) {
      case 'pr-review':
        return 'pr-review';
      case 'issue-implementation':
        return 'issue-implementation';
      case 'repo-health-audit':
        return 'repo-health-audit';
      default:
        return 'feature-development';
    }
  }

  private async enrichJobFromRemoteMetadata(
    job: RepoJobRecord,
    workingDirectory: string,
    context: TaskExecutionContext,
  ): Promise<void> {
    if (!job.issueOrPrUrl) {
      return;
    }

    try {
      context.reportProgress(5, 'Importing remote issue or pull request metadata');
      const metadata = await resolveGitHostMetadata(job.issueOrPrUrl, workingDirectory);
      if (!metadata) {
        return;
      }

      job.title = job.title || metadata.title;
      job.description = job.description || metadata.description;
      job.baseBranch = job.baseBranch || metadata.baseBranch;
      job.branchRef = job.branchRef || metadata.headBranch;
      job.name = this.buildJobName(
        {
          ...job.submission,
          title: job.title,
          branchRef: job.branchRef,
        },
        job.workflowTemplateId,
      );

      job.submission = {
        ...job.submission,
        title: job.title,
        description: job.description,
        baseBranch: job.baseBranch,
        branchRef: job.branchRef,
      };
    } catch (error) {
      logger.warn('Failed to import remote issue or pull request metadata for repo job', {
        jobId: job.id,
        issueOrPrUrl: job.issueOrPrUrl,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private buildJobName(submission: RepoJobSubmission, workflowTemplateId: string): string {
    const templateName = this.workflowManager.getTemplate(workflowTemplateId)?.name || workflowTemplateId;
    const target = this.describeJobTarget(submission);
    return target ? `${templateName}: ${target}` : templateName;
  }

  private describeJobTarget(submission: RepoJobSubmission): string {
    if (submission.title?.trim()) {
      return submission.title.trim();
    }

    if (submission.issueOrPrUrl?.trim()) {
      try {
        const parsed = new URL(submission.issueOrPrUrl);
        const segments = parsed.pathname.split('/').filter(Boolean);
        const tail = segments.slice(-2).join('/');
        return tail || parsed.hostname;
      } catch {
        return submission.issueOrPrUrl.trim();
      }
    }

    if (submission.branchRef?.trim()) {
      return submission.branchRef.trim();
    }

    return '';
  }

  private buildPrReviewPrompt(job: RepoJobRecord, repoContext: RepoJobRepoContext): string {
    const requiredOutput = [
      '1. Findings first, ordered by severity.',
      '2. Include file and line references for each finding.',
      '3. Focus on bugs, regressions, security issues, and missing tests.',
      '4. If there are no findings, say so explicitly and list residual risks or testing gaps.',
    ];

    if (job.submission.browserEvidence) {
      requiredOutput.push(
        '5. Attach browser evidence summaries separately from the prose review. Mention screenshots, console logs, HAR files, or traces when they were captured.',
      );
    }

    requiredOutput.push(`${requiredOutput.length + 1}. End with a concise merge recommendation.`);

    return [
      'Run a full local pull request review for this repository.',
      '',
      `Working directory: ${repoContext.gitRoot || job.workingDirectory}`,
      `Current branch: ${repoContext.currentBranch || 'unknown'}`,
      `Base branch: ${job.baseBranch || repoContext.currentBranch || 'unknown'}`,
      job.branchRef ? `Head branch: ${job.branchRef}` : '',
      repoContext.changedFiles.length > 0
        ? `Changed files (${repoContext.changedFiles.length}): ${repoContext.changedFiles.join(', ')}`
        : 'Changed files: inspect the branch diff and working tree to determine scope.',
      job.issueOrPrUrl ? `PR context URL: ${job.issueOrPrUrl}` : '',
      job.title ? `PR title: ${job.title}` : '',
      job.description ? `PR description:\n${job.description}` : '',
      job.submission.browserEvidence
        ? 'Browser evidence: enabled. If the repository exposes a runnable UI or browser-based repro path, capture screenshots plus console/network evidence and include absolute artifact paths in the final review.'
        : '',
      '',
      'Required output:',
      ...requiredOutput,
    ].filter(Boolean).join('\n');
  }

  private buildIssueImplementationPrompt(
    job: RepoJobRecord,
    repoContext: RepoJobRepoContext,
    worktree?: RepoJobWorktreeContext,
  ): string {
    return [
      'Implement the requested issue as a local background repo job.',
      '',
      `Working directory: ${(worktree?.worktreePath || repoContext.gitRoot || job.workingDirectory)}`,
      repoContext.currentBranch ? `Source branch: ${repoContext.currentBranch}` : '',
      job.baseBranch ? `Base branch: ${job.baseBranch}` : '',
      job.branchRef ? `Target branch: ${job.branchRef}` : '',
      worktree ? `Worktree branch: ${worktree.branchName}` : '',
      job.issueOrPrUrl ? `Issue URL: ${job.issueOrPrUrl}` : '',
      job.title ? `Issue title: ${job.title}` : '',
      job.description ? `Issue description:\n${job.description}` : '',
      job.submission.browserEvidence
        ? 'Browser evidence: enabled. If you can reproduce the issue through a local UI or browser flow, capture screenshots plus console/network evidence and include absolute artifact paths in the final summary.'
        : '',
      '',
      'Execution requirements:',
      '1. Investigate the code before editing.',
      '2. Keep the implementation focused and minimal.',
      '3. Follow existing repo conventions and instructions.',
      '4. Run the most relevant verification commands you can after the change.',
      job.submission.browserEvidence
        ? '5. When a UI path is available, capture browser evidence and mention the resulting artifacts in the summary.'
        : '',
      `${job.submission.browserEvidence ? '6' : '5'}. Finish with a concise implementation summary and any remaining risks.`,
      '',
      'If the issue is underspecified, make the most reasonable local assumption and state it clearly in the summary.',
    ].filter(Boolean).join('\n');
  }

  private buildRepoHealthAuditPrompt(job: RepoJobRecord, repoContext: RepoJobRepoContext): string {
    return [
      'Run a local repository health audit.',
      '',
      `Working directory: ${repoContext.gitRoot || job.workingDirectory}`,
      repoContext.currentBranch ? `Current branch: ${repoContext.currentBranch}` : '',
      repoContext.diffStats
        ? `Current diff stats: ${repoContext.diffStats.filesChanged} files, ${repoContext.diffStats.insertions} insertions, ${repoContext.diffStats.deletions} deletions`
        : '',
      job.submission.browserEvidence
        ? 'Browser evidence: enabled. If the repository exposes a runnable UI, capture screenshots plus console/network evidence and include absolute artifact paths in the audit.'
        : '',
      '',
      'Audit requirements:',
      '1. Inspect repository status and recent risky areas.',
      '2. Run the most relevant quality checks available, prioritizing TypeScript, lint, and test commands.',
      job.submission.browserEvidence
        ? '3. Capture browser evidence when a UI-based validation path exists.'
        : '',
      `${job.submission.browserEvidence ? '4' : '3'}. Report concrete findings first.`,
      `${job.submission.browserEvidence ? '5' : '4'}. If no concrete issues are found, say so and list verification gaps or blind spots.`,
      `${job.submission.browserEvidence ? '6' : '5'}. Finish with a short health summary and recommended next actions.`,
    ].filter(Boolean).join('\n');
  }

  private extractInstanceSummary(instance: Instance | undefined): string | undefined {
    if (!instance) {
      return undefined;
    }

    const assistantMessage = this.findLastMessage(instance.outputBuffer, 'assistant');
    if (assistantMessage) {
      return assistantMessage.content.slice(0, 4000);
    }

    const errorMessage = this.findLastMessage(instance.outputBuffer, 'error');
    if (errorMessage) {
      return errorMessage.content.slice(0, 4000);
    }

    return undefined;
  }

  private async persistStructuredResult(
    job: RepoJobRecord,
    instance: Instance | undefined,
    startTime: number,
  ): Promise<void> {
    if (!instance) {
      return;
    }

    try {
      const summary = this.extractInstanceSummary(instance) || `${job.name} completed`;
      await getChildResultStorage().storeFromOutputBuffer(
        instance.id,
        instance.id,
        job.description || job.title || job.name,
        summary,
        instance.status !== 'error',
        instance.outputBuffer,
        startTime,
      );
    } catch (error) {
      logger.warn('Failed to persist structured artifacts for repo job', {
        jobId: job.id,
        instanceId: instance.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private findLastMessage(
    outputBuffer: OutputMessage[],
    type: OutputMessage['type'],
  ): OutputMessage | undefined {
    for (let index = outputBuffer.length - 1; index >= 0; index -= 1) {
      if (outputBuffer[index].type === type) {
        return outputBuffer[index];
      }
    }
    return undefined;
  }

  private requireJob(jobId: string): RepoJobRecord {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Repo job not found: ${jobId}`);
    }
    return job;
  }

  private getInstanceManager(): RepoJobInstanceManager {
    const instanceManager = this.deps.instanceManager;
    if (!instanceManager) {
      throw new Error('RepoJobService has not been initialized with an InstanceManager');
    }
    return instanceManager;
  }

  private getWorktreeManager(): RepoJobWorktreeManager {
    const worktreeManager = this.deps.worktreeManager;
    if (!worktreeManager) {
      throw new Error('RepoJobService has not been initialized with a WorktreeManager');
    }
    return worktreeManager;
  }

  private getSleep(): (ms: number) => Promise<void> {
    const sleep = this.deps.sleep;
    if (!sleep) {
      throw new Error('RepoJobService has not been initialized with a sleep helper');
    }
    return sleep;
  }

  private emitRepoJobEvent(eventName: RepoJobEventName, job: RepoJobRecord): void {
    this.emit(eventName, job);
  }
}

export function getRepoJobService(): RepoJobService {
  return RepoJobService.getInstance();
}
