/**
 * Source Control Component — VS Code–style SCM slideout on the right rail.
 *
 * Pure view consuming `SourceControlStore`. The store owns all state and
 * loading lifecycle (including stale-response protection across instance
 * switches); the component is responsible only for rendering and panel
 * UI (resize, close, refresh button, diff-modal mount).
 *
 * Visibility is controlled by the dashboard via `showSourceControl()`. The
 * component does NOT have its own collapsed-to-strip state.
 *
 * See `docs/plans/2026-05-12-source-control-phase-2-plan.md` Phase 2a.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  HostListener,
  inject,
  output,
  signal,
} from '@angular/core';
import { ViewLayoutService } from '../../core/services/view-layout.service';
import { SourceControlStore } from '../../core/state/source-control.store';
import { SourceControlDiffViewerComponent } from './source-control-diff-viewer.component';
import { SourceControlInlineDiffComponent } from './source-control-inline-diff.component';
import { SourceControlRepoActionsComponent } from './source-control-repo-actions.component';
import type {
  FileChangeStatus,
  GitStatusResponse,
  RepoState,
} from './source-control.types';

@Component({
  selector: 'app-source-control',
  standalone: true,
  imports: [
    SourceControlDiffViewerComponent,
    SourceControlInlineDiffComponent,
    SourceControlRepoActionsComponent,
  ],
  template: `
    <div
      class="source-control-wrapper"
      [class.resizing]="isResizing()"
    >
      <div
        class="resize-handle"
        (mousedown)="onResizeStart($event)"
        [class.dragging]="isResizing()"
      ></div>

      <div class="source-control" [style.width.px]="panelWidth()">
        <div class="panel-header">
          <span class="collapse-icon" aria-hidden="true">⎇</span>
          <span class="header-title">Source Control</span>
          <button
            type="button"
            class="header-action"
            (click)="refresh()"
            [disabled]="store.isRefreshing()"
            title="Refresh"
            aria-label="Refresh source control"
          >
            <span [class.spinning]="store.isRefreshing()">↻</span>
          </button>
          <button
            type="button"
            class="header-close"
            (click)="closeRequested.emit()"
            title="Close source control"
            aria-label="Close source control"
          >×</button>
        </div>

        <div class="panel-body">
            @if (!store.activeRoot()) {
              <div class="empty-state">
                <p>No folder selected</p>
                <p class="hint">Select an instance with a working directory</p>
              </div>
            } @else if (store.initialLoad() && store.isRefreshing()) {
              <div class="loading">Scanning for repositories…</div>
            } @else if (store.loadError()) {
              <div class="error">{{ store.loadError() }}</div>
            } @else if (store.repos().length === 0) {
              <div class="empty-state">
                <p>No git repositories found</p>
                <p class="hint">Nothing under <code>{{ rootName() }}</code> contains a <code>.git</code> folder.</p>
              </div>
            } @else {
              @for (repo of store.repos(); track repo.absolutePath) {
                <section class="repo" [class.expanded]="store.isRepoExpanded(repo.absolutePath)">
                  <header
                    class="repo-header"
                    (click)="store.toggleRepo(repo.absolutePath)"
                    (keydown.enter)="store.toggleRepo(repo.absolutePath)"
                    (keydown.space)="store.toggleRepo(repo.absolutePath)"
                    tabindex="0"
                    role="button"
                  >
                    <span class="repo-chevron">{{ store.isRepoExpanded(repo.absolutePath) ? '▾' : '▸' }}</span>
                    <span class="repo-icon" aria-hidden="true">📦</span>
                    <span class="repo-name" [title]="repo.absolutePath">{{ repo.name }}</span>
                    @if (repo.status) {
                      <span class="repo-branch" [title]="branchTooltip(repo.status)">
                        {{ repo.status.branch }}{{ repo.status.hasChanges ? '*' : '' }}
                      </span>
                      @if (repo.status.ahead > 0) {
                        <span class="repo-track repo-ahead" [title]="repo.status.ahead + ' commit(s) ahead of upstream'">↑{{ repo.status.ahead }}</span>
                      }
                      @if (repo.status.behind > 0) {
                        <span class="repo-track repo-behind" [title]="repo.status.behind + ' commit(s) behind upstream'">↓{{ repo.status.behind }}</span>
                      }
                    }
                    @if (changeCount(repo) > 0) {
                      <span class="repo-badge">{{ changeCount(repo) }}</span>
                    }
                    @if (repo.loading) {
                      <span class="repo-loading-spinner" aria-label="Loading"></span>
                    }
                  </header>

                  @if (store.isRepoExpanded(repo.absolutePath)) {
                    <div class="repo-body">
                      @if (repo.error) {
                        <div class="repo-error">{{ repo.error }}</div>
                      } @else if (repo.status?.isClean) {
                        <!-- Clean repo: still expose fetch/pull/push and
                             branch picker so the user can sync / switch
                             without staged changes. -->
                        <app-source-control-repo-actions [repo]="repo" />
                        <div class="repo-clean">✓ No changes</div>
                      } @else if (repo.status) {
                        <!-- Phase 2d items 9–11 — toolbar (commit, sync, branch) -->
                        <app-source-control-repo-actions [repo]="repo" />
                        @if (repo.status.staged.length > 0) {
                          <div class="change-group">
                            <div class="change-group-title">Staged ({{ repo.status.staged.length }})</div>
                            @for (file of repo.status.staged; track file.path) {
                              <div class="file-row-container">
                                <div class="file-row-line">
                                  <button
                                    type="button"
                                    class="file-expand-chevron"
                                    [attr.aria-expanded]="store.isFileExpanded(repo.absolutePath, file.path, true)"
                                    [attr.aria-label]="store.isFileExpanded(repo.absolutePath, file.path, true) ? 'Collapse diff' : 'Expand diff inline'"
                                    (click)="store.toggleFileExpansion(repo.absolutePath, file.path, true)"
                                  >{{ store.isFileExpanded(repo.absolutePath, file.path, true) ? '▾' : '▸' }}</button>
                                  <button
                                    type="button"
                                    class="file-row file-row-clickable"
                                    (click)="store.openDiff(repo, file, true)"
                                    [title]="file.path + ' — click to open full diff modal'"
                                  >
                                    <span
                                      class="status-badge"
                                      [class]="'status-' + file.status"
                                      [title]="statusLabel(file.status)"
                                    >{{ statusChar(file.status) }}</span>
                                    <span class="file-name">{{ fileBasename(file.path) }}</span>
                                    <span class="file-dir">{{ fileDirname(file.path) }}</span>
                                  </button>
                                  <button
                                    type="button"
                                    class="file-action file-action-discard"
                                    (click)="onDiscardFile(repo, file.path)"
                                    [disabled]="isWriting(repo.absolutePath)"
                                    title="Discard changes (revert to HEAD)"
                                    [attr.aria-label]="'Discard ' + file.path"
                                  >⌫</button>
                                  <button
                                    type="button"
                                    class="file-action file-action-unstage"
                                    (click)="onUnstageFile(repo.absolutePath, file.path)"
                                    [disabled]="isWriting(repo.absolutePath)"
                                    title="Unstage file (git restore --staged)"
                                    [attr.aria-label]="'Unstage ' + file.path"
                                  >−</button>
                                </div>
                                @if (store.isFileExpanded(repo.absolutePath, file.path, true)) {
                                  <app-source-control-inline-diff
                                    [workingDirectory]="repo.absolutePath"
                                    [filePath]="file.path"
                                    [staged]="true"
                                  />
                                }
                              </div>
                            }
                            <div class="change-group-actions">
                              <button
                                type="button"
                                class="group-action"
                                (click)="onUnstageAll(repo)"
                                [disabled]="isWriting(repo.absolutePath)"
                                title="Unstage all"
                              >Unstage all</button>
                            </div>
                          </div>
                        }

                        @if (repo.status.unstaged.length > 0) {
                          <div class="change-group">
                            <div class="change-group-title">Changes ({{ repo.status.unstaged.length }})</div>
                            @for (file of repo.status.unstaged; track file.path) {
                              <div class="file-row-container">
                                <div class="file-row-line">
                                  <button
                                    type="button"
                                    class="file-expand-chevron"
                                    [attr.aria-expanded]="store.isFileExpanded(repo.absolutePath, file.path, false)"
                                    [attr.aria-label]="store.isFileExpanded(repo.absolutePath, file.path, false) ? 'Collapse diff' : 'Expand diff inline'"
                                    (click)="store.toggleFileExpansion(repo.absolutePath, file.path, false)"
                                  >{{ store.isFileExpanded(repo.absolutePath, file.path, false) ? '▾' : '▸' }}</button>
                                  <button
                                    type="button"
                                    class="file-row file-row-clickable"
                                    (click)="store.openDiff(repo, file, false)"
                                    [title]="file.path + ' — click to open full diff modal'"
                                  >
                                    <span
                                      class="status-badge"
                                      [class]="'status-' + file.status"
                                      [title]="statusLabel(file.status)"
                                    >{{ statusChar(file.status) }}</span>
                                    <span class="file-name">{{ fileBasename(file.path) }}</span>
                                    <span class="file-dir">{{ fileDirname(file.path) }}</span>
                                  </button>
                                  <button
                                    type="button"
                                    class="file-action file-action-discard"
                                    (click)="onDiscardFile(repo, file.path)"
                                    [disabled]="isWriting(repo.absolutePath)"
                                    title="Discard changes (revert to HEAD)"
                                    [attr.aria-label]="'Discard ' + file.path"
                                  >⌫</button>
                                  <button
                                    type="button"
                                    class="file-action file-action-stage"
                                    (click)="onStageFile(repo.absolutePath, file.path)"
                                    [disabled]="isWriting(repo.absolutePath)"
                                    title="Stage file (git add)"
                                    [attr.aria-label]="'Stage ' + file.path"
                                  >+</button>
                                </div>
                                @if (store.isFileExpanded(repo.absolutePath, file.path, false)) {
                                  <app-source-control-inline-diff
                                    [workingDirectory]="repo.absolutePath"
                                    [filePath]="file.path"
                                    [staged]="false"
                                  />
                                }
                              </div>
                            }
                            <div class="change-group-actions">
                              <button
                                type="button"
                                class="group-action"
                                (click)="onStageAllUnstaged(repo)"
                                [disabled]="isWriting(repo.absolutePath)"
                                title="Stage all changes"
                              >Stage all</button>
                            </div>
                          </div>
                        }

                        @if (repo.status.untracked.length > 0) {
                          <div class="change-group">
                            <div class="change-group-title">Untracked ({{ repo.status.untracked.length }})</div>
                            @for (path of repo.status.untracked; track path) {
                              <div class="file-row-line">
                                <!-- Spacer keeps untracked rows aligned with
                                     chevron'd staged/unstaged rows. Untracked
                                     files have no diff to expand. -->
                                <span class="file-expand-chevron-spacer" aria-hidden="true"></span>
                                <div class="file-row" [title]="path">
                                  <span class="status-badge status-untracked" title="Untracked">?</span>
                                  <span class="file-name">{{ fileBasename(path) }}</span>
                                  <span class="file-dir">{{ fileDirname(path) }}</span>
                                </div>
                                <button
                                  type="button"
                                  class="file-action file-action-discard"
                                  (click)="onDiscardUntracked(repo, path)"
                                  [disabled]="isWriting(repo.absolutePath)"
                                  title="Move to Trash (recoverable)"
                                  [attr.aria-label]="'Trash ' + path"
                                >⌫</button>
                                <button
                                  type="button"
                                  class="file-action file-action-stage"
                                  (click)="onStageFile(repo.absolutePath, path)"
                                  [disabled]="isWriting(repo.absolutePath)"
                                  title="Stage file (git add)"
                                  [attr.aria-label]="'Stage ' + path"
                                >+</button>
                              </div>
                            }
                            <div class="change-group-actions">
                              <button
                                type="button"
                                class="group-action"
                                (click)="onStageAllUntracked(repo)"
                                [disabled]="isWriting(repo.absolutePath)"
                                title="Stage all untracked"
                              >Stage all</button>
                            </div>
                          </div>
                        }
                      }
                    </div>
                  }
                </section>
              }
            }
        </div>
      </div>
    </div>

    @if (store.diffRequest(); as req) {
      <app-source-control-diff-viewer
        [workingDirectory]="req.workingDirectory"
        [repoName]="req.repoName"
        [filePath]="req.filePath"
        [staged]="req.staged"
        (closeRequested)="store.closeDiff()"
      />
    }
  `,
  styles: [`
    :host {
      display: flex;
      height: 100%;
    }

    .source-control-wrapper {
      display: flex;
      height: 100%;
      position: relative;
    }

    .source-control-wrapper.resizing {
      user-select: none;
      cursor: col-resize;
    }

    .resize-handle {
      width: 4px;
      height: 100%;
      background: transparent;
      cursor: col-resize;
      flex-shrink: 0;
      transition: background var(--transition-fast);
      z-index: 10;
    }

    .resize-handle:hover,
    .resize-handle.dragging {
      background: var(--secondary-color);
      box-shadow: 0 0 12px rgba(var(--secondary-rgb), 0.5);
    }

    .source-control {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-secondary);
      border-left: 1px solid var(--border-color);
      min-width: 36px;
      max-width: 500px;
      overflow: hidden;
      position: relative;
    }

    .panel-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 10px;
      border-bottom: 1px solid var(--border-color);
      user-select: none;
      flex-shrink: 0;
      background: var(--bg-tertiary);
    }

    .collapse-icon {
      font-size: 14px;
      color: var(--text-muted);
      width: 16px;
      text-align: center;
    }

    .header-title {
      font-family: var(--font-display);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      color: var(--text-secondary);
      white-space: nowrap;
      flex: 1;
    }

    .header-action {
      width: 24px;
      height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--text-muted);
      cursor: pointer;
      font-size: 14px;
      transition: all var(--transition-fast);
    }

    .header-action:hover:not(:disabled) {
      color: var(--secondary-color);
      background: var(--bg-hover);
      border-color: var(--border-subtle);
    }

    .header-action:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .header-action .spinning {
      display: inline-block;
      animation: sc-spin 0.8s linear infinite;
    }

    @keyframes sc-spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    .header-close {
      width: 24px;
      height: 24px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--text-muted);
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      transition: all var(--transition-fast);
    }

    .header-close:hover {
      color: var(--text-primary);
      background: var(--bg-hover);
      border-color: var(--border-subtle);
    }

    .panel-body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      overflow-x: hidden;
      padding: var(--spacing-xs) 0;
    }

    .panel-body::-webkit-scrollbar { width: 8px; }
    .panel-body::-webkit-scrollbar-track {
      background: var(--bg-tertiary);
      border-radius: 4px;
    }
    .panel-body::-webkit-scrollbar-thumb {
      background: var(--border-light);
      border-radius: 4px;
      border: 2px solid var(--bg-tertiary);
    }

    .empty-state {
      padding: 28px 16px;
      text-align: center;
      color: var(--text-muted);
      font-size: 12px;
    }

    .empty-state p {
      margin: 0;
      font-family: var(--font-display);
    }

    .empty-state .hint {
      margin-top: 6px;
      font-family: var(--font-mono);
      font-size: 10px;
      letter-spacing: 0.03em;
      opacity: 0.7;
    }

    .empty-state code {
      font-family: var(--font-mono);
      background: var(--bg-tertiary);
      padding: 1px 4px;
      border-radius: 3px;
    }

    .loading, .error {
      padding: 20px;
      text-align: center;
      font-family: var(--font-mono);
      font-size: 11px;
      letter-spacing: 0.02em;
    }

    .loading { color: var(--text-muted); }
    .error { color: var(--error-color); }

    .repo {
      border-bottom: 1px solid var(--border-subtle);
    }

    .repo:last-child {
      border-bottom: none;
    }

    .repo-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      cursor: pointer;
      user-select: none;
      background: transparent;
      transition: background var(--transition-fast);
    }

    .repo-header:hover {
      background: var(--bg-hover);
    }

    .repo-chevron {
      width: 12px;
      font-size: 9px;
      color: var(--text-muted);
      flex-shrink: 0;
    }

    .repo.expanded .repo-chevron {
      color: var(--secondary-color);
    }

    .repo-icon {
      font-size: 13px;
      flex-shrink: 0;
    }

    .repo-name {
      flex: 1;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }

    .repo-branch {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-muted);
      padding: 2px 6px;
      background: var(--bg-tertiary);
      border-radius: 3px;
      flex-shrink: 0;
    }

    /* Ahead/behind chips (Phase 2a item 2) */
    .repo-track {
      font-family: var(--font-mono);
      font-size: 10px;
      padding: 2px 5px;
      border-radius: 3px;
      flex-shrink: 0;
    }

    .repo-ahead {
      color: #28c850;
      background: rgba(40, 200, 80, 0.12);
    }

    .repo-behind {
      color: #e1b400;
      background: rgba(225, 180, 0, 0.12);
    }

    .repo-badge {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-primary);
      background: rgba(var(--secondary-rgb), 0.2);
      padding: 2px 6px;
      border-radius: 999px;
      min-width: 20px;
      text-align: center;
      flex-shrink: 0;
    }

    .repo-loading-spinner {
      width: 10px;
      height: 10px;
      border: 1.5px solid var(--border-subtle);
      border-top-color: var(--secondary-color);
      border-radius: 50%;
      animation: sc-spin 0.6s linear infinite;
      flex-shrink: 0;
    }

    .repo-body {
      padding: 2px 0 6px;
    }

    .repo-error {
      padding: 8px 16px;
      color: var(--error-color);
      font-family: var(--font-mono);
      font-size: 10px;
    }

    .repo-clean {
      padding: 8px 16px 12px 36px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 11px;
      font-style: italic;
    }

    .change-group {
      padding: 4px 0;
    }

    .change-group-title {
      padding: 4px 16px 4px 28px;
      font-family: var(--font-mono);
      font-size: 9px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-muted);
    }

    /* File row container — wraps chevron + row line + (optional) inline diff. */
    .file-row-container {
      display: flex;
      flex-direction: column;
    }

    .file-row-line {
      display: flex;
      align-items: center;
    }

    .file-expand-chevron {
      width: 16px;
      height: 22px;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      cursor: pointer;
      color: var(--text-muted);
      font-size: 9px;
      margin-left: 12px;
      border-radius: 3px;
      transition: color var(--transition-fast), background var(--transition-fast);
    }

    .file-expand-chevron:hover {
      color: var(--secondary-color);
      background: var(--bg-hover);
    }

    .file-expand-chevron[aria-expanded="true"] {
      color: var(--secondary-color);
    }

    /* Invisible spacer for untracked rows so they line up with chevron'd rows. */
    .file-expand-chevron-spacer {
      width: 16px;
      height: 22px;
      flex-shrink: 0;
      margin-left: 12px;
      display: inline-block;
    }

    .file-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 10px 4px 12px;
      flex: 1;
      min-width: 0;
      background: transparent;
      border: none;
      text-align: left;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-secondary);
      cursor: default;
    }

    .file-row-clickable {
      cursor: pointer;
      transition: background var(--transition-fast);
    }

    .file-row-clickable:hover {
      background: var(--bg-hover);
      color: var(--text-primary);
    }

    .status-badge {
      width: 14px;
      height: 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 9px;
      font-weight: 700;
      border-radius: 3px;
      flex-shrink: 0;
    }

    .status-modified  { background: rgba(225, 180, 0, 0.18);  color: #e1b400; }
    .status-added     { background: rgba(40, 200, 80, 0.18);  color: #28c850; }
    .status-deleted   { background: rgba(232, 80, 80, 0.18);  color: #e85050; }
    .status-renamed   { background: rgba(120, 140, 220, 0.18); color: #8a9be8; }
    .status-copied    { background: rgba(120, 140, 220, 0.18); color: #8a9be8; }
    .status-untracked { background: rgba(160, 160, 160, 0.18); color: #a0a0a0; }
    .status-ignored   { background: rgba(120, 120, 120, 0.12); color: #888; }

    .file-name {
      flex: 0 0 auto;
      max-width: 50%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-dir {
      flex: 1;
      color: var(--text-muted);
      opacity: 0.7;
      font-size: 10px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      direction: rtl;
      text-align: left;
    }

    /* Stage / unstage hover affordance (Phase 2d item 7). The action
       button is visually quiet until the row is hovered, matching VS
       Code's SCM panel pattern. */
    .file-action {
      width: 22px;
      height: 22px;
      flex-shrink: 0;
      margin-right: 8px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--text-muted);
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
      opacity: 0;
      transition: opacity var(--transition-fast),
                  color var(--transition-fast),
                  background var(--transition-fast),
                  border-color var(--transition-fast);
    }

    .file-row-line:hover .file-action,
    .file-action:focus,
    .file-action:focus-visible {
      opacity: 1;
    }

    .file-action:hover:not(:disabled) {
      color: var(--text-primary);
      background: var(--bg-hover);
      border-color: var(--border-subtle);
    }

    .file-action-stage:hover:not(:disabled) {
      color: #28c850;
    }

    .file-action-unstage:hover:not(:disabled) {
      color: #e85050;
    }

    /* Phase 2d item 8 — discard button. Warning color signals the
       destructive nature; the actual destructive call routes tracked
       paths through git restore --source=HEAD --staged --worktree, and
       untracked paths through shell.trashItem (recoverable from Trash). */
    .file-action-discard:hover:not(:disabled) {
      color: #e85050;
      border-color: rgba(232, 80, 80, 0.4);
    }

    .file-action:disabled {
      opacity: 0.35;
      cursor: default;
    }

    /* Group-level "Stage all" / "Unstage all" — appears at the bottom
       of each change-group. Subdued visual until hovered. */
    .change-group-actions {
      display: flex;
      justify-content: flex-end;
      padding: 4px 12px 4px 28px;
    }

    .group-action {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-muted);
      background: transparent;
      border: 1px solid var(--border-subtle);
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all var(--transition-fast);
    }

    .group-action:hover:not(:disabled) {
      color: var(--text-primary);
      background: var(--bg-hover);
      border-color: var(--secondary-color);
    }

    .group-action:disabled {
      opacity: 0.4;
      cursor: default;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SourceControlComponent {
  protected store = inject(SourceControlStore);
  private viewLayoutService = inject(ViewLayoutService);

  closeRequested = output<void>();

  // Panel-local UI state — width/resize do not belong on the store since
  // they're purely cosmetic and tied to this rendering of the panel.
  panelWidth = signal(this.viewLayoutService.sourceControlWidth);
  isResizing = signal(false);
  private resizeStartX = 0;
  private resizeStartWidth = 0;

  /** Display name derived from the store's active root. */
  rootName = computed(() => {
    const path = this.store.activeRoot();
    if (!path) return '';
    const parts = path.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? path;
  });

  // -------------------------------------------------------------------------
  // Refresh button — delegates to the store
  // -------------------------------------------------------------------------

  refresh(): void {
    void this.store.refresh();
  }

  // -------------------------------------------------------------------------
  // Resize handlers
  // -------------------------------------------------------------------------

  onResizeStart(event: MouseEvent): void {
    event.preventDefault();
    this.isResizing.set(true);
    this.resizeStartX = event.clientX;
    this.resizeStartWidth = this.panelWidth();
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(event: MouseEvent): void {
    if (!this.isResizing()) return;
    const delta = this.resizeStartX - event.clientX;
    const newWidth = Math.max(220, Math.min(500, this.resizeStartWidth + delta));
    this.panelWidth.set(newWidth);
    this.viewLayoutService.setSourceControlWidth(newWidth);
  }

  @HostListener('document:mouseup')
  onMouseUp(): void {
    if (this.isResizing()) {
      this.isResizing.set(false);
    }
  }

  // -------------------------------------------------------------------------
  // Pure presentational helpers
  // -------------------------------------------------------------------------

  changeCount(repo: RepoState): number {
    if (!repo.status) return 0;
    return (
      repo.status.staged.length +
      repo.status.unstaged.length +
      repo.status.untracked.length
    );
  }

  branchTooltip(status: GitStatusResponse): string {
    const parts: string[] = [`branch: ${status.branch}`];
    if (status.ahead) parts.push(`ahead ${status.ahead}`);
    if (status.behind) parts.push(`behind ${status.behind}`);
    return parts.join(' · ');
  }

  fileBasename(filePath: string): string {
    const idx = filePath.lastIndexOf('/');
    return idx === -1 ? filePath : filePath.slice(idx + 1);
  }

  fileDirname(filePath: string): string {
    const idx = filePath.lastIndexOf('/');
    return idx === -1 ? '' : filePath.slice(0, idx);
  }

  statusChar(status: FileChangeStatus): string {
    switch (status) {
      case 'added': return 'A';
      case 'modified': return 'M';
      case 'deleted': return 'D';
      case 'renamed': return 'R';
      case 'copied': return 'C';
      case 'untracked': return '?';
      case 'ignored': return '!';
      default: return '·';
    }
  }

  statusLabel(status: FileChangeStatus): string {
    return status.charAt(0).toUpperCase() + status.slice(1);
  }

  // -------------------------------------------------------------------------
  // Stage / unstage actions (Phase 2d — item 7)
  // -------------------------------------------------------------------------

  isWriting(repoPath: string): boolean {
    return this.store.isWriting(repoPath);
  }

  onStageFile(repoPath: string, filePath: string): void {
    void this.store.stageFiles(repoPath, [filePath]);
  }

  onUnstageFile(repoPath: string, filePath: string): void {
    void this.store.unstageFiles(repoPath, [filePath]);
  }

  onStageAllUnstaged(repo: RepoState): void {
    const status = repo.status;
    if (!status) return;
    const paths = status.unstaged.map(f => f.path);
    if (paths.length === 0) return;
    void this.store.stageFiles(repo.absolutePath, paths);
  }

  onStageAllUntracked(repo: RepoState): void {
    const status = repo.status;
    if (!status) return;
    if (status.untracked.length === 0) return;
    void this.store.stageFiles(repo.absolutePath, [...status.untracked]);
  }

  onUnstageAll(repo: RepoState): void {
    const status = repo.status;
    if (!status) return;
    const paths = status.staged.map(f => f.path);
    if (paths.length === 0) return;
    void this.store.unstageFiles(repo.absolutePath, paths);
  }

  // -------------------------------------------------------------------------
  // Phase 2d item 8 — discard handlers.
  // Tracked files: confirm because the change is unrecoverable.
  // Untracked files: trash without confirm (shell.trashItem is reversible).
  // Untracked DIRECTORIES: confirm because losing a whole directory is a
  // bigger consequence and matches the plan's "confirmation modal required"
  // requirement for the directory case.
  // -------------------------------------------------------------------------

  onDiscardFile(repo: RepoState, filePath: string): void {
    const ok = window.confirm(
      `Discard changes to ${filePath}?\n\nThis reverts the file to HEAD and cannot be undone.`,
    );
    if (!ok) return;
    void this.store.discardFiles(repo.absolutePath, [filePath]);
  }

  onDiscardUntracked(repo: RepoState, filePath: string): void {
    // Untracked entries from `git status --porcelain` are paths relative
    // to the repo root. We can't reliably tell from the string whether
    // it points at a file or a directory, so do a heuristic: trailing `/`
    // means directory in git's output. For everything else we still ask
    // for the dir case via the OS — better to over-confirm than to lose
    // a folder accidentally.
    const looksLikeDir = filePath.endsWith('/');
    if (looksLikeDir) {
      const ok = window.confirm(
        `Move untracked directory "${filePath}" to the Trash?\n\n` +
        `You can recover it from your Trash if you change your mind.`,
      );
      if (!ok) return;
    }
    void this.store.discardFiles(repo.absolutePath, [filePath]);
  }
}
