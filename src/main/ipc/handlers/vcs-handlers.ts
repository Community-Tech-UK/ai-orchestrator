/**
 * VCS IPC Handlers
 * Handles Git/version control system operations
 */

import { ipcMain, IpcMainInvokeEvent } from 'electron';
import { IPC_CHANNELS, IpcResponse } from '../../../shared/types/ipc.types';
import { validateIpcPayload } from '@contracts/schemas/common';
import {
  VcsGetBlamePayloadSchema,
  VcsGetBranchesPayloadSchema,
  VcsGetCommitsPayloadSchema,
  VcsGetDiffPayloadSchema,
  VcsGetFileAtCommitPayloadSchema,
  VcsGetFileHistoryPayloadSchema,
  VcsGetStatusPayloadSchema,
  VcsIsRepoPayloadSchema,
} from '@contracts/schemas/workspace-tools';
import { createVcsManager, isGitAvailable } from '../../workspace/git/vcs-manager';

export function registerVcsHandlers(): void {
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
}
