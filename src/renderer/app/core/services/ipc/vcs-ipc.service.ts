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

  // ============================================
  // Phase 2d items 8 / 9 / 10 / 11
  // ============================================

  /**
   * Phase 2d (item 8) — discard changes. The handler dispatches per-path
   * between `git restore --source=HEAD --staged --worktree` (tracked)
   * and Electron's `shell.trashItem` (untracked file or directory).
   */
  async vcsDiscardFiles(payload: {
    workingDirectory: string;
    filePaths: string[];
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsDiscardFiles(payload);
  }

  /** Phase 2d (item 9) — commit the staged set. */
  async vcsCommit(payload: {
    workingDirectory: string;
    message: string;
    signoff?: boolean;
    amend?: boolean;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsCommit(payload);
  }

  /** Phase 2d (item 10) — fetch. Streams progress via `onVcsOperationProgress`. */
  async vcsFetch(payload: {
    workingDirectory: string;
    remote?: string;
    prune?: boolean;
    opId: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsFetch(payload);
  }

  /** Phase 2d (item 10) — pull (fast-forward only). */
  async vcsPull(payload: {
    workingDirectory: string;
    remote?: string;
    branch?: string;
    opId: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsPull(payload);
  }

  /** Phase 2d (item 10) — push. */
  async vcsPush(payload: {
    workingDirectory: string;
    remote?: string;
    branch?: string;
    forceWithLease?: boolean;
    setUpstream?: boolean;
    opId: string;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsPush(payload);
  }

  /** Phase 2d (item 10) — cancel an in-flight long-running operation. */
  async vcsOperationCancel(payload: { opId: string }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsOperationCancel(payload);
  }

  /**
   * Phase 2d (item 10) — subscribe to operation progress.
   * Returns an unsubscribe function (no-op outside Electron).
   */
  onVcsOperationProgress(
    callback: (event: {
      opId: string;
      kind: 'fetch' | 'pull' | 'push';
      phase: 'started' | 'running' | 'completed' | 'cancelled' | 'failed';
      repoPath: string;
      durationMs?: number;
      message?: string;
      stdout?: string;
      stderr?: string;
      exitCode?: number | null;
    }) => void,
  ): () => void {
    if (!this.api) return () => { /* no-op */ };
    return this.api.onVcsOperationProgress(callback);
  }

  /** Phase 2d (item 11) — branch checkout. */
  async vcsCheckoutBranch(payload: {
    workingDirectory: string;
    branchName: string;
    force?: boolean;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.vcsCheckoutBranch(payload);
  }

  /** Phase 2d (item 11) — list branches (uses existing channel). */
  async vcsListBranches(workingDirectory: string): Promise<IpcResponse> {
    return this.vcsGetBranches(workingDirectory);
  }
}
