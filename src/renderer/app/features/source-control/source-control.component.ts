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
  FileChange,
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
  // Multi-select + drag-to-attach — lets the user pick one or more changed
  // files (VS Code–style click / cmd-click / shift-click) and drag them into a
  // chat/session drop zone (same payload contract as the file explorer).
  //
  // Selection is keyed by ABSOLUTE path so a file is identified consistently
  // across the staged / unstaged / untracked groups and across repos. Git
  // status paths are RELATIVE to the repo root, but the drop target reads the
  // bytes from disk via IPC and therefore needs an absolute path — we join the
  // relative path onto `repo.absolutePath` so the receiving side gets the same
  // thing the file explorer would hand it.
  // -------------------------------------------------------------------------

  /** Absolute paths of the currently selected file rows. */
  private selectedPaths = signal(new Set<string>());
  /** Anchor for shift-click range selection (absolute path). */
  private lastSelectedPath = signal<string | null>(null);

  /**
   * Every selectable file row in render order, as absolute paths. Drives
   * shift-click range selection. Only expanded repos contribute, matching
   * what's actually on screen. A partially-staged file legitimately appears
   * twice (staged + unstaged groups); Set-based selection dedups it.
   */
  private orderedSelectablePaths = computed(() => {
    const out: string[] = [];
    for (const repo of this.store.visibleRepos()) {
      if (!this.store.isRepoExpanded(repo.absolutePath)) continue;
      const status = repo.status;
      if (!status) continue;
      for (const f of status.staged) out.push(this.toAbsolutePath(repo.absolutePath, f.path));
      for (const f of status.unstaged) out.push(this.toAbsolutePath(repo.absolutePath, f.path));
      for (const p of status.untracked) out.push(this.toAbsolutePath(repo.absolutePath, p));
    }
    return out;
  });

  isSelected(repo: RepoState, relativePath: string): boolean {
    return this.selectedPaths().has(this.toAbsolutePath(repo.absolutePath, relativePath));
  }

  /**
   * Row click with VS Code–style multi-select semantics:
   *  - plain click    → single-select this file and, for tracked files, open its diff
   *  - cmd/ctrl-click → toggle this file in the selection (no diff)
   *  - shift-click    → range-select from the anchor to this file (no diff)
   * `diff` is null for untracked rows (nothing to diff).
   */
  onFileRowClick(
    event: MouseEvent,
    repo: RepoState,
    relativePath: string,
    diff: { file: FileChange; staged: boolean } | null,
  ): void {
    const absolutePath = this.toAbsolutePath(repo.absolutePath, relativePath);

    if (event.metaKey || event.ctrlKey) {
      event.preventDefault();
      this.toggleSelection(absolutePath);
      return;
    }

    if (event.shiftKey) {
      event.preventDefault();
      this.selectRange(absolutePath);
      return;
    }

    this.selectedPaths.set(new Set([absolutePath]));
    this.lastSelectedPath.set(absolutePath);
    if (diff) {
      this.store.openDiff(repo, diff.file, diff.staged);
    }
  }

  private toggleSelection(absolutePath: string): void {
    const next = new Set(this.selectedPaths());
    if (next.has(absolutePath)) next.delete(absolutePath);
    else next.add(absolutePath);
    this.selectedPaths.set(next);
    this.lastSelectedPath.set(absolutePath);
  }

  private selectRange(toPath: string): void {
    const ordered = this.orderedSelectablePaths();
    const toIdx = ordered.indexOf(toPath);
    if (toIdx === -1) return;
    const anchor = this.lastSelectedPath();
    const fromIdx = anchor ? ordered.indexOf(anchor) : -1;
    if (fromIdx === -1) {
      // No usable anchor — fall back to single-select.
      this.selectedPaths.set(new Set([toPath]));
      this.lastSelectedPath.set(toPath);
      return;
    }
    const start = Math.min(fromIdx, toIdx);
    const end = Math.max(fromIdx, toIdx);
    this.selectedPaths.set(new Set(ordered.slice(start, end + 1)));
    // Keep the existing anchor so the user can grow/shrink the range.
  }

  onFileDragStart(event: DragEvent, repo: RepoState, relativePath: string): void {
    if (!event.dataTransfer) return;
    const absolutePath = this.toAbsolutePath(repo.absolutePath, relativePath);

    // Dragging a row that's part of the current selection drags the whole
    // selection (in render order, deduped); dragging an unselected row drags
    // just that file and resets the selection to it — mirrors the file explorer.
    let paths: string[];
    if (this.selectedPaths().has(absolutePath)) {
      const selected = this.selectedPaths();
      paths = [...new Set(this.orderedSelectablePaths().filter(p => selected.has(p)))];
      if (paths.length === 0) paths = [absolutePath];
    } else {
      paths = [absolutePath];
      this.selectedPaths.set(new Set([absolutePath]));
      this.lastSelectedPath.set(absolutePath);
    }

    // Mirror the file explorer's drag payload so the shared drop zone
    // (application/x-file-path[s]) treats these identically to tree drags.
    event.dataTransfer.setData('text/plain', paths.join('\n'));
    event.dataTransfer.setData('application/x-file-path', paths[0]);
    event.dataTransfer.setData('application/x-file-paths', JSON.stringify(paths));
    event.dataTransfer.effectAllowed = 'copy';

    // Custom drag image with a count badge for multi-file drags.
    if (paths.length > 1) {
      const dragEl = document.createElement('div');
      dragEl.style.cssText = 'position:absolute;top:-1000px;left:-1000px;padding:6px 12px;background:#1a1a2e;color:#e0e0e0;border:1px solid rgba(100,100,255,0.3);border-radius:6px;font-family:monospace;font-size:12px;white-space:nowrap;';
      dragEl.textContent = `${paths.length} files`;
      document.body.appendChild(dragEl);
      event.dataTransfer.setDragImage(dragEl, 0, 0);
      requestAnimationFrame(() => document.body.removeChild(dragEl));
    }
  }

  private toAbsolutePath(repoRoot: string, relativePath: string): string {
    const root = repoRoot.endsWith('/') ? repoRoot.slice(0, -1) : repoRoot;
    return `${root}/${relativePath}`;
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
