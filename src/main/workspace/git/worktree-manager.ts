/**
 * WorktreeManager - Manages git worktrees for parallel agent development
 *
 * Hardened in P4: all git calls use execFile (not exec/shell), cleanupWorktree
 * refuses dirty trees, harvestWorktree captures uncommitted session output,
 * the 48h stale age signal is removed (reap on truth, never on time), and
 * abandoned branch deletion is suppressed so the user can review the work.
 * P5: write ops are serialized through GitWriteQueue to prevent .git lock races.
 * P6: gc.auto is set to 0 on worktree creation to prevent auto-gc from racing
 * concurrent worktree git reads.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { EventEmitter } from 'events';
import {
  WorktreeConfig,
  WorktreeSession,
  WorktreeMergePreview,
  WorktreeMergeResult,
  MergeStrategy,
  CrossWorktreeConflict,
  WorktreeCommit,
  createDefaultWorktreeConfig,
  sanitizeBranchName,
} from '../../../shared/types/worktree.types';
import { getLogger } from '../../logging/logger';
import { getGitWriteQueue } from './git-write-queue';
import { hermeticGitEnv } from './git-env';
import { provisionWorktreeDependencies } from './worktree-deps';
import { assignWorktreeRendererPort } from './worktree-port';
import {
  integrateViaWorktree,
  integrateIntoSharedBranch,
  tryAdvanceBaseBranch,
  type SharedIntegrationResult,
} from './worktree-integration';

const logger = getLogger('WorktreeManager');

const execFileAsync = promisify(execFile);

/** Run a git command safely — array args, no shell interpolation. */
async function gitExec(args: string[], cwd: string, timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    // Strip inherited GIT_DIR/GIT_INDEX_FILE/etc. (set when running inside a git
    // hook) so the command resolves its repo purely from cwd. Without this,
    // worktree ops run under a commit hook hit `.git/index: Not a directory`.
    env: hermeticGitEnv(),
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: timeoutMs,
  });
  return typeof stdout === 'string' ? stdout.trim() : String(stdout).trim();
}

/** Run git and return stdout, empty string on failure. */
async function gitExecSafe(args: string[], cwd: string): Promise<string> {
  try {
    return await gitExec(args, cwd);
  } catch {
    return '';
  }
}

export class WorktreeManager extends EventEmitter {
  private static instance: WorktreeManager | null = null;
  private sessions: Map<string, WorktreeSession> = new Map();
  private config: WorktreeConfig;
  private healthCheckInterval?: NodeJS.Timeout;
  /** P5: cycle counter so we run gc at most once per 12 health-check intervals (~1h). */
  private gcCycleCount = 0;
  /** P7: renderer ports reserved by live sessions, so siblings don't collide. */
  private reservedPorts = new Set<number>();

  static getInstance(): WorktreeManager {
    if (!this.instance) {
      this.instance = new WorktreeManager();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    WorktreeManager.instance = null;
  }

  // P4: constructor does not arm the health monitor so that injecting or
  // acquiring the singleton via getInstance() is side-effect-free. Call
  // startHealthMonitor() explicitly from app init code when desired.
  private constructor() {
    super();
    this.config = createDefaultWorktreeConfig();
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

    const repoRoot = options?.repoRoot || (await gitExec(['rev-parse', '--show-toplevel'], process.cwd()));
    const baseBranch = options?.baseBranch || (await gitExec(['branch', '--show-current'], repoRoot));
    const baseCommit = await gitExec(['rev-parse', 'HEAD'], repoRoot);

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
      await fs.mkdir(path.dirname(worktreePath), { recursive: true });

      await getGitWriteQueue().enqueue('worktree-add', () =>
        gitExec(['worktree', 'add', '-b', branchName, worktreePath, baseBranch], repoRoot)
      );

      // P6: suppress auto-gc so agent git reads can't trigger an unserialized gc
      // on the shared .git. Best-effort; failure doesn't block worktree creation.
      void gitExecSafe(['config', 'gc.auto', '0'], worktreePath);

      // P7: assign a per-session renderer port and write the mise local override
      // so this worktree's renderer/smoke tooling doesn't collide on 4567.
      try {
        const port = await assignWorktreeRendererPort(worktreePath, { exclude: this.reservedPorts });
        this.reservedPorts.add(port);
        session.rendererPort = port;
      } catch (portErr) {
        logger.warn('WorktreeManager: renderer port assignment failed (non-fatal)', {
          worktreePath,
          message: portErr instanceof Error ? portErr.message : String(portErr),
        });
      }

      await this.copyConfigFiles(repoRoot, worktreePath);

      session.status = 'installing';
      this.emit('worktree:installing', session);

      if (this.config.installDeps && !options?.skipInstall) {
        await this.installDependencies(repoRoot, worktreePath);
      }

      session.status = 'active';
      session.lastActivity = Date.now();
      this.emit('worktree:created', session);

      return session;
    } catch (error) {
      session.status = 'abandoned';
      this.emit('worktree:error', { session, error });

      try {
        await this.cleanupWorktree(session.id, { force: true });
      } catch {
        /* intentionally ignored: cleanup errors should not mask the original error */
      }

      throw error;
    }
  }

  private async copyConfigFiles(repoRoot: string, worktreePath: string): Promise<void> {
    for (const pattern of this.config.copyInclude) {
      try {
        const matches = await fs.glob(pattern, {
          cwd: repoRoot,
          exclude: (p: string) => this.config.copyExclude.some((excl) => {
            if (excl.endsWith('/**')) {
              return p.startsWith(excl.slice(0, -3));
            }
            return p === excl;
          }),
        });

        for await (const match of matches) {
          const srcPath = path.join(repoRoot, match);
          const destPath = path.join(worktreePath, match);

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

  /**
   * P6: near-instant spin-up. Clone the root node_modules with an APFS
   * copy-on-write clone (symlink-preserving), then assert the workspace
   * symlinks and verify/repair the native-ABI binary. Falls back to a plain
   * copy and finally the configured install command on EXDEV/non-APFS.
   */
  private async installDependencies(repoRoot: string, worktreePath: string): Promise<void> {
    try {
      const { method, symlinks, nativeAbi } = await provisionWorktreeDependencies(
        repoRoot,
        worktreePath,
        { installCommand: this.config.installCommand },
      );
      const brokenLinks = symlinks.filter((s) => !s.ok);
      const badAbi = nativeAbi.filter((a) => a.status === 'missing');
      logger.info('WorktreeManager: dependencies provisioned', {
        worktreePath,
        method,
        brokenLinks: brokenLinks.length > 0 ? brokenLinks : undefined,
        missingAbi: badAbi.length > 0 ? badAbi.map((a) => a.module) : undefined,
      });
    } catch (error: unknown) {
      const err = error as { message?: string };
      logger.warn('Dependency provisioning warning', { worktreePath, message: err.message });
    }
  }

  async completeWorktree(worktreeId: string): Promise<WorktreeSession> {
    const session = this.sessions.get(worktreeId);
    if (!session) throw new Error(`Worktree not found: ${worktreeId}`);

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

  /**
   * Adopt an existing on-disk worktree that was created in a previous process
   * (e.g. after a crash + restore). Registers it in the in-memory session map
   * so harvest/cleanup can be called on it in the normal terminate path, without
   * re-running git worktree add.
   *
   * Idempotent: returns the existing session if the path is already registered.
   */
  async adoptWorktree(
    instanceId: string,
    worktreePath: string,
    taskDescription: string,
  ): Promise<WorktreeSession> {
    const existing = [...this.sessions.values()].find((s) => s.worktreePath === worktreePath);
    if (existing) return existing;

    // Derive branch/base from the live worktree — no disk writes, read-only.
    const branchName = await gitExecSafe(['branch', '--show-current'], worktreePath);
    const baseCommit = await gitExecSafe(['rev-parse', 'HEAD'], worktreePath);

    const session: WorktreeSession = {
      id: `wt-adopted-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      instanceId,
      worktreePath,
      branchName: branchName || `task-restored-${Date.now().toString(36)}`,
      baseBranch: '',
      baseCommit: baseCommit || '',
      status: 'active',
      lastActivity: Date.now(),
      commits: [],
      filesChanged: [],
      additions: 0,
      deletions: 0,
      createdAt: Date.now(),
      taskDescription,
      taskType: 'feature',
    };

    this.sessions.set(session.id, session);
    return session;
  }

  /**
   * Harvest uncommitted changes from a worktree into a commit on its branch.
   * This captures agent output before reap — agents follow AGENTS.md which says
   * "NEVER commit" so the orchestrator commits on their behalf.
   */
  async harvestWorktree(worktreeId: string): Promise<{ committed: boolean; hasUncommittedWork: boolean; hash?: string }> {
    const session = this.sessions.get(worktreeId);
    if (!session) throw new Error(`Worktree not found: ${worktreeId}`);

    try {
      const status = await gitExecSafe(['status', '--porcelain'], session.worktreePath);
      if (!status.trim()) {
        return { committed: false, hasUncommittedWork: false };
      }

      const result = await getGitWriteQueue().enqueue('harvest', async () => {
        await gitExec(['add', '-A'], session.worktreePath);
        const msg = `Harvest: orchestrator captured session output\n\nWorktree: ${session.branchName}\nTask: ${session.taskDescription.slice(0, 120)}`;
        await gitExec(['commit', '--no-gpg-sign', '-m', msg], session.worktreePath);
        return gitExec(['rev-parse', 'HEAD'], session.worktreePath);
      });

      logger.info('WorktreeManager: harvested uncommitted changes', { worktreeId, hash: result });
      return { committed: true, hasUncommittedWork: true, hash: result };
    } catch (error) {
      logger.error('WorktreeManager: harvest failed', error instanceof Error ? error : undefined, { worktreeId });
      // hasUncommittedWork=true signals to the caller that work exists but commit failed;
      // the worktree must NOT be force-removed to avoid data loss.
      return { committed: false, hasUncommittedWork: true };
    }
  }

  /**
   * Check whether `candidate` is an ancestor of `target` in the git history
   * at `cwd`. Used by reap logic to confirm a branch has been merged before
   * removing the worktree.
   */
  async isBranchAncestor(candidate: string, target: string, cwd: string): Promise<boolean> {
    try {
      await gitExec(['merge-base', '--is-ancestor', candidate, target], cwd);
      return true; // exits 0 when true
    } catch {
      return false; // exits non-zero when not an ancestor
    }
  }

  // ============ Cross-Worktree Conflict Detection ============

  async detectCrossWorktreeConflicts(currentId: string, currentFiles: string[]): Promise<CrossWorktreeConflict[]> {
    const conflicts: CrossWorktreeConflict[] = [];

    for (const [id, session] of this.sessions) {
      if (id === currentId) continue;
      if (!['active', 'completed'].includes(session.status)) continue;

      const otherFiles =
        session.filesChanged.length > 0 ? session.filesChanged : (await this.getWorktreeStats(session)).filesChanged;

      const overlap = currentFiles.filter((f) => otherFiles.includes(f));

      for (const file of overlap) {
        const existing = conflicts.find((c) => c.file === file);
        if (existing) {
          existing.worktrees.push(id);
        } else {
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

    if (/\.(ts|js|tsx|jsx|py|go|rs)$/.test(file)) {
      return 'medium';
    }

    return 'low';
  }

  private suggestMergeOrder(id1: string, id2: string): string[] {
    const session1 = this.sessions.get(id1);
    const session2 = this.sessions.get(id2);

    if (!session1 || !session2) return [id1, id2];

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
    const repoRoot = await gitExec(['rev-parse', '--show-toplevel'], session.worktreePath);

    const commits = await this.getCommitsSince(session, session.baseCommit);

    let canAutoMerge = true;
    let conflictFiles: string[] = [];
    let previewDiff = '';

    try {
      const mergeBase = await gitExec(['merge-base', targetBranch, session.branchName], repoRoot);

      const mergeTree = await gitExec(
        ['merge-tree', mergeBase, targetBranch, session.branchName],
        repoRoot
      );

      if (mergeTree.includes('<<<<<<<') || mergeTree.includes('=======')) {
        canAutoMerge = false;
        const conflictMatches = mergeTree.match(/^[+-]{3} [ab]\/(.+)$/gm);
        if (conflictMatches) {
          conflictFiles = [...new Set(conflictMatches.map((m) => m.replace(/^[+-]{3} [ab]\//, '')))];
        }
      }

      previewDiff = mergeTree;
    } catch (error: unknown) {
      const err = error as { stdout?: string };
      if (err.stdout?.includes('<<<<<<<')) {
        canAutoMerge = false;
      }
    }

    const diffStat = await gitExecSafe(['diff', '--stat', `${session.baseCommit}..${session.branchName}`], repoRoot);

    const filesChanged = diffStat
      .split('\n')
      .filter((l) => l.includes('|'))
      .map((l) => l.split('|')[0].trim());

    const crossConflicts = await this.detectCrossWorktreeConflicts(worktreeId, filesChanged);

    return {
      worktreeId,
      targetBranch,
      strategy,
      canAutoMerge: canAutoMerge && crossConflicts.filter((c) => c.severity === 'high').length === 0,
      conflictFiles,
      conflictDetails: [],
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
      /**
       * P4 (opt-in): run the merge in a dedicated detached integration worktree
       * instead of the root checkout. Used by the isolation lifecycle; the 5
       * legacy callers leave this unset and keep the root-checkout semantics.
       */
      useIntegrationWorktree?: boolean;
      integrationBranch?: string;
    }
  ): Promise<WorktreeMergeResult> {
    const session = this.sessions.get(worktreeId);
    if (!session) throw new Error(`Worktree not found: ${worktreeId}`);

    const repoRoot = await gitExec(['rev-parse', '--show-toplevel'], session.worktreePath);
    const strategy = options?.strategy || this.config.defaultStrategy;

    if (options?.useIntegrationWorktree) {
      return this.mergeViaIntegrationWorktree(session, repoRoot, strategy, options);
    }

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
      // Legacy root-checkout merge path, kept for the 5 existing callers
      // (branch-select, parallel coordinator, repo-job, campaign, IPC handler).
      // The isolation lifecycle opts into mergeViaIntegrationWorktree() instead,
      // which never touches the root checkout. Serialize through the queue to
      // reduce .git lock contention on this path.
      const mergeCommit = await getGitWriteQueue().enqueue('merge', async () => {
        await gitExec(['checkout', session.baseBranch], repoRoot);

        try {
          await gitExec(['pull', '--ff-only'], repoRoot);
        } catch {
          /* intentionally ignored: pull may fail if no remote is configured */
        }

        switch (strategy) {
          case 'squash':
            await gitExec(['merge', '--squash', session.branchName], repoRoot);
            break;
          case 'rebase':
            await gitExec(['checkout', session.branchName], repoRoot);
            await gitExec(['rebase', session.baseBranch], repoRoot);
            await gitExec(['checkout', session.baseBranch], repoRoot);
            await gitExec(['merge', '--ff-only', session.branchName], repoRoot);
            break;
          case 'manual':
            throw new Error('Manual merge strategy requires user intervention');
          default:
            await gitExec(['merge', '--no-ff', session.branchName], repoRoot);
        }

        if (strategy === 'squash') {
          const commitMessage =
            options?.commitMessage ||
            `Merge worktree: ${session.taskDescription}\n\n` +
              `Branch: ${session.branchName}\n` +
              `Commits: ${session.commits.length}\n` +
              `Files: ${session.filesChanged.length}`;
          await gitExec(['commit', '-m', commitMessage], repoRoot);
        }

        return gitExec(['rev-parse', 'HEAD'], repoRoot);
      });

      session.status = 'merged';
      session.mergedAt = Date.now();
      this.emit('worktree:merged', session);

      if (this.config.autoCleanup) {
        await this.cleanupWorktree(worktreeId);
      }

      return {
        success: true,
        worktreeId,
        mergeCommit,
      };
    } catch (error: unknown) {
      session.status = 'conflict';
      this.emit('worktree:conflict', { session, error });

      try {
        await getGitWriteQueue().enqueue('merge-abort', () =>
          gitExec(['merge', '--abort'], repoRoot)
        );
      } catch {
        /* intentionally ignored */
      }

      const err = error as { message?: string };
      return {
        success: false,
        worktreeId,
        error: err.message,
      };
    }
  }

  /**
   * P4 opt-in: merge by integrating the session branch in a dedicated detached
   * worktree (never the root checkout). Produces an isolated integration branch;
   * does NOT auto-cleanup the session worktree (the caller owns reap timing).
   */
  private async mergeViaIntegrationWorktree(
    session: WorktreeSession,
    repoRoot: string,
    strategy: MergeStrategy,
    options?: { commitMessage?: string; integrationBranch?: string },
  ): Promise<WorktreeMergeResult> {
    session.status = 'merging';
    this.emit('worktree:merging', session);

    const result = await integrateViaWorktree({
      repoRoot,
      baseDir: this.config.baseDir,
      sessionBranch: session.branchName,
      targetBranch: session.baseBranch,
      strategy,
      commitMessage: options?.commitMessage,
      integrationBranch: options?.integrationBranch,
    });

    if (result.success) {
      session.status = 'merged';
      session.mergedAt = Date.now();
      this.emit('worktree:merged', session);
      return {
        success: true,
        worktreeId: session.id,
        mergeCommit: result.mergeCommit,
        integrationBranch: result.integrationBranch,
      };
    }

    session.status = 'conflict';
    this.emit('worktree:conflict', { session, error: result.error });
    return {
      success: false,
      worktreeId: session.id,
      error: result.error,
      manualResolutionRequired: result.conflictFiles,
    };
  }

  /**
   * Auto-integrate a session's branch into the shared, accumulating integration
   * branch (`integration/<baseBranch>` by default) via a dedicated integration
   * worktree — never the root checkout. On success marks the session `merged`;
   * optionally fast-forwards the base branch when it is not checked out anywhere.
   * Used by the loop terminal-success path. Safe to call after harvest.
   */
  async integrateWorktree(
    worktreeId: string,
    options?: { strategy?: MergeStrategy; integrationBranch?: string; advanceBaseIfUnchecked?: boolean },
  ): Promise<SharedIntegrationResult & { baseAdvanced?: boolean }> {
    const session = this.sessions.get(worktreeId);
    if (!session) throw new Error(`Worktree not found: ${worktreeId}`);

    const repoRoot = await gitExec(['rev-parse', '--show-toplevel'], session.worktreePath);
    const baseBranch = session.baseBranch || (await gitExec(['branch', '--show-current'], repoRoot));
    const integrationBranch = options?.integrationBranch ?? `integration/${baseBranch}`;
    const strategy = options?.strategy ?? this.config.defaultStrategy;

    session.status = 'merging';
    this.emit('worktree:merging', session);

    const result = await integrateIntoSharedBranch({
      repoRoot,
      baseDir: this.config.baseDir,
      sessionBranch: session.branchName,
      integrationBranch,
      baseBranch,
      strategy,
    });

    if (!result.success) {
      session.status = 'conflict';
      this.emit('worktree:conflict', { session, error: result.error });
      return result;
    }

    session.status = 'merged';
    session.mergedAt = Date.now();
    this.emit('worktree:merged', session);

    let baseAdvanced = false;
    if (options?.advanceBaseIfUnchecked) {
      baseAdvanced = await tryAdvanceBaseBranch(repoRoot, baseBranch, integrationBranch);
    }
    return { ...result, baseAdvanced };
  }

  /**
   * Remove a worktree from disk and deregister it.
   *
   * Safety: by default refuses to remove a worktree with uncommitted changes
   * (call harvestWorktree first, or abandonWorktree to keep the branch).
   * Pass `force: true` only when the caller has already preserved the work
   * (e.g. after a harvest or when the session is in `abandoned` status).
   */
  async cleanupWorktree(worktreeId: string, options?: { force?: boolean }): Promise<void> {
    const session = this.sessions.get(worktreeId);
    if (!session) return;

    const repoRoot = await gitExecSafe(['rev-parse', '--show-toplevel'], session.worktreePath)
      || await gitExec(['rev-parse', '--show-toplevel'], process.cwd());

    // Guard: refuse to silently discard uncommitted work unless caller opts in.
    if (!options?.force && session.status !== 'abandoned') {
      const statusOut = await gitExecSafe(['status', '--porcelain'], session.worktreePath);
      if (statusOut.trim()) {
        throw new Error(
          `Worktree ${worktreeId} (${session.branchName}) has uncommitted changes. ` +
          `Call harvestWorktree() first, or abandonWorktree() to preserve the branch.`
        );
      }
    }

    try {
      await getGitWriteQueue().enqueue('worktree-remove', () =>
        gitExec(['worktree', 'remove', '--force', session.worktreePath], repoRoot)
      );

      if (session.status === 'merged') {
        // Only delete the branch after it has been fully merged.
        await gitExecSafe(['branch', '-d', session.branchName], repoRoot);
      }
      // Abandoned branches are intentionally kept — the user can review the work.

      // P7: release the reserved renderer port so it can be reused.
      if (session.rendererPort) {
        this.reservedPorts.delete(session.rendererPort);
      }

      this.sessions.delete(worktreeId);
      this.emit('worktree:cleaned', session);
    } catch (error) {
      logger.error('Failed to cleanup worktree', error instanceof Error ? error : undefined, { worktreeId });
    }
  }

  // ============ Health Monitoring ============

  /** Start the periodic health-check interval. Call explicitly from app init. */
  startHealthMonitor(): void {
    if (this.healthCheckInterval) return; // idempotent
    this.healthCheckInterval = setInterval(async () => {
      await this.runHealthChecks();
    }, 5 * 60 * 1000);
  }

  private async runHealthChecks(): Promise<void> {
    const now = Date.now();

    for (const [, session] of this.sessions) {
      // P4: stale age signal removed — reap on truth (merged or abandoned),
      // never on time. A listener on `worktree:stale` that removes the worktree
      // would be the classic "auto-cleanup races the agent" bug.
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

    // P5: compensating gc — gc.auto 0 is set per worktree to prevent unserialized
    // auto-gc, but that means objects accumulate indefinitely. Run a full gc on the
    // repo root once per ~hour (every 12 health-check cycles at 5-min intervals).
    this.gcCycleCount++;
    if (this.gcCycleCount >= 12) {
      this.gcCycleCount = 0;
      const activeSessions = [...this.sessions.values()].filter((s) => s.status === 'active');
      if (activeSessions.length > 0) {
        const repoRoot = await gitExecSafe(
          ['rev-parse', '--show-toplevel'],
          activeSessions[0].worktreePath,
        );
        if (repoRoot) {
          logger.debug('WorktreeManager: running periodic git gc on repo root', { repoRoot });
          void getGitWriteQueue().enqueue('periodic-gc', () =>
            gitExecSafe(['gc', '--auto'], repoRoot),
          );
        }
      }
    }
  }

  private async getDirSize(dirPath: string): Promise<number> {
    try {
      const { stdout } = await execFileAsync('du', ['-sm', dirPath], {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      return parseInt(String(stdout).trim().split('\t')[0]) || 0;
    } catch {
      return 0;
    }
  }

  // ============ Helper Methods ============

  private async getRepoRoot(cwd?: string): Promise<string> {
    return gitExec(['rev-parse', '--show-toplevel'], cwd || process.cwd());
  }

  private async getCurrentBranch(cwd?: string): Promise<string> {
    return gitExec(['branch', '--show-current'], cwd || process.cwd());
  }

  private async getHeadCommit(cwd?: string): Promise<string> {
    return gitExec(['rev-parse', 'HEAD'], cwd || process.cwd());
  }

  private async getCommitsSince(session: WorktreeSession, since: string): Promise<WorktreeCommit[]> {
    try {
      const stdout = await gitExecSafe(
        ['log', `${since}..${session.branchName}`, '--pretty=format:%H|%s|%an|%at', '--name-only'],
        session.worktreePath
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
      const diffStat = await gitExecSafe(
        ['diff', '--shortstat', `${session.baseCommit}..HEAD`],
        session.worktreePath
      );

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
      // Pass force=true: abandoned means the caller accepts losing uncommitted
      // work, or has already harvested it.
      await this.cleanupWorktree(worktreeId, { force: true });
    }

    return session;
  }

  // ============ Synchronization ============

  async syncWithRemote(worktreeId: string): Promise<{ ahead: number; behind: number }> {
    const session = this.sessions.get(worktreeId);
    if (!session) throw new Error(`Worktree not found: ${worktreeId}`);

    await gitExecSafe(['fetch', 'origin'], session.worktreePath);

    try {
      const aheadBehind = await gitExec(
        ['rev-list', '--left-right', '--count', `${session.baseBranch}...origin/${session.baseBranch}`],
        session.worktreePath
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
      this.healthCheckInterval = undefined;
    }
  }
}

// Singleton accessor
let worktreeManagerInstance: WorktreeManager | null = null;

export function getWorktreeManager(): WorktreeManager {
  if (!worktreeManagerInstance) {
    worktreeManagerInstance = WorktreeManager.getInstance();
    // Start the health monitor once, on first app-level use. Tests that acquire
    // the singleton via _resetForTesting() + getInstance() directly (without
    // going through this function) never arm the interval.
    worktreeManagerInstance.startHealthMonitor();
  }
  return worktreeManagerInstance;
}

export function _resetWorktreeManagerForTesting(): void {
  if (worktreeManagerInstance) {
    worktreeManagerInstance.destroy();
  }
  worktreeManagerInstance = null;
  WorktreeManager._resetForTesting();
}
