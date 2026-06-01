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
  templateUrl: './source-control.component.html',
  styleUrl: './source-control.component.scss',
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
