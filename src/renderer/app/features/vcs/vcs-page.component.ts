/**
 * VCS Page - Git Operations
 * Repository status, branches, commits, diffs, and file history.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { VcsIpcService } from '../../core/services/ipc/vcs-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import { DiffViewerComponent } from '../../shared/components/diff-viewer/diff-viewer.component';

// -----------------------------------------------------------------------
// Local interfaces
// -----------------------------------------------------------------------

interface GitStatus {
  modified: string[];
  added: string[];
  deleted: string[];
  untracked: string[];
  staged: string[];
  branch: string;
  ahead: number;
  behind: number;
}

interface GitBranch {
  name: string;
  current: boolean;
  remote?: string;
}

interface GitCommit {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
}

interface FileHistoryEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
}

type LeftTab = 'changes' | 'branches';

// -----------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------

@Component({
  selector: 'app-vcs-page',
  standalone: true,
  imports: [CommonModule, DiffViewerComponent],
  template: `
    <div class="page">

      <!-- Page Header -->
      <div class="page-header">
        <button class="header-btn" type="button" (click)="goBack()">← Back</button>
        <div class="header-title">
          <span class="title">Git Operations</span>
          <span class="subtitle">Repository status, branches, commits, and diffs</span>
        </div>
        <div class="header-actions">
          <button class="btn" type="button" [disabled]="loading()" (click)="refresh()">
            {{ loading() ? 'Loading…' : 'Refresh' }}
          </button>
        </div>
      </div>

      <!-- Error / Info banners -->
      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      <!-- Directory Input Bar -->
      <div class="dir-bar">
        <input
          class="dir-input"
          type="text"
          placeholder="Working directory path…"
          [value]="workingDir()"
          (input)="onDirInput($event)"
          (keydown.enter)="loadRepo()"
        />
        <button class="btn primary" type="button" [disabled]="loading() || !workingDir().trim()" (click)="loadRepo()">
          Load
        </button>
      </div>

      <!-- Branch Bar (shown once repo is loaded) -->
      @if (isRepo()) {
        <div class="branch-bar">
          <span class="current-branch-badge">
            <span class="branch-icon">&#9135;</span>
            {{ status()?.branch || 'unknown' }}
            @if ((status()?.ahead ?? 0) > 0) {
              <span class="sync-badge ahead">↑{{ status()!.ahead }}</span>
            }
            @if ((status()?.behind ?? 0) > 0) {
              <span class="sync-badge behind">↓{{ status()!.behind }}</span>
            }
          </span>
          <div class="branch-chips">
            @for (branch of branches(); track branch.name) {
              <span class="branch-chip" [class.current]="branch.current">
                {{ branch.name }}
                @if (branch.remote) {
                  <span class="remote-hint">{{ branch.remote }}</span>
                }
              </span>
            }
          </div>
        </div>

        <div class="job-launch-bar">
          <input
            class="dir-input"
            type="text"
            [value]="jobUrl()"
            (input)="onJobUrlInput($event)"
            placeholder="Optional issue or PR URL to include with the background job"
          />
          <button class="btn primary" type="button" (click)="openRepoJob('pr-review')">
            Run PR Review
          </button>
          <button class="btn" type="button" (click)="openRepoJob('repo-health-audit')">
            Run Health Audit
          </button>
        </div>
      }

      <!-- 3-column layout (shown once repo is loaded) -->
      @if (isRepo()) {
        <div class="workspace">

          <!-- Left: Status & Changes / Branches -->
          <div class="panel left-panel">
            <div class="tab-bar">
              <button
                class="tab-btn"
                [class.active]="leftTab() === 'changes'"
                type="button"
                (click)="leftTab.set('changes')"
              >
                Changes
                @if (totalChanges() > 0) {
                  <span class="count-badge">{{ totalChanges() }}</span>
                }
              </button>
              <button
                class="tab-btn"
                [class.active]="leftTab() === 'branches'"
                type="button"
                (click)="leftTab.set('branches')"
              >
                Branches
              </button>
            </div>

            <div class="panel-body">
              @if (leftTab() === 'changes') {
                <!-- Staged files -->
                @if ((status()?.staged?.length ?? 0) > 0) {
                  <div class="file-section-label">Staged</div>
                  @for (file of status()!.staged; track file) {
                    <button
                      class="file-row"
                      [class.selected]="selectedFile() === file && selectedDiffType() === 'staged'"
                      type="button"
                      (click)="selectFile(file, 'staged')"
                    >
                      <span class="file-icon staged">S</span>
                      <span class="file-name">{{ file }}</span>
                    </button>
                  }
                }

                <!-- Modified files -->
                @if ((status()?.modified?.length ?? 0) > 0) {
                  <div class="file-section-label">Modified</div>
                  @for (file of status()!.modified; track file) {
                    <button
                      class="file-row"
                      [class.selected]="selectedFile() === file && selectedDiffType() === 'unstaged'"
                      type="button"
                      (click)="selectFile(file, 'unstaged')"
                    >
                      <span class="file-icon modified">M</span>
                      <span class="file-name">{{ file }}</span>
                    </button>
                  }
                }

                <!-- Added files -->
                @if ((status()?.added?.length ?? 0) > 0) {
                  <div class="file-section-label">Added</div>
                  @for (file of status()!.added; track file) {
                    <button
                      class="file-row"
                      [class.selected]="selectedFile() === file && selectedDiffType() === 'unstaged'"
                      type="button"
                      (click)="selectFile(file, 'unstaged')"
                    >
                      <span class="file-icon added">A</span>
                      <span class="file-name">{{ file }}</span>
                    </button>
                  }
                }

                <!-- Deleted files -->
                @if ((status()?.deleted?.length ?? 0) > 0) {
                  <div class="file-section-label">Deleted</div>
                  @for (file of status()!.deleted; track file) {
                    <button
                      class="file-row"
                      [class.selected]="selectedFile() === file && selectedDiffType() === 'unstaged'"
                      type="button"
                      (click)="selectFile(file, 'unstaged')"
                    >
                      <span class="file-icon deleted">D</span>
                      <span class="file-name">{{ file }}</span>
                    </button>
                  }
                }

                <!-- Untracked files -->
                @if ((status()?.untracked?.length ?? 0) > 0) {
                  <div class="file-section-label">Untracked</div>
                  @for (file of status()!.untracked; track file) {
                    <button
                      class="file-row"
                      [class.selected]="selectedFile() === file && selectedDiffType() === 'unstaged'"
                      type="button"
                      (click)="selectFile(file, 'unstaged')"
                    >
                      <span class="file-icon untracked">?</span>
                      <span class="file-name">{{ file }}</span>
                    </button>
                  }
                }

                @if (totalChanges() === 0) {
                  <div class="empty-hint">Working tree clean.</div>
                }
              }

              @if (leftTab() === 'branches') {
                @for (branch of branches(); track branch.name) {
                  <div class="branch-row" [class.current]="branch.current">
                    <span class="branch-row-icon">{{ branch.current ? '●' : '○' }}</span>
                    <span class="branch-row-name">{{ branch.name }}</span>
                    @if (branch.remote) {
                      <span class="branch-row-remote">{{ branch.remote }}</span>
                    }
                  </div>
                }
                @if (branches().length === 0) {
                  <div class="empty-hint">No branches found.</div>
                }
              }
            </div>
          </div>

          <!-- Center: Diff Viewer -->
          <div class="panel center-panel">
            @if (selectedFile()) {
              <div class="diff-file-header">
                <span class="diff-file-path">{{ selectedFile() }}</span>
                <span class="diff-type-badge">{{ selectedDiffType() }}</span>
                @if (diffLoading()) {
                  <span class="diff-loading">Loading diff…</span>
                }
              </div>
              <div class="diff-scroll">
                <app-diff-viewer
                  [oldContent]="diffOld()"
                  [newContent]="diffNew()"
                  [fileName]="diffFileName()"
                />
              </div>
            } @else {
              <div class="diff-empty">
                <span class="diff-empty-icon">&#9997;</span>
                <span>Select a file to view its diff.</span>
              </div>
            }
          </div>

          <!-- Right: Commit Log -->
          <div class="panel right-panel">
            <div class="panel-header-label">Commit Log</div>
            <div class="commit-list">
              @for (commit of commits(); track commit.hash) {
                <button
                  class="commit-row"
                  [class.selected]="selectedCommit()?.hash === commit.hash"
                  type="button"
                  (click)="selectCommit(commit)"
                >
                  <div class="commit-hash">{{ commit.shortHash }}</div>
                  <div class="commit-message">{{ commit.message }}</div>
                  <div class="commit-meta">{{ commit.author }} · {{ commit.date }}</div>
                </button>
              }
              @if (commits().length === 0) {
                <div class="empty-hint">No commits found.</div>
              }
            </div>

            @if (selectedCommit()) {
              <div class="commit-detail">
                <div class="commit-detail-title">Commit Details</div>
                <div class="commit-detail-hash">{{ selectedCommit()!.hash }}</div>
                <div class="commit-detail-msg">{{ selectedCommit()!.message }}</div>
                <div class="commit-detail-meta">
                  {{ selectedCommit()!.author }} · {{ selectedCommit()!.date }}
                </div>
              </div>
            }
          </div>

        </div>
      }

      <!-- Bottom Drawer: File History -->
      @if (isRepo()) {
        <div class="bottom-drawer" [class.expanded]="historyDrawerOpen()">
          <button
            class="drawer-toggle"
            type="button"
            (click)="historyDrawerOpen.set(!historyDrawerOpen())"
          >
            <span class="drawer-toggle-label">File History</span>
            <span class="drawer-toggle-icon">{{ historyDrawerOpen() ? '▼' : '▲' }}</span>
          </button>

          @if (historyDrawerOpen()) {
            <div class="drawer-body">
              <div class="history-input-row">
                <input
                  class="dir-input"
                  type="text"
                  placeholder="File path relative to repo root…"
                  [value]="historyFilePath()"
                  (input)="onHistoryFileInput($event)"
                  (keydown.enter)="loadFileHistory()"
                />
                <button
                  class="btn"
                  type="button"
                  [disabled]="historyLoading() || !historyFilePath().trim()"
                  (click)="loadFileHistory()"
                >
                  Load
                </button>
              </div>

              <div class="history-list">
                @for (entry of fileHistory(); track entry.hash) {
                  <div class="history-row">
                    <span class="history-hash">{{ entry.hash.slice(0, 7) }}</span>
                    <span class="history-message">{{ entry.message }}</span>
                    <span class="history-meta">{{ entry.author }} · {{ entry.date }}</span>
                  </div>
                }
                @if (fileHistory().length === 0 && !historyLoading()) {
                  <div class="empty-hint">Load a file path to see its commit history.</div>
                }
                @if (historyLoading()) {
                  <div class="empty-hint">Loading…</div>
                }
              </div>
            </div>
          }
        </div>
      }

    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        width: 100%;
        height: 100%;
        overflow: hidden;
      }

      /* ----------------------------------------------------------------
       * Page shell
       * ---------------------------------------------------------------- */

      .page {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        padding: var(--spacing-lg);
        background: var(--bg-primary);
        color: var(--text-primary);
        overflow: hidden;
      }

      /* ----------------------------------------------------------------
       * Page header
       * ---------------------------------------------------------------- */

      .page-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        flex-shrink: 0;
      }

      .header-title {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
      }

      .title {
        font-size: 18px;
        font-weight: 700;
      }

      .subtitle {
        font-size: 12px;
        color: var(--text-muted);
      }

      .header-actions {
        display: flex;
        gap: var(--spacing-sm);
      }

      /* ----------------------------------------------------------------
       * Shared buttons
       * ---------------------------------------------------------------- */

      .header-btn,
      .btn {
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
        cursor: pointer;
      }

      .btn.primary {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: #fff;
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      /* ----------------------------------------------------------------
       * Banners
       * ---------------------------------------------------------------- */

      .error-banner {
        flex-shrink: 0;
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-sm);
        border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
        background: color-mix(in srgb, var(--error-color) 14%, transparent);
        color: var(--error-color);
        font-size: 12px;
      }

      /* ----------------------------------------------------------------
       * Directory bar
       * ---------------------------------------------------------------- */

      .dir-bar {
        display: flex;
        gap: var(--spacing-sm);
        flex-shrink: 0;
      }

      .dir-input {
        flex: 1;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-secondary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
        font-family: var(--font-family-mono);
      }

      .dir-input::placeholder {
        color: var(--text-muted);
      }

      /* ----------------------------------------------------------------
       * Branch bar
       * ---------------------------------------------------------------- */

      .branch-bar {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        flex-shrink: 0;
        flex-wrap: wrap;
        padding: var(--spacing-xs) var(--spacing-sm);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        background: var(--bg-secondary);
      }

      .job-launch-bar {
        display: flex;
        gap: var(--spacing-sm);
        flex-shrink: 0;
      }

      .current-branch-badge {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 12px;
        font-weight: 600;
        color: var(--primary-color);
        white-space: nowrap;
      }

      .branch-icon {
        font-size: 14px;
      }

      .sync-badge {
        font-size: 10px;
        padding: 1px 5px;
        border-radius: 999px;
      }

      .sync-badge.ahead {
        background: color-mix(in srgb, var(--success-color) 20%, transparent);
        color: var(--success-color);
      }

      .sync-badge.behind {
        background: color-mix(in srgb, var(--warning-color, #f59e0b) 20%, transparent);
        color: var(--warning-color, #f59e0b);
      }

      .branch-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }

      .branch-chip {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font-size: 11px;
        padding: 2px 8px;
        border-radius: 999px;
        border: 1px solid var(--border-color);
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }

      .branch-chip.current {
        border-color: var(--primary-color);
        color: var(--primary-color);
      }

      .remote-hint {
        color: var(--text-muted);
        font-size: 10px;
      }

      /* ----------------------------------------------------------------
       * 3-column workspace
       * ---------------------------------------------------------------- */

      .workspace {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: 260px 1fr 300px;
        gap: var(--spacing-md);
      }

      .panel {
        display: flex;
        flex-direction: column;
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        overflow: hidden;
        min-height: 0;
      }

      /* ----------------------------------------------------------------
       * Left panel - tabs
       * ---------------------------------------------------------------- */

      .tab-bar {
        display: flex;
        border-bottom: 1px solid var(--border-color);
        flex-shrink: 0;
      }

      .tab-btn {
        flex: 1;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 4px;
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
        font-weight: 500;
        border: none;
        background: transparent;
        color: var(--text-muted);
        cursor: pointer;
        border-bottom: 2px solid transparent;
        margin-bottom: -1px;
      }

      .tab-btn.active {
        color: var(--primary-color);
        border-bottom-color: var(--primary-color);
      }

      .count-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 16px;
        height: 16px;
        padding: 0 4px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 700;
        background: var(--primary-color);
        color: #fff;
      }

      .panel-body {
        flex: 1;
        overflow-y: auto;
        padding: var(--spacing-xs) 0;
      }

      .panel-header-label {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted);
        padding: var(--spacing-sm) var(--spacing-md);
        border-bottom: 1px solid var(--border-color);
        flex-shrink: 0;
      }

      /* ----------------------------------------------------------------
       * File rows in left panel
       * ---------------------------------------------------------------- */

      .file-section-label {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-muted);
        padding: var(--spacing-xs) var(--spacing-md);
        padding-top: var(--spacing-sm);
      }

      .file-row {
        width: 100%;
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: 3px var(--spacing-md);
        border: none;
        background: transparent;
        color: var(--text-primary);
        cursor: pointer;
        text-align: left;
        font-size: 12px;
      }

      .file-row:hover {
        background: var(--bg-hover, rgba(255,255,255,0.05));
      }

      .file-row.selected {
        background: color-mix(in srgb, var(--primary-color) 15%, transparent);
      }

      .file-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 16px;
        height: 16px;
        border-radius: 3px;
        font-size: 10px;
        font-weight: 700;
        flex-shrink: 0;
      }

      .file-icon.modified  { background: color-mix(in srgb, #f59e0b 25%, transparent); color: #f59e0b; }
      .file-icon.added     { background: color-mix(in srgb, var(--success-color) 25%, transparent); color: var(--success-color); }
      .file-icon.deleted   { background: color-mix(in srgb, var(--error-color) 25%, transparent); color: var(--error-color); }
      .file-icon.staged    { background: color-mix(in srgb, var(--primary-color) 25%, transparent); color: var(--primary-color); }
      .file-icon.untracked { background: color-mix(in srgb, var(--text-muted) 25%, transparent); color: var(--text-muted); }

      .file-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--font-family-mono);
        font-size: 11px;
      }

      /* ----------------------------------------------------------------
       * Branch rows in left panel
       * ---------------------------------------------------------------- */

      .branch-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        padding: 4px var(--spacing-md);
        font-size: 12px;
        color: var(--text-secondary);
      }

      .branch-row.current {
        color: var(--primary-color);
        font-weight: 600;
      }

      .branch-row-icon {
        font-size: 10px;
        flex-shrink: 0;
      }

      .branch-row-name {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--font-family-mono);
        font-size: 11px;
      }

      .branch-row-remote {
        font-size: 10px;
        color: var(--text-muted);
      }

      /* ----------------------------------------------------------------
       * Center panel - diff viewer
       * ---------------------------------------------------------------- */

      .center-panel {
        overflow: hidden;
      }

      .diff-file-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-xs) var(--spacing-md);
        background: var(--bg-tertiary);
        border-bottom: 1px solid var(--border-color);
        flex-shrink: 0;
      }

      .diff-file-path {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: var(--font-family-mono);
        font-size: 11px;
        color: var(--text-primary);
      }

      .diff-type-badge {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 1px 6px;
        border-radius: 999px;
        border: 1px solid var(--border-color);
        color: var(--text-muted);
        white-space: nowrap;
      }

      .diff-loading {
        font-size: 11px;
        color: var(--text-muted);
        white-space: nowrap;
      }

      .diff-scroll {
        flex: 1;
        overflow: auto;
        min-height: 0;
      }

      .diff-empty {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--spacing-sm);
        color: var(--text-muted);
        font-size: 13px;
      }

      .diff-empty-icon {
        font-size: 28px;
        opacity: 0.4;
      }

      /* ----------------------------------------------------------------
       * Right panel - commit log
       * ---------------------------------------------------------------- */

      .right-panel {
        overflow: hidden;
      }

      .commit-list {
        flex: 1;
        overflow-y: auto;
        min-height: 0;
        padding: var(--spacing-xs) 0;
      }

      .commit-row {
        width: 100%;
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: var(--spacing-xs) var(--spacing-md);
        border: none;
        background: transparent;
        color: var(--text-primary);
        cursor: pointer;
        text-align: left;
        border-bottom: 1px solid color-mix(in srgb, var(--border-color) 50%, transparent);
      }

      .commit-row:hover {
        background: var(--bg-hover, rgba(255,255,255,0.05));
      }

      .commit-row.selected {
        background: color-mix(in srgb, var(--primary-color) 12%, transparent);
      }

      .commit-hash {
        font-family: var(--font-family-mono);
        font-size: 10px;
        font-weight: 700;
        color: var(--primary-color);
        letter-spacing: 0.03em;
      }

      .commit-message {
        font-size: 12px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-primary);
      }

      .commit-meta {
        font-size: 10px;
        color: var(--text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .commit-detail {
        flex-shrink: 0;
        border-top: 1px solid var(--border-color);
        padding: var(--spacing-sm) var(--spacing-md);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .commit-detail-title {
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted);
      }

      .commit-detail-hash {
        font-family: var(--font-family-mono);
        font-size: 10px;
        color: var(--primary-color);
        word-break: break-all;
      }

      .commit-detail-msg {
        font-size: 12px;
        color: var(--text-primary);
      }

      .commit-detail-meta {
        font-size: 11px;
        color: var(--text-muted);
      }

      /* ----------------------------------------------------------------
       * Bottom drawer - file history
       * ---------------------------------------------------------------- */

      .bottom-drawer {
        flex-shrink: 0;
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        display: flex;
        flex-direction: column;
        max-height: 240px;
        overflow: hidden;
      }

      .bottom-drawer.expanded {
        max-height: 240px;
      }

      .drawer-toggle {
        display: flex;
        align-items: center;
        justify-content: space-between;
        width: 100%;
        padding: var(--spacing-xs) var(--spacing-md);
        border: none;
        background: var(--bg-tertiary);
        color: var(--text-primary);
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
        flex-shrink: 0;
      }

      .drawer-toggle:hover {
        background: var(--bg-hover, rgba(255,255,255,0.05));
      }

      .drawer-toggle-label {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--text-muted);
      }

      .drawer-toggle-icon {
        font-size: 10px;
        color: var(--text-muted);
      }

      .drawer-body {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        padding: var(--spacing-sm) var(--spacing-md);
        overflow: hidden;
      }

      .history-input-row {
        display: flex;
        gap: var(--spacing-sm);
        flex-shrink: 0;
      }

      .history-list {
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .history-row {
        display: flex;
        align-items: baseline;
        gap: var(--spacing-sm);
        font-size: 11px;
        padding: 2px 0;
      }

      .history-hash {
        font-family: var(--font-family-mono);
        font-size: 10px;
        font-weight: 700;
        color: var(--primary-color);
        white-space: nowrap;
        flex-shrink: 0;
      }

      .history-message {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-primary);
      }

      .history-meta {
        font-size: 10px;
        color: var(--text-muted);
        white-space: nowrap;
        flex-shrink: 0;
      }

      /* ----------------------------------------------------------------
       * Misc
       * ---------------------------------------------------------------- */

      .empty-hint {
        padding: var(--spacing-sm) var(--spacing-md);
        font-size: 12px;
        color: var(--text-muted);
      }

      @media (max-width: 1100px) {
        .workspace {
          grid-template-columns: 240px 1fr;
          grid-template-rows: 1fr auto;
        }

        .right-panel {
          grid-column: 1 / -1;
          max-height: 200px;
        }
      }

      @media (max-width: 720px) {
        .workspace {
          grid-template-columns: 1fr;
          grid-template-rows: repeat(3, auto);
        }

        .left-panel,
        .right-panel {
          max-height: 200px;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class VcsPageComponent {
  private readonly router = inject(Router);
  private readonly vcsIpc = inject(VcsIpcService);

  // -----------------------------------------------------------------------
  // State signals
  // -----------------------------------------------------------------------

  readonly workingDir = signal('');
  readonly isRepo = signal(false);
  readonly loading = signal(false);
  readonly errorMessage = signal<string | null>(null);

  readonly status = signal<GitStatus | null>(null);
  readonly branches = signal<GitBranch[]>([]);
  readonly commits = signal<GitCommit[]>([]);

  readonly leftTab = signal<LeftTab>('changes');

  readonly selectedFile = signal<string | null>(null);
  readonly selectedDiffType = signal<'staged' | 'unstaged'>('unstaged');
  readonly diffOld = signal('');
  readonly diffNew = signal('');
  readonly diffLoading = signal(false);

  readonly selectedCommit = signal<GitCommit | null>(null);

  readonly historyDrawerOpen = signal(false);
  readonly historyFilePath = signal('');
  readonly fileHistory = signal<FileHistoryEntry[]>([]);
  readonly historyLoading = signal(false);
  readonly jobUrl = signal('');

  // -----------------------------------------------------------------------
  // Computed
  // -----------------------------------------------------------------------

  readonly diffFileName = computed(() => this.selectedFile() ?? '');

  readonly totalChanges = computed(() => {
    const s = this.status();
    if (!s) return 0;
    return (
      s.modified.length +
      s.added.length +
      s.deleted.length +
      s.untracked.length +
      s.staged.length
    );
  });

  // -----------------------------------------------------------------------
  // Navigation
  // -----------------------------------------------------------------------

  goBack(): void {
    this.router.navigate(['/']);
  }

  // -----------------------------------------------------------------------
  // Directory / Repo loading
  // -----------------------------------------------------------------------

  onDirInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.workingDir.set(target.value);
  }

  onJobUrlInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.jobUrl.set(target.value);
  }

  openRepoJob(type: 'pr-review' | 'repo-health-audit'): void {
    if (!this.isRepo() || !this.workingDir().trim()) {
      return;
    }

    const queryParams: Record<string, string> = {
      workingDirectory: this.workingDir().trim(),
      branchRef: this.status()?.branch || '',
    };

    const baseBranch = this.getSuggestedBaseBranch();
    if (baseBranch) {
      queryParams['baseBranch'] = baseBranch;
    }

    const issueOrPrUrl = this.jobUrl().trim();
    if (issueOrPrUrl) {
      queryParams['issueOrPrUrl'] = issueOrPrUrl;
    }

    this.router.navigate(['/tasks'], {
      queryParams,
      state: {
        launchType: type,
      },
    });
  }

  async loadRepo(): Promise<void> {
    const dir = this.workingDir().trim();
    if (!dir) return;

    this.loading.set(true);
    this.errorMessage.set(null);
    this.isRepo.set(false);
    this.status.set(null);
    this.branches.set([]);
    this.commits.set([]);
    this.selectedFile.set(null);
    this.selectedCommit.set(null);
    this.fileHistory.set([]);

    try {
      const isRepoResponse = await this.vcsIpc.vcsIsRepo(dir);
      if (!isRepoResponse.success) {
        this.errorMessage.set(isRepoResponse.error?.message ?? 'Failed to check repository.');
        return;
      }

      const repoData = isRepoResponse.data as Record<string, unknown> | boolean | undefined;
      const isValidRepo =
        repoData === true ||
        (typeof repoData === 'object' && repoData !== null && repoData['isRepo'] === true);

      if (!isValidRepo) {
        this.errorMessage.set('Not a git repository.');
        return;
      }

      this.isRepo.set(true);
      await this.loadAll(dir);
    } catch (err) {
      this.errorMessage.set((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  async refresh(): Promise<void> {
    if (!this.isRepo()) return;
    this.loading.set(true);
    this.errorMessage.set(null);
    try {
      await this.loadAll(this.workingDir());
    } catch (err) {
      this.errorMessage.set((err as Error).message);
    } finally {
      this.loading.set(false);
    }
  }

  // -----------------------------------------------------------------------
  // File selection & diff loading
  // -----------------------------------------------------------------------

  selectFile(filePath: string, diffType: 'staged' | 'unstaged'): void {
    this.selectedFile.set(filePath);
    this.selectedDiffType.set(diffType);
    this.selectedCommit.set(null);
    void this.loadFileDiff(filePath, diffType);
  }

  async loadFileDiff(filePath: string, diffType: 'staged' | 'unstaged'): Promise<void> {
    this.diffLoading.set(true);
    this.diffOld.set('');
    this.diffNew.set('');

    try {
      const response = await this.vcsIpc.vcsGetDiff({
        workingDirectory: this.workingDir(),
        type: diffType,
        filePath,
      });

      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to load diff.');
        return;
      }

      this.applyDiffResponse(response);
    } catch (err) {
      this.errorMessage.set((err as Error).message);
    } finally {
      this.diffLoading.set(false);
    }
  }

  // -----------------------------------------------------------------------
  // Commit selection
  // -----------------------------------------------------------------------

  selectCommit(commit: GitCommit): void {
    this.selectedCommit.set(commit);
    this.selectedFile.set(null);
    void this.loadCommitDiff(commit);
  }

  async loadCommitDiff(commit: GitCommit): Promise<void> {
    this.diffLoading.set(true);
    this.diffOld.set('');
    this.diffNew.set('');

    try {
      const commitList = this.commits();
      const currentIndex = commitList.findIndex((c) => c.hash === commit.hash);
      const prevCommit = currentIndex < commitList.length - 1 ? commitList[currentIndex + 1] : null;

      const response = await this.vcsIpc.vcsGetDiff({
        workingDirectory: this.workingDir(),
        type: 'between',
        fromRef: prevCommit?.hash ?? `${commit.hash}^`,
        toRef: commit.hash,
      });

      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to load commit diff.');
        return;
      }

      this.applyDiffResponse(response);
    } catch (err) {
      this.errorMessage.set((err as Error).message);
    } finally {
      this.diffLoading.set(false);
    }
  }

  // -----------------------------------------------------------------------
  // File history (bottom drawer)
  // -----------------------------------------------------------------------

  onHistoryFileInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.historyFilePath.set(target.value);
  }

  async loadFileHistory(): Promise<void> {
    const filePath = this.historyFilePath().trim();
    if (!filePath || !this.isRepo()) return;

    this.historyLoading.set(true);
    this.fileHistory.set([]);

    try {
      const response = await this.vcsIpc.vcsGetFileHistory(this.workingDir(), filePath, 20);
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to load file history.');
        return;
      }

      const entries = this.extractArray<FileHistoryEntry>(response);
      this.fileHistory.set(entries);
    } catch (err) {
      this.errorMessage.set((err as Error).message);
    } finally {
      this.historyLoading.set(false);
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private async loadAll(dir: string): Promise<void> {
    const [statusResponse, branchesResponse, commitsResponse] = await Promise.all([
      this.vcsIpc.vcsGetStatus(dir),
      this.vcsIpc.vcsGetBranches(dir),
      this.vcsIpc.vcsGetCommits(dir, 50),
    ]);

    if (statusResponse.success) {
      const raw = statusResponse.data as Partial<GitStatus> | undefined;
      this.status.set({
        modified: raw?.modified ?? [],
        added: raw?.added ?? [],
        deleted: raw?.deleted ?? [],
        untracked: raw?.untracked ?? [],
        staged: raw?.staged ?? [],
        branch: raw?.branch ?? '',
        ahead: raw?.ahead ?? 0,
        behind: raw?.behind ?? 0,
      });
    } else {
      this.errorMessage.set(statusResponse.error?.message ?? 'Failed to load status.');
    }

    if (branchesResponse.success) {
      this.branches.set(this.extractArray<GitBranch>(branchesResponse));
    } else {
      this.errorMessage.set(branchesResponse.error?.message ?? 'Failed to load branches.');
    }

    if (commitsResponse.success) {
      this.commits.set(this.extractArray<GitCommit>(commitsResponse));
    } else {
      this.errorMessage.set(commitsResponse.error?.message ?? 'Failed to load commits.');
    }
  }

  private applyDiffResponse(response: IpcResponse): void {
    const data = response.data as Record<string, unknown> | string | undefined;

    if (typeof data === 'string') {
      // Raw unified diff string — put it in newContent and leave oldContent empty
      this.diffOld.set('');
      this.diffNew.set(data);
      return;
    }

    if (data && typeof data === 'object') {
      this.diffOld.set(String(data['oldContent'] ?? data['before'] ?? ''));
      this.diffNew.set(String(data['newContent'] ?? data['after'] ?? data['diff'] ?? ''));
    }
  }

  private extractArray<T>(response: IpcResponse): T[] {
    if (!response.success) return [];
    const data = response.data;
    if (Array.isArray(data)) return data as T[];
    return [];
  }

  private getSuggestedBaseBranch(): string | null {
    const currentBranch = this.status()?.branch || '';
    const branchNames = this.branches().map((branch) => branch.name);
    const candidates = ['main', 'master', 'develop'];

    for (const candidate of candidates) {
      if (currentBranch === candidate) {
        continue;
      }

      const matched = branchNames.find((branchName) =>
        branchName === candidate || branchName.endsWith(`/${candidate}`),
      );
      if (matched) {
        return matched;
      }
    }

    return currentBranch || null;
  }
}
