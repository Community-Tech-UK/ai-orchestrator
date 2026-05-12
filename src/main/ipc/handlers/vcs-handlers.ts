/**
 * VCS IPC Handlers
 * Handles Git/version control system operations
 */

import * as fs from 'fs';
import * as path from 'path';
import { ipcMain, IpcMainInvokeEvent, shell } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  VcsCheckoutBranchPayloadSchema,
  VcsCommitPayloadSchema,
  VcsDiscardFilesPayloadSchema,
  VcsFetchPayloadSchema,
  VcsFindReposPayloadSchema,
  VcsGetBlamePayloadSchema,
  VcsGetBranchesPayloadSchema,
  VcsGetCommitsPayloadSchema,
  VcsGetDiffPayloadSchema,
  VcsGetFileAtCommitPayloadSchema,
  VcsGetFileHistoryPayloadSchema,
  VcsGetStatusPayloadSchema,
  VcsIsRepoPayloadSchema,
  VcsOperationCancelPayloadSchema,
  VcsPullPayloadSchema,
  VcsPushPayloadSchema,
  VcsStageFilesPayloadSchema,
  VcsUnstageFilesPayloadSchema,
  VcsWatchReposPayloadSchema,
} from '@contracts/schemas/workspace-tools';
import { createVcsManager, isGitAvailable, VcsManager } from '../../workspace/git/vcs-manager';
import {
  getGitStatusWatcher,
  type GitStatusChangedEvent,
} from '../../workspace/git/git-status-watcher';
import { getLogger } from '../../logging/logger';
import type { WindowManager } from '../../window-manager';

const logger = getLogger('VcsHandlers');

/**
 * Phase 2d (item 10) — long-running operations registry.
 *
 * Each in-flight fetch / pull / push registers its AbortController so the
 * renderer can cancel by opId. The progress event shape mirrors
 * `CODEBASE_INDEX_PROGRESS`: a single channel that all op kinds reuse,
 * with `opId` + `kind` + phase keying.
 */
interface VcsOperationProgressEvent {
  opId: string;
  kind: 'fetch' | 'pull' | 'push';
  phase: 'started' | 'running' | 'completed' | 'cancelled' | 'failed';
  repoPath: string;
  durationMs?: number;
  message?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
}

const activeOperations = new Map<string, AbortController>();

export function registerVcsHandlers(deps?: {
  windowManager?: WindowManager;
}): void {
  // -----------------------------------------------------------------------
  // Wire the GitStatusWatcher's events to a webContents push so the
  // renderer's SourceControlStore can react. The handler is registered
  // once; the windowManager dep is optional so existing call sites that
  // skipped it keep working (handler just becomes a no-op for events).
  // -----------------------------------------------------------------------
  if (deps?.windowManager) {
    const wm = deps.windowManager;
    const watcher = getGitStatusWatcher();
    watcher.on('status-changed', (event: GitStatusChangedEvent) => {
      wm.getMainWindow()?.webContents.send(
        IPC_CHANNELS.VCS_STATUS_CHANGED,
        event,
      );
    });
  }

  // Check if working directory is a git repository
  ipcMain.handle(
    IPC_CHANNELS.VCS_IS_REPO,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VcsIsRepoPayloadSchema, payload, 'VCS_IS_REPO');
        if (!isGitAvailable()) {
          return {
            success: true,
            data: { isRepo: false, gitAvailable: false }
          };
        }
        const vcs = createVcsManager(validated.workingDirectory);
        const isRepo = vcs.isGitRepository();
        const gitRoot = isRepo ? vcs.findGitRoot() : null;
        return {
          success: true,
          data: { isRepo, gitRoot, gitAvailable: true }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VCS_IS_REPO_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get git status
  ipcMain.handle(
    IPC_CHANNELS.VCS_GET_STATUS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VcsGetStatusPayloadSchema, payload, 'VCS_GET_STATUS');
        const vcs = createVcsManager(validated.workingDirectory);
        const status = vcs.getStatus();
        return {
          success: true,
          data: status
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VCS_GET_STATUS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get branches
  ipcMain.handle(
    IPC_CHANNELS.VCS_GET_BRANCHES,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VcsGetBranchesPayloadSchema, payload, 'VCS_GET_BRANCHES');
        const vcs = createVcsManager(validated.workingDirectory);
        const branches = vcs.getBranches();
        const currentBranch = vcs.getCurrentBranch();
        return {
          success: true,
          data: { branches, currentBranch }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VCS_GET_BRANCHES_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get recent commits
  ipcMain.handle(
    IPC_CHANNELS.VCS_GET_COMMITS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VcsGetCommitsPayloadSchema, payload, 'VCS_GET_COMMITS');
        const vcs = createVcsManager(validated.workingDirectory);
        const commits = vcs.getRecentCommits(validated.limit || 50);
        return {
          success: true,
          data: commits
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VCS_GET_COMMITS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get diff
  ipcMain.handle(
    IPC_CHANNELS.VCS_GET_DIFF,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VcsGetDiffPayloadSchema, payload, 'VCS_GET_DIFF');
        const vcs = createVcsManager(validated.workingDirectory);
        let diff;

        if (validated.filePath) {
          diff = vcs.getFileDiff(validated.filePath, validated.type === 'staged');
        } else if (validated.type === 'staged') {
          diff = vcs.getStagedDiff();
        } else if (validated.type === 'unstaged') {
          diff = vcs.getUnstagedDiff();
        } else if (
          validated.type === 'between' &&
          validated.fromRef &&
          validated.toRef
        ) {
          diff = vcs.getDiffBetween(validated.fromRef, validated.toRef);
        } else {
          diff = vcs.getUnstagedDiff();
        }

        const stats = vcs.getDiffStats(validated.type === 'staged');

        return {
          success: true,
          data: { diff, stats }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VCS_GET_DIFF_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get file history
  ipcMain.handle(
    IPC_CHANNELS.VCS_GET_FILE_HISTORY,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VcsGetFileHistoryPayloadSchema, payload, 'VCS_GET_FILE_HISTORY');
        const vcs = createVcsManager(validated.workingDirectory);
        const history = vcs.getFileHistory(
          validated.filePath,
          validated.limit || 20
        );
        const isTracked = vcs.isFileTracked(validated.filePath);
        return {
          success: true,
          data: { history, isTracked }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VCS_GET_FILE_HISTORY_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Get file at specific commit
  ipcMain.handle(
    IPC_CHANNELS.VCS_GET_FILE_AT_COMMIT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VcsGetFileAtCommitPayloadSchema, payload, 'VCS_GET_FILE_AT_COMMIT');
        const vcs = createVcsManager(validated.workingDirectory);
        const content = vcs.getFileAtCommit(
          validated.filePath,
          validated.commitHash
        );
        return {
          success: true,
          data: { content }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VCS_GET_FILE_AT_COMMIT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // Replace the watcher's set of tracked repos. Renderer calls this
  // whenever `vcsFindRepos` discovers a new repo list (or returns []
  // when the instance is deselected → stop all watchers).
  ipcMain.handle(
    IPC_CHANNELS.VCS_WATCH_REPOS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VcsWatchReposPayloadSchema, payload, 'VCS_WATCH_REPOS');
        if (!isGitAvailable()) {
          return { success: true, data: { watchedCount: 0, gitAvailable: false } };
        }
        const watcher = getGitStatusWatcher();
        await watcher.setRepos(validated.repoPaths);
        return {
          success: true,
          data: { watchedCount: watcher.watchedRepos().length, gitAvailable: true },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VCS_WATCH_REPOS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Find all nested git repositories under a directory.
  // Used by the renderer Source Control panel to enumerate repos in the
  // selected instance's working directory (matches VS Code SCM behavior
  // where every nested repo is surfaced).
  ipcMain.handle(
    IPC_CHANNELS.VCS_FIND_REPOS,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VcsFindReposPayloadSchema, payload, 'VCS_FIND_REPOS');
        if (!isGitAvailable()) {
          return {
            success: true,
            data: { repositories: [], gitAvailable: false },
          };
        }
        const repositories = VcsManager.findRepositories(
          validated.rootPath,
          validated.ignorePatterns ?? []
        );
        return {
          success: true,
          data: { repositories, gitAvailable: true },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VCS_FIND_REPOS_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Get blame for file
  ipcMain.handle(
    IPC_CHANNELS.VCS_GET_BLAME,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VcsGetBlamePayloadSchema, payload, 'VCS_GET_BLAME');
        const vcs = createVcsManager(validated.workingDirectory);
        const blame = vcs.getBlame(validated.filePath);
        return {
          success: true,
          data: { blame }
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VCS_GET_BLAME_FAILED',
            message: (error as Error).message,
            timestamp: Date.now()
          }
        };
      }
    }
  );

  // ---------------------------------------------------------------------
  // Phase 2d (item 7) — stage / unstage write actions.
  // The renderer wraps each call in a store-managed write token so
  // GitStatusWatcher events emitted by these very commands are coalesced
  // instead of triggering mid-flight refreshes.
  // ---------------------------------------------------------------------

  // Stage files: `git add -- <paths>`
  ipcMain.handle(
    IPC_CHANNELS.VCS_STAGE_FILES,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VcsStageFilesPayloadSchema, payload, 'VCS_STAGE_FILES');
        if (!isGitAvailable()) {
          return {
            success: false,
            error: {
              code: 'VCS_STAGE_FILES_FAILED',
              message: 'Git is not installed or not on PATH.',
              timestamp: Date.now(),
            },
          };
        }
        const vcs = createVcsManager(validated.workingDirectory);
        const result = await vcs.stageFiles(validated.filePaths);
        return {
          success: true,
          data: {
            stagedCount: validated.filePaths.length,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: result.durationMs,
            exitCode: result.exitCode,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VCS_STAGE_FILES_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // Unstage files: `git restore --staged -- <paths>`
  ipcMain.handle(
    IPC_CHANNELS.VCS_UNSTAGE_FILES,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VcsUnstageFilesPayloadSchema, payload, 'VCS_UNSTAGE_FILES');
        if (!isGitAvailable()) {
          return {
            success: false,
            error: {
              code: 'VCS_UNSTAGE_FILES_FAILED',
              message: 'Git is not installed or not on PATH.',
              timestamp: Date.now(),
            },
          };
        }
        const vcs = createVcsManager(validated.workingDirectory);
        const result = await vcs.unstageFiles(validated.filePaths);
        return {
          success: true,
          data: {
            unstagedCount: validated.filePaths.length,
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: result.durationMs,
            exitCode: result.exitCode,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VCS_UNSTAGE_FILES_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    }
  );

  // ---------------------------------------------------------------------
  // Phase 2d (item 8) — discard changes.
  //
  // Per the plan: "Discard" is three distinct git operations and the bare
  // `git restore <file>` (worktree only) is almost never what users mean.
  // We dispatch per-path:
  //   - tracked path → `git restore --source=HEAD --staged --worktree`
  //   - untracked path (file or directory) → `shell.trashItem` so the
  //     user can recover from the system Trash.
  // ---------------------------------------------------------------------
  ipcMain.handle(
    IPC_CHANNELS.VCS_DISCARD_FILES,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VcsDiscardFilesPayloadSchema, payload, 'VCS_DISCARD_FILES');
        if (!isGitAvailable()) {
          return {
            success: false,
            error: {
              code: 'VCS_DISCARD_FILES_FAILED',
              message: 'Git is not installed or not on PATH.',
              timestamp: Date.now(),
            },
          };
        }

        const vcs = createVcsManager(validated.workingDirectory);
        const status = vcs.getStatus();

        // Build the set of tracked paths visible to git (staged + unstaged).
        // The untracked list is path-only strings.
        const trackedSet = new Set<string>();
        for (const f of status.staged) trackedSet.add(f.path);
        for (const f of status.unstaged) trackedSet.add(f.path);
        const untrackedSet = new Set<string>(status.untracked);

        const trackedPaths: string[] = [];
        const trashPaths: string[] = [];
        const trashFailures: { path: string; error: string }[] = [];

        for (const p of validated.filePaths) {
          if (trackedSet.has(p)) {
            trackedPaths.push(p);
            continue;
          }
          if (untrackedSet.has(p)) {
            trashPaths.push(p);
            continue;
          }
          // Path the renderer asked about isn't in `git status`. Could be
          // a stale snapshot or a manual selection. Try to recover by
          // checking the filesystem; if it exists, treat it as untracked,
          // else skip silently.
          const abs = path.resolve(validated.workingDirectory, p);
          try {
            if (fs.existsSync(abs)) {
              trashPaths.push(p);
            }
          } catch {
            // ignore — pretend the path doesn't exist
          }
        }

        // Untracked first: send each to the system Trash. shell.trashItem
        // takes an absolute path; if it fails we collect the error and
        // continue so a partial run reports both successes and failures.
        for (const p of trashPaths) {
          const abs = path.resolve(validated.workingDirectory, p);
          try {
            await shell.trashItem(abs);
          } catch (err) {
            trashFailures.push({ path: p, error: (err as Error).message });
            logger.warn('shell.trashItem failed', { path: abs, error: (err as Error).message });
          }
        }

        // Tracked second: a single `git restore` call covers them all.
        let restoreResult: { stdout: string; stderr: string; durationMs: number; exitCode: number } | null = null;
        if (trackedPaths.length > 0) {
          const r = await vcs.discardTracked(trackedPaths);
          restoreResult = {
            stdout: r.stdout,
            stderr: r.stderr,
            durationMs: r.durationMs,
            exitCode: r.exitCode,
          };
        }

        return {
          success: true,
          data: {
            discardedTracked: trackedPaths.length,
            discardedUntracked: trashPaths.length - trashFailures.length,
            failedUntracked: trashFailures,
            restore: restoreResult,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VCS_DISCARD_FILES_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  // ---------------------------------------------------------------------
  // Phase 2d (item 9) — commit.
  // ---------------------------------------------------------------------
  ipcMain.handle(
    IPC_CHANNELS.VCS_COMMIT,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VcsCommitPayloadSchema, payload, 'VCS_COMMIT');
        if (!isGitAvailable()) {
          return {
            success: false,
            error: {
              code: 'VCS_COMMIT_FAILED',
              message: 'Git is not installed or not on PATH.',
              timestamp: Date.now(),
            },
          };
        }
        const vcs = createVcsManager(validated.workingDirectory);
        const result = await vcs.commit({
          message: validated.message,
          signoff: validated.signoff,
          amend: validated.amend,
        });
        return {
          success: true,
          data: {
            stdout: result.stdout,
            stderr: result.stderr,
            durationMs: result.durationMs,
            exitCode: result.exitCode,
          },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VCS_COMMIT_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );

  // ---------------------------------------------------------------------
  // Phase 2d (item 10) — fetch / pull / push + cancel.
  // Long-running ops use a shared `runProgressOp` so the renderer sees
  // a consistent `VCS_OPERATION_PROGRESS` shape and a cancellation
  // contract.
  // ---------------------------------------------------------------------

  function sendProgress(event: VcsOperationProgressEvent): void {
    if (!deps?.windowManager) return;
    const win = deps.windowManager.getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.VCS_OPERATION_PROGRESS, event);
    }
  }

  ipcMain.handle(
    IPC_CHANNELS.VCS_FETCH,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VcsFetchPayloadSchema, payload, 'VCS_FETCH');
        if (!isGitAvailable()) {
          return {
            success: false,
            error: { code: 'VCS_FETCH_FAILED', message: 'Git is not installed or not on PATH.', timestamp: Date.now() },
          };
        }
        return runLongRunningOp({
          opId: validated.opId,
          kind: 'fetch',
          repoPath: validated.workingDirectory,
          sendProgress,
          run: (signal) => {
            const vcs = createVcsManager(validated.workingDirectory);
            return vcs.fetch({ remote: validated.remote, prune: validated.prune, signal });
          },
          failedCode: 'VCS_FETCH_FAILED',
        });
      } catch (error) {
        return {
          success: false,
          error: { code: 'VCS_FETCH_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.VCS_PULL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VcsPullPayloadSchema, payload, 'VCS_PULL');
        if (!isGitAvailable()) {
          return {
            success: false,
            error: { code: 'VCS_PULL_FAILED', message: 'Git is not installed or not on PATH.', timestamp: Date.now() },
          };
        }
        return runLongRunningOp({
          opId: validated.opId,
          kind: 'pull',
          repoPath: validated.workingDirectory,
          sendProgress,
          run: (signal) => {
            const vcs = createVcsManager(validated.workingDirectory);
            return vcs.pullFastForward({
              remote: validated.remote,
              branch: validated.branch,
              signal,
            });
          },
          failedCode: 'VCS_PULL_FAILED',
        });
      } catch (error) {
        return {
          success: false,
          error: { code: 'VCS_PULL_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.VCS_PUSH,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VcsPushPayloadSchema, payload, 'VCS_PUSH');
        if (!isGitAvailable()) {
          return {
            success: false,
            error: { code: 'VCS_PUSH_FAILED', message: 'Git is not installed or not on PATH.', timestamp: Date.now() },
          };
        }
        return runLongRunningOp({
          opId: validated.opId,
          kind: 'push',
          repoPath: validated.workingDirectory,
          sendProgress,
          run: (signal) => {
            const vcs = createVcsManager(validated.workingDirectory);
            return vcs.push({
              remote: validated.remote,
              branch: validated.branch,
              forceWithLease: validated.forceWithLease,
              setUpstream: validated.setUpstream,
              signal,
            });
          },
          failedCode: 'VCS_PUSH_FAILED',
        });
      } catch (error) {
        return {
          success: false,
          error: { code: 'VCS_PUSH_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.VCS_OPERATION_CANCEL,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VcsOperationCancelPayloadSchema, payload, 'VCS_OPERATION_CANCEL');
        const controller = activeOperations.get(validated.opId);
        if (!controller) {
          return { success: true, data: { cancelled: false, reason: 'unknown opId or already finished' } };
        }
        controller.abort();
        return { success: true, data: { cancelled: true } };
      } catch (error) {
        return {
          success: false,
          error: { code: 'VCS_OPERATION_CANCEL_FAILED', message: (error as Error).message, timestamp: Date.now() },
        };
      }
    },
  );

  // ---------------------------------------------------------------------
  // Phase 2d (item 11) — branch checkout.
  // ---------------------------------------------------------------------
  ipcMain.handle(
    IPC_CHANNELS.VCS_CHECKOUT_BRANCH,
    async (
      _event: IpcMainInvokeEvent,
      payload: unknown,
    ): Promise<IpcResponse> => {
      try {
        const validated = validateIpcPayload(VcsCheckoutBranchPayloadSchema, payload, 'VCS_CHECKOUT_BRANCH');
        if (!isGitAvailable()) {
          return {
            success: false,
            error: {
              code: 'VCS_CHECKOUT_BRANCH_FAILED',
              message: 'Git is not installed or not on PATH.',
              timestamp: Date.now(),
            },
          };
        }
        const vcs = createVcsManager(validated.workingDirectory);
        const outcome = await vcs.checkoutBranch(validated.branchName, {
          force: validated.force,
        });
        if (outcome.success) {
          return {
            success: true,
            data: {
              stdout: outcome.result?.stdout ?? '',
              stderr: outcome.result?.stderr ?? '',
              durationMs: outcome.result?.durationMs ?? 0,
              exitCode: outcome.result?.exitCode ?? 0,
            },
          };
        }
        // Structured failure — distinguishes dirty-tree from terminal errors
        // so the renderer can prompt and retry with `force: true`.
        return {
          success: false,
          error: {
            code: outcome.dirty ? 'VCS_CHECKOUT_BRANCH_DIRTY_TREE' : 'VCS_CHECKOUT_BRANCH_FAILED',
            message: outcome.errorMessage ?? 'checkout failed',
            timestamp: Date.now(),
          },
          data: { dirty: !!outcome.dirty },
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: 'VCS_CHECKOUT_BRANCH_FAILED',
            message: (error as Error).message,
            timestamp: Date.now(),
          },
        };
      }
    },
  );
}

/**
 * Phase 2d (item 10) shared runner for long-running fetch / pull / push.
 *
 * Registers the op's AbortController so the renderer can cancel by
 * `opId`, emits start / completed / failed / cancelled progress events,
 * and ensures the registry is cleared on every exit path.
 */
async function runLongRunningOp(opts: {
  opId: string;
  kind: 'fetch' | 'pull' | 'push';
  repoPath: string;
  sendProgress: (event: VcsOperationProgressEvent) => void;
  run: (signal: AbortSignal) => Promise<{
    stdout: string;
    stderr: string;
    durationMs: number;
    exitCode: number;
  }>;
  failedCode: string;
}): Promise<IpcResponse> {
  const { opId, kind, repoPath, sendProgress, run, failedCode } = opts;
  if (activeOperations.has(opId)) {
    return {
      success: false,
      error: {
        code: failedCode,
        message: `Operation already in progress for opId ${opId}`,
        timestamp: Date.now(),
      },
    };
  }
  const controller = new AbortController();
  activeOperations.set(opId, controller);
  sendProgress({ opId, kind, phase: 'started', repoPath });
  try {
    const result = await run(controller.signal);
    if (controller.signal.aborted) {
      sendProgress({
        opId,
        kind,
        phase: 'cancelled',
        repoPath,
        durationMs: result.durationMs,
      });
      return {
        success: false,
        error: {
          code: 'VCS_OPERATION_CANCELLED',
          message: `${kind} cancelled by user`,
          timestamp: Date.now(),
        },
      };
    }
    sendProgress({
      opId,
      kind,
      phase: 'completed',
      repoPath,
      durationMs: result.durationMs,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    });
    return {
      success: true,
      data: {
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs: result.durationMs,
        exitCode: result.exitCode,
      },
    };
  } catch (error) {
    const wasCancelled = controller.signal.aborted ||
      (error as { name?: string }).name === 'AbortError';
    if (wasCancelled) {
      sendProgress({ opId, kind, phase: 'cancelled', repoPath });
      return {
        success: false,
        error: {
          code: 'VCS_OPERATION_CANCELLED',
          message: `${kind} cancelled by user`,
          timestamp: Date.now(),
        },
      };
    }
    const message = error instanceof Error ? error.message : String(error);
    sendProgress({ opId, kind, phase: 'failed', repoPath, message });
    return {
      success: false,
      error: { code: failedCode, message, timestamp: Date.now() },
    };
  } finally {
    activeOperations.delete(opId);
  }
}
