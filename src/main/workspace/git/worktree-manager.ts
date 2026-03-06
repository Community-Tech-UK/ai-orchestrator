/**
 * WorktreeManager - Manages git worktrees for parallel agent development
 * Based on validated patterns from CodeRabbit git-worktree-runner, Nx, incident.io
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
  WorktreeConfig,
  WorktreeSession,
  WorktreeStatus,
  WorktreeMergePreview,
  WorktreeMergeResult,
  MergeStrategy,
  CrossWorktreeConflict,
  WorktreeHealthCheck,
  WorktreeCommit,
  createDefaultWorktreeConfig,
  sanitizeBranchName,
} from '../../../shared/types/worktree.types';
import { getLogger } from '../../logging/logger';

const logger = getLogger('WorktreeManager');

const execAsync = promisify(exec);

export class WorktreeManager extends EventEmitter {
  private static instance: WorktreeManager | null = null;
  private sessions: Map<string, WorktreeSession> = new Map();
  private config: WorktreeConfig;
  private healthCheckInterval?: NodeJS.Timeout;

  static getInstance(): WorktreeManager {
    if (!this.instance) {
      this.instance = new WorktreeManager();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    WorktreeManager.instance = null;
  }

  private constructor() {
    super();
    this.config = createDefaultWorktreeConfig();
    this.startHealthMonitor();
  }

  configure(config: Partial<WorktreeConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): WorktreeConfig {
    return { ...this.config };
  }

  // ============ Worktree Lifecycle ============

  async createWorktree(
    instanceId: string,
    taskDescription: string,
    options?: {
      baseBranch?: string;
      branchName?: string;
      taskType?: WorktreeSession['taskType'];
      skipInstall?: boolean;
      repoRoot?: string;
    }
  ): Promise<WorktreeSession> {
    // Check concurrent limit
    const activeCount = Array.from(this.sessions.values()).filter((s) =>
      ['active', 'creating', 'installing'].includes(s.status)
    ).length;

    if (activeCount >= this.config.maxConcurrent) {
      throw new Error(
        `Maximum concurrent worktrees (${this.config.maxConcurrent}) reached. ` +
          `Complete or abandon existing worktrees before creating new ones.`
      );
    }

    const repoRoot = options?.repoRoot || (await this.getRepoRoot());
    const baseBranch = options?.baseBranch || (await this.getCurrentBranch(repoRoot));
    const baseCommit = await this.getHeadCommit(repoRoot);

    // Generate unique branch name (validated pattern from industry)
    const timestamp = Date.now();
    const sanitizedDesc = sanitizeBranchName(taskDescription);
    const branchName = options?.branchName || `${this.config.prefix}${sanitizedDesc}-${timestamp.toString(36)}`;

    const worktreePath = path.join(repoRoot, this.config.baseDir, branchName);

    const session: WorktreeSession = {
      id: `wt-${timestamp}-${Math.random().toString(36).substr(2, 6)}`,
      instanceId,
      worktreePath,
      branchName,
      baseBranch,
      baseCommit,
      status: 'creating',
      lastActivity: Date.now(),
      commits: [],
      filesChanged: [],
      additions: 0,
      deletions: 0,
      createdAt: Date.now(),
      taskDescription,
      taskType: options?.taskType || 'feature',
    };

    this.sessions.set(session.id, session);
    this.emit('worktree:creating', session);

    try {
      // Create worktree directory
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });

      // Create new branch and worktree
      await execAsync(`git worktree add -b "${branchName}" "${worktreePath}" "${baseBranch}"`, { cwd: repoRoot });

      // Copy config files using glob patterns (CodeRabbit pattern)
      await this.copyConfigFiles(repoRoot, worktreePath);

      session.status = 'installing';
      this.emit('worktree:installing', session);

      // Install dependencies if configured
      if (this.config.installDeps && !options?.skipInstall) {
        await this.installDependencies(worktreePath);
      }

      session.status = 'active';
      session.lastActivity = Date.now();
      this.emit('worktree:created', session);

      return session;
    } catch (error) {
      session.status = 'abandoned';
      this.emit('worktree:error', { session, error });

      // Cleanup failed worktree
      try {
        await this.cleanupWorktree(session.id);
      } catch {
        /* intentionally ignored: cleanup errors should not mask the original error */
      }

      throw error;
    }
  }

  private async copyConfigFiles(repoRoot: string, worktreePath: string): Promise<void> {
    for (const pattern of this.config.copyInclude) {
      try {
        // Use Node.js built-in fs.glob (Node 22+)
        const matches = await fs.glob(pattern, {
          cwd: repoRoot,
          exclude: (p: string) => this.config.copyExclude.some((excl) => {
            // Simple glob-like matching for exclusions
            if (excl.endsWith('/**')) {
              return p.startsWith(excl.slice(0, -3));
            }
            return p === excl;
          }),
        });

        for await (const match of matches) {
          const srcPath = path.join(repoRoot, match);
          const destPath = path.join(worktreePath, match);

          // Ensure directory exists
          await fs.mkdir(path.dirname(destPath), { recursive: true });

          try {
            await fs.copyFile(srcPath, destPath);
          } catch {
            /* intentionally ignored: config file may not exist at source path */
          }
        }
      } catch {
        /* intentionally ignored: glob pattern may not match any files */
      }
    }
  }

  private async installDependencies(worktreePath: string): Promise<void> {
    const packageJsonPath = path.join(worktreePath, 'package.json');

    try {
      await fs.access(packageJsonPath);
      await execAsync(this.config.installCommand!, {
        cwd: worktreePath,
        timeout: 300000, // 5 minute timeout
      });
    } catch (error: unknown) {
      const err = error as { code?: string; message?: string };
      if (err.code !== 'ENOENT') {
        // Log but don't fail - installation issues shouldn't block worktree
        logger.warn('Dependency installation warning', { worktreePath, message: err.message });
      }
    }
  }

  async completeWorktree(worktreeId: string): Promise<WorktreeSession> {
    const session = this.sessions.get(worktreeId);
    if (!session) throw new Error(`Worktree not found: ${worktreeId}`);

    // Get final stats
    const stats = await this.getWorktreeStats(session);
    session.commits = stats.commits;
    session.filesChanged = stats.filesChanged;
    session.additions = stats.additions;
    session.deletions = stats.deletions;
    session.status = 'completed';
    session.completedAt = Date.now();

    this.emit('worktree:completed', session);
    return session;
  }

  // ============ Cross-Worktree Conflict Detection (Critical for Parallel Agents) ============

  async detectCrossWorktreeConflicts(currentId: string, currentFiles: string[]): Promise<CrossWorktreeConflict[]> {
    const conflicts: CrossWorktreeConflict[] = [];

    // Check all other active/completed worktrees
    for (const [id, session] of this.sessions) {
      if (id === currentId) continue;
      if (!['active', 'completed'].includes(session.status)) continue;

      // Get files changed in other worktree
      const otherFiles =
        session.filesChanged.length > 0 ? session.filesChanged : (await this.getWorktreeStats(session)).filesChanged;

      // Find overlapping files
      const overlap = currentFiles.filter((f) => otherFiles.includes(f));

      for (const file of overlap) {
        const existing = conflicts.find((c) => c.file === file);
        if (existing) {
          existing.worktrees.push(id);
        } else {
          // Assess severity based on file type
          const severity = this.assessConflictSeverity(file);

          conflicts.push({
            file,
            worktrees: [currentId, id],
            description: `File modified in multiple worktrees: ${file}`,
            severity,
            mergeOrder: this.suggestMergeOrder(currentId, id),
          });
        }
      }
    }

    return conflicts;
  }

  private assessConflictSeverity(file: string): 'high' | 'medium' | 'low' {
    // High severity: core files that are likely to have logical conflicts
    const highSeverityPatterns = [
      /package\.json$/,
      /package-lock\.json$/,
      /\.lock$/,
      /schema\./,
      /migration/,
      /index\.(ts|js|tsx|jsx)$/,
    ];

    if (highSeverityPatterns.some((p) => p.test(file))) {
      return 'high';
    }

    // Medium severity: source files
    if (/\.(ts|js|tsx|jsx|py|go|rs)$/.test(file)) {
      return 'medium';
    }

    return 'low';
  }

  private suggestMergeOrder(id1: string, id2: string): string[] {
    const session1 = this.sessions.get(id1);
    const session2 = this.sessions.get(id2);

    if (!session1 || !session2) return [id1, id2];

    // Suggest merging smaller changes first
    if (session1.additions + session1.deletions < session2.additions + session2.deletions) {
      return [id1, id2];
    }
    return [id2, id1];
  }

  // ============ Merge Operations ============

  async previewMerge(
    worktreeId: string,
    options?: { strategy?: MergeStrategy; targetBranch?: string }
  ): Promise<WorktreeMergePreview> {
    const session = this.sessions.get(worktreeId);
    if (!session) throw new Error(`Worktree not found: ${worktreeId}`);

    const targetBranch = options?.targetBranch || session.baseBranch;
    const strategy = options?.strategy || this.config.defaultStrategy;
    const repoRoot = await this.getRepoRoot(session.worktreePath);

    // Get commits since base
    const commits = await this.getCommitsSince(session, session.baseCommit);

    // Check for conflicts using merge-tree (non-destructive)
    let canAutoMerge = true;
    let conflictFiles: string[] = [];
    let previewDiff = '';

    try {
      // Get merge base
      const { stdout: mergeBase } = await execAsync(`git merge-base ${targetBranch} ${session.branchName}`, {
        cwd: repoRoot,
      });

      // Dry-run merge using merge-tree
      const { stdout: mergeTree } = await execAsync(
        `git merge-tree ${mergeBase.trim()} ${targetBranch} ${session.branchName}`,
        { cwd: repoRoot }
      );

      // Check for conflict markers
      if (mergeTree.includes('<<<<<<<') || mergeTree.includes('=======')) {
        canAutoMerge = false;
        // Extract conflicting file names
        const conflictMatches = mergeTree.match(/^[+-]{3} [ab]\/(.+)$/gm);
        if (conflictMatches) {
          conflictFiles = [...new Set(conflictMatches.map((m) => m.replace(/^[+-]{3} [ab]\//, '')))];
        }
      }

      previewDiff = mergeTree;
    } catch (error: unknown) {
      // merge-tree exits with error on conflicts
      const err = error as { stdout?: string };
      if (err.stdout?.includes('<<<<<<<')) {
        canAutoMerge = false;
      }
    }

    // Get diff stats
    const { stdout: diffStat } = await execAsync(`git diff --stat ${session.baseCommit}..${session.branchName}`, {
      cwd: repoRoot,
    });

    const filesChanged = diffStat
      .split('\n')
      .filter((l) => l.includes('|'))
      .map((l) => l.split('|')[0].trim());

    // CRITICAL: Check for cross-worktree conflicts
    const crossConflicts = await this.detectCrossWorktreeConflicts(worktreeId, filesChanged);

    return {
      worktreeId,
      targetBranch,
      strategy,
      canAutoMerge: canAutoMerge && crossConflicts.filter((c) => c.severity === 'high').length === 0,
      conflictFiles,
      conflictDetails: [], // Populated on demand
      commits,
      totalAdditions: session.additions,
      totalDeletions: session.deletions,
      filesChanged,
      crossConflicts: crossConflicts.length > 0 ? crossConflicts : undefined,
      previewDiff,
    };
  }

  async mergeWorktree(
    worktreeId: string,
    options?: {
      strategy?: MergeStrategy;
      commitMessage?: string;
      allowConflicts?: boolean;
    }
  ): Promise<WorktreeMergeResult> {
    const session = this.sessions.get(worktreeId);
    if (!session) throw new Error(`Worktree not found: ${worktreeId}`);

    const repoRoot = await this.getRepoRoot(session.worktreePath);
    const strategy = options?.strategy || this.config.defaultStrategy;

    // Pre-merge checks
    const preview = await this.previewMerge(worktreeId, { strategy });

    if (!preview.canAutoMerge && !options?.allowConflicts) {
      return {
        success: false,
        worktreeId,
        error: 'Cannot auto-merge. Conflicts detected.',
        manualResolutionRequired: preview.conflictFiles,
      };
    }

    session.status = 'merging';
    this.emit('worktree:merging', session);

    try {
      // Checkout target branch in main repo
      await execAsync(`git checkout ${session.baseBranch}`, { cwd: repoRoot });

      // Pull latest changes
      try {
        await execAsync(`git pull --ff-only`, { cwd: repoRoot });
      } catch {
        /* intentionally ignored: pull may fail if no remote is configured */
      }

      // Perform merge based on strategy
      let mergeCommand: string;
      switch (strategy) {
        case 'squash':
          mergeCommand = `git merge --squash ${session.branchName}`;
          break;
        case 'rebase':
          // For rebase, we rebase the worktree branch onto target, then fast-forward
          await execAsync(`git checkout ${session.branchName}`, { cwd: repoRoot });
          await execAsync(`git rebase ${session.baseBranch}`, { cwd: repoRoot });
          await execAsync(`git checkout ${session.baseBranch}`, { cwd: repoRoot });
          mergeCommand = `git merge --ff-only ${session.branchName}`;
          break;
        case 'manual':
          throw new Error('Manual merge strategy requires user intervention');
        default:
          mergeCommand = `git merge --no-ff ${session.branchName}`;
      }

      await execAsync(mergeCommand, { cwd: repoRoot });

      // For squash, we need an explicit commit
      if (strategy === 'squash') {
        const commitMessage =
          options?.commitMessage ||
          `Merge worktree: ${session.taskDescription}\n\n` +
            `Branch: ${session.branchName}\n` +
            `Commits: ${session.commits.length}\n` +
            `Files: ${session.filesChanged.length}`;
        await execAsync(`git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, { cwd: repoRoot });
      }

      const { stdout: mergeCommit } = await execAsync('git rev-parse HEAD', { cwd: repoRoot });

      session.status = 'merged';
      session.mergedAt = Date.now();
      this.emit('worktree:merged', session);

      // Cleanup if configured
      if (this.config.autoCleanup) {
        await this.cleanupWorktree(worktreeId);
      }

      return {
        success: true,
        worktreeId,
        mergeCommit: mergeCommit.trim(),
      };
    } catch (error: unknown) {
      session.status = 'conflict';
      this.emit('worktree:conflict', { session, error });

      // Abort failed merge
      try {
        await execAsync('git merge --abort', { cwd: repoRoot });
      } catch {
        /* intentionally ignored: merge abort may fail if no merge is in progress */
      }

      const err = error as { message?: string };
      return {
        success: false,
        worktreeId,
        error: err.message,
      };
    }
  }

  async cleanupWorktree(worktreeId: string): Promise<void> {
    const session = this.sessions.get(worktreeId);
    if (!session) return;

    const repoRoot = await this.getRepoRoot(session.worktreePath);

    try {
      // Remove worktree
      await execAsync(`git worktree remove "${session.worktreePath}" --force`, { cwd: repoRoot });

      // Delete branch if merged
      if (session.status === 'merged') {
        await execAsync(`git branch -d "${session.branchName}"`, { cwd: repoRoot });
      } else if (session.status === 'abandoned') {
        // Force delete abandoned branch
        await execAsync(`git branch -D "${session.branchName}"`, { cwd: repoRoot });
      }

      this.sessions.delete(worktreeId);
      this.emit('worktree:cleaned', session);
    } catch (error) {
      // Cleanup failed, but don't throw
      logger.error('Failed to cleanup worktree', error instanceof Error ? error : undefined, { worktreeId });
    }
  }

  // ============ Health Monitoring ============

  private startHealthMonitor(): void {
    // Check every 5 minutes
    this.healthCheckInterval = setInterval(async () => {
      await this.runHealthChecks();
    }, 5 * 60 * 1000);
  }

  private async runHealthChecks(): Promise<void> {
    const now = Date.now();
    const maxAgeMs = this.config.maxAgeHours * 60 * 60 * 1000;

    for (const [id, session] of this.sessions) {
      // Check for stale worktrees
      if (session.status === 'active' && now - session.lastActivity > maxAgeMs) {
        this.emit('worktree:stale', session);
      }

      // Health check active worktrees
      if (['active', 'installing'].includes(session.status)) {
        try {
          const stat = await fs.stat(session.worktreePath);
          session.healthCheck = {
            lastCheck: now,
            isHealthy: stat.isDirectory(),
            issues: [],
            agentResponsive: true,
            diskUsageMB: await this.getDirSize(session.worktreePath),
          };
        } catch {
          session.healthCheck = {
            lastCheck: now,
            isHealthy: false,
            issues: ['Worktree directory not accessible'],
            agentResponsive: false,
            diskUsageMB: 0,
          };
        }
      }
    }
  }

  private async getDirSize(dirPath: string): Promise<number> {
    try {
      const { stdout } = await execAsync(`du -sm "${dirPath}" | cut -f1`);
      return parseInt(stdout.trim()) || 0;
    } catch {
      return 0;
    }
  }

  // ============ Helper Methods ============

  private async getRepoRoot(cwd?: string): Promise<string> {
    const { stdout } = await execAsync('git rev-parse --show-toplevel', { cwd });
    return stdout.trim();
  }

  private async getCurrentBranch(cwd?: string): Promise<string> {
    const { stdout } = await execAsync('git branch --show-current', { cwd });
    return stdout.trim();
  }

  private async getHeadCommit(cwd?: string): Promise<string> {
    const { stdout } = await execAsync('git rev-parse HEAD', { cwd });
    return stdout.trim();
  }

  private async getCommitsSince(session: WorktreeSession, since: string): Promise<WorktreeCommit[]> {
    try {
      const { stdout } = await execAsync(
        `git log ${since}..${session.branchName} --pretty=format:"%H|%s|%an|%at" --name-only`,
        { cwd: session.worktreePath }
      );

      const commits: WorktreeCommit[] = [];
      const lines = stdout.split('\n');
      let currentCommit: WorktreeCommit | null = null;

      for (const line of lines) {
        if (line.includes('|')) {
          if (currentCommit) commits.push(currentCommit);
          const [hash, message, author, timestamp] = line.split('|');
          currentCommit = {
            hash,
            message,
            author,
            timestamp: parseInt(timestamp) * 1000,
            filesChanged: [],
          };
        } else if (line.trim() && currentCommit) {
          currentCommit.filesChanged.push(line.trim());
        }
      }

      if (currentCommit) commits.push(currentCommit);
      return commits;
    } catch {
      return [];
    }
  }

  private async getWorktreeStats(session: WorktreeSession): Promise<{
    commits: WorktreeCommit[];
    filesChanged: string[];
    additions: number;
    deletions: number;
  }> {
    const commits = await this.getCommitsSince(session, session.baseCommit);

    try {
      const { stdout: diffStat } = await execAsync(`git diff --shortstat ${session.baseCommit}..HEAD`, {
        cwd: session.worktreePath,
      });

      let additions = 0;
      let deletions = 0;
      const addMatch = diffStat.match(/(\d+) insertion/);
      const delMatch = diffStat.match(/(\d+) deletion/);
      if (addMatch) additions = parseInt(addMatch[1]);
      if (delMatch) deletions = parseInt(delMatch[1]);

      const filesChanged = [...new Set(commits.flatMap((c) => c.filesChanged))];

      return { commits, filesChanged, additions, deletions };
    } catch {
      return { commits, filesChanged: [], additions: 0, deletions: 0 };
    }
  }

  // ============ Queries ============

  getSession(worktreeId: string): WorktreeSession | undefined {
    return this.sessions.get(worktreeId);
  }

  getSessionsByInstance(instanceId: string): WorktreeSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.instanceId === instanceId);
  }

  getActiveSessions(): WorktreeSession[] {
    return Array.from(this.sessions.values()).filter((s) => ['active', 'completed'].includes(s.status));
  }

  getAllSessions(): WorktreeSession[] {
    return Array.from(this.sessions.values());
  }

  // Alias for IPC handler compatibility
  listSessions(): WorktreeSession[] {
    return this.getAllSessions();
  }

  async abandonWorktree(worktreeId: string, reason?: string): Promise<WorktreeSession> {
    const session = this.sessions.get(worktreeId);
    if (!session) throw new Error(`Worktree not found: ${worktreeId}`);

    session.status = 'abandoned';
    if (reason) {
      (session as WorktreeSession & { abandonReason?: string }).abandonReason = reason;
    }
    this.emit('worktree:abandoned', session);

    if (this.config.autoCleanup) {
      await this.cleanupWorktree(worktreeId);
    }

    return session;
  }

  // ============ Synchronization ============

  async syncWithRemote(worktreeId: string): Promise<{ ahead: number; behind: number }> {
    const session = this.sessions.get(worktreeId);
    if (!session) throw new Error(`Worktree not found: ${worktreeId}`);

    // Fetch latest from remote
    await execAsync('git fetch origin', { cwd: session.worktreePath });

    // Check if base branch has new commits
    try {
      const { stdout: aheadBehind } = await execAsync(
        `git rev-list --left-right --count ${session.baseBranch}...origin/${session.baseBranch}`,
        { cwd: session.worktreePath }
      );

      const [ahead, behind] = aheadBehind.trim().split('\t').map(Number);

      if (behind > 0) {
        this.emit('worktree:sync-available', { session, behind });
      }

      return { ahead, behind };
    } catch {
      return { ahead: 0, behind: 0 };
    }
  }

  updateActivity(worktreeId: string): void {
    const session = this.sessions.get(worktreeId);
    if (session) {
      session.lastActivity = Date.now();
    }
  }

  destroy(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
  }
}

// Singleton accessor
let worktreeManagerInstance: WorktreeManager | null = null;

export function getWorktreeManager(): WorktreeManager {
  if (!worktreeManagerInstance) {
    worktreeManagerInstance = WorktreeManager.getInstance();
  }
  return worktreeManagerInstance;
}

export function _resetWorktreeManagerForTesting(): void {
  worktreeManagerInstance = null;
  WorktreeManager._resetForTesting();
}
