/**
 * VCS IPC Service - Git/VCS operations
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';

@Injectable({ providedIn: 'root' })
export class VcsIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  // ============================================
  // VCS (Git) Operations
  // ============================================

  /**
   * Check if working directory is a git repository
   */
  async vcsIsRepo(workingDirectory: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsIsRepo(workingDirectory);
  }

  /**
   * Get git status for working directory
   */
  async vcsGetStatus(workingDirectory: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsGetStatus(workingDirectory);
  }

  /**
   * Get branches for working directory
   */
  async vcsGetBranches(workingDirectory: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsGetBranches(workingDirectory);
  }

  /**
   * Get recent commits
   */
  async vcsGetCommits(workingDirectory: string, limit?: number): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsGetCommits(workingDirectory, limit);
  }

  /**
   * Get diff (staged, unstaged, or between refs)
   */
  async vcsGetDiff(payload: {
    workingDirectory: string;
    type: 'staged' | 'unstaged' | 'between';
    fromRef?: string;
    toRef?: string;
    filePath?: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsGetDiff(payload);
  }

  /**
   * Get file history (commits that modified the file)
   */
  async vcsGetFileHistory(workingDirectory: string, filePath: string, limit?: number): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsGetFileHistory(workingDirectory, filePath, limit);
  }

  /**
   * Get file content at a specific commit
   */
  async vcsGetFileAtCommit(workingDirectory: string, filePath: string, commitHash: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsGetFileAtCommit(workingDirectory, filePath, commitHash);
  }

  /**
   * Get blame information for a file
   */
  async vcsGetBlame(workingDirectory: string, filePath: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsGetBlame(workingDirectory, filePath);
  }

  /**
   * Find all nested git repositories under a directory (recursive scan).
   * Used by the Source Control panel.
   */
  async vcsFindRepos(rootPath: string, ignorePatterns?: string[]): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsFindRepos(rootPath, ignorePatterns);
  }

  /**
   * Replace the set of repos the main-process watcher tracks. Pass
   * `[]` to stop all watchers (e.g. when the instance is deselected).
   */
  async vcsWatchRepos(repoPaths: string[]): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsWatchRepos(repoPaths);
  }

  /**
   * Subscribe to git-status-changed events pushed by the main-process
   * watcher. Returns an unsubscribe function (no-op outside Electron).
   */
  onVcsStatusChanged(
    callback: (event: { repoPath: string; reason: string; timestamp: number }) => void
  ): () => void {
    if (!this.api) return () => { /* no-op */ };
    return this.api.onVcsStatusChanged(callback);
  }

  /**
   * Stage one or more files (`git add -- <paths>`).
   *
   * Phase 2d — item 7 of the source-control phase-2 plan. The caller
   * (the SourceControlStore) wraps invocations in a write-token so the
   * GitStatusWatcher events emitted by `git add` itself are coalesced
   * instead of triggering mid-flight refreshes.
   */
  async vcsStageFiles(payload: {
    workingDirectory: string;
    filePaths: string[];
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsStageFiles(payload);
  }

  /**
   * Unstage one or more files (`git restore --staged -- <paths>`).
   * Only the index side is touched; worktree contents are preserved.
   */
  async vcsUnstageFiles(payload: {
    workingDirectory: string;
    filePaths: string[];
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsUnstageFiles(payload);
  }
}
