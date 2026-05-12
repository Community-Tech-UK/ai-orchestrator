/**
 * VCS IPC Handlers
 * Handles Git/version control system operations
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  VcsFindReposPayloadSchema,
  VcsGetBlamePayloadSchema,
  VcsGetBranchesPayloadSchema,
  VcsGetCommitsPayloadSchema,
  VcsGetDiffPayloadSchema,
  VcsGetFileAtCommitPayloadSchema,
  VcsGetFileHistoryPayloadSchema,
  VcsGetStatusPayloadSchema,
  VcsIsRepoPayloadSchema,
  VcsStageFilesPayloadSchema,
  VcsUnstageFilesPayloadSchema,
  VcsWatchReposPayloadSchema,
} from '@contracts/schemas/workspace-tools';
import { createVcsManager, isGitAvailable, VcsManager } from '../../workspace/git/vcs-manager';
import {
  getGitStatusWatcher,
  type GitStatusChangedEvent,
} from '../../workspace/git/git-status-watcher';
import type { WindowManager } from '../../window-manager';

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
}
