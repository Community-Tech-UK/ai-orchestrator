/**
 * Source Control Diff Viewer — modal overlay showing a unified diff for one
 * file. Opened from the SourceControlComponent when the user clicks a file
 * row in the staged or unstaged list.
 *
 * Rendering is delegated to `SourceControlDiffViewComponent`. The modal
 * adds the chrome: title, stats, close button, and Open-in-editor button
 * (Phase 2c item 6).
 */

import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { VcsIpcService } from '../../core/services/ipc/vcs-ipc.service';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { DiffLoader } from './diff-loader';
import { SourceControlDiffViewComponent } from './source-control-diff-view.component';
import { resolveRelativePath } from '../../../../shared/utils/cross-platform-path';

@Component({
  selector: 'app-source-control-diff-viewer',
  standalone: true,
  imports: [SourceControlDiffViewComponent],
  template: `
    <div
      class="diff-backdrop"
      (click)="onBackdropClick($event)"
      (keydown.escape)="closeRequested.emit()"
      tabindex="-1"
    >
      <div class="diff-modal" role="dialog" aria-modal="true" aria-label="File diff">
        <header class="diff-header">
          <div class="diff-title-block">
            <div class="diff-eyebrow">{{ repoName() }} · {{ staged() ? 'staged' : 'unstaged' }}</div>
            <div class="diff-title" [title]="filePath()">{{ filePath() }}</div>
          </div>
          @if (loader.file(); as f) {
            <div class="diff-stats">
              <span class="stat-add">+{{ f.additions }}</span>
              <span class="stat-del">−{{ f.deletions }}</span>
            </div>
          }
          <button
            type="button"
            class="diff-action"
            (click)="onOpenInEditor()"
            [disabled]="openInEditorPending()"
            [title]="openInEditorTitle()"
            aria-label="Open file in editor"
          >
            <!-- inline icon: external-link / arrow-up-right-from-square -->
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 4h6v6" />
              <path d="M20 4l-8 8" />
              <path d="M10 6H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4" />
            </svg>
          </button>
          <button
            type="button"
            class="diff-close"
            (click)="closeRequested.emit()"
            title="Close (Esc)"
          >×</button>
        </header>

        @if (openInEditorError(); as err) {
          <div class="open-in-editor-error" role="alert">
            <span>{{ err }}</span>
            <button type="button" class="open-in-editor-error-dismiss"
              (click)="openInEditorError.set(null)"
              aria-label="Dismiss editor error">×</button>
          </div>
        }

        <div class="diff-body">
          <app-source-control-diff-view [loader]="loader" />
        </div>
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: block;
    }

    .diff-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      backdrop-filter: blur(2px);
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 32px;
      animation: scdv-fade-in 0.12s ease-out;
    }

    @keyframes scdv-fade-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    .diff-modal {
      display: flex;
      flex-direction: column;
      width: min(1100px, 100%);
      max-height: 100%;
      background: var(--bg-primary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-lg, 12px);
      box-shadow: 0 30px 80px rgba(0, 0, 0, 0.5);
      overflow: hidden;
    }

    .diff-header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--border-color);
      background: var(--bg-tertiary);
    }

    .diff-title-block {
      flex: 1;
      min-width: 0;
    }

    .diff-eyebrow {
      font-family: var(--font-mono);
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      color: var(--text-muted);
      margin-bottom: 4px;
    }

    .diff-title {
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--text-primary);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .diff-stats {
      display: flex;
      gap: 10px;
      font-family: var(--font-mono);
      font-size: 12px;
      flex-shrink: 0;
    }

    .stat-add { color: #28c850; }
    .stat-del { color: #e85050; }

    .diff-action,
    .diff-close {
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: 1px solid var(--border-subtle);
      color: var(--text-secondary);
      cursor: pointer;
      transition: all var(--transition-fast);
    }

    .diff-action {
      width: 32px;
      height: 32px;
      border-radius: 8px;
    }

    .diff-action:hover:not(:disabled) {
      color: var(--text-primary);
      background: var(--bg-hover);
    }

    .diff-action:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .diff-close {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      font-size: 20px;
      line-height: 1;
    }

    .diff-close:hover {
      color: var(--text-primary);
      background: var(--bg-hover);
    }

    .open-in-editor-error {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 18px;
      background: rgba(232, 80, 80, 0.08);
      border-bottom: 1px solid rgba(232, 80, 80, 0.25);
      color: var(--error-color);
      font-family: var(--font-mono);
      font-size: 11px;
    }

    .open-in-editor-error span {
      flex: 1;
    }

    .open-in-editor-error-dismiss {
      width: 22px;
      height: 22px;
      background: transparent;
      border: none;
      color: inherit;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
    }

    .diff-body {
      flex: 1;
      min-height: 0;
      overflow: auto;
      background: var(--bg-primary);
    }

    .diff-body::-webkit-scrollbar { width: 10px; height: 10px; }
    .diff-body::-webkit-scrollbar-track { background: var(--bg-secondary); }
    .diff-body::-webkit-scrollbar-thumb {
      background: var(--border-light);
      border-radius: 4px;
      border: 2px solid var(--bg-secondary);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SourceControlDiffViewerComponent {
  private vcs = inject(VcsIpcService);
  private fileIpc = inject(FileIpcService);

  workingDirectory = input.required<string>();
  repoName = input.required<string>();
  filePath = input.required<string>();
  staged = input.required<boolean>();

  closeRequested = output<void>();

  /** Per-modal loader. Tied to the component lifecycle. */
  protected readonly loader = new DiffLoader(this.vcs);

  /**
   * Set while an `editorOpen` IPC is in flight so we can disable the
   * button (avoid duplicate launches if the editor is slow).
   */
  protected readonly openInEditorPending = signal(false);

  /**
   * Surface editor errors inline (no editor configured, launch failed,
   * etc.) instead of swallowing them. Plan item 6: "surface the error
   * from editorOpen — don't silently open the repo directory".
   */
  protected readonly openInEditorError = signal<string | null>(null);

  constructor() {
    effect(() => {
      // Re-fetch whenever the inputs change.
      const wd = this.workingDirectory();
      const fp = this.filePath();
      const st = this.staged();
      void this.loader.load(wd, fp, st);
    });
  }

  /** Used by the Open-in-editor button title; tells the user what we'll do. */
  protected openInEditorTitle(): string {
    if (this.openInEditorPending()) return 'Opening…';
    const line = this.loader.jumpLine();
    return line > 1 ? `Open in editor (line ${line})` : 'Open in editor';
  }

  protected async onOpenInEditor(): Promise<void> {
    if (this.openInEditorPending()) return;
    this.openInEditorPending.set(true);
    this.openInEditorError.set(null);

    const abs = resolveRelativePath(this.workingDirectory(), this.filePath());
    const line = this.loader.jumpLine();
    const hasHunks = (this.loader.file()?.hunks.length ?? 0) > 0;

    try {
      const response = hasHunks
        ? await this.fileIpc.editorOpenFileAtLine(abs, line)
        : await this.fileIpc.editorOpenFile(abs);
      if (!response.success) {
        this.openInEditorError.set(
          response.error?.message ?? 'No editor configured. Set one in Settings → Editor.',
        );
      }
    } catch (err) {
      this.openInEditorError.set((err as Error).message || 'Failed to open file in editor.');
    } finally {
      this.openInEditorPending.set(false);
    }
  }

  protected onBackdropClick(event: MouseEvent): void {
    // Close only when the user clicks the backdrop itself, not inside the modal.
    if (event.target === event.currentTarget) {
      this.closeRequested.emit();
    }
  }

  @HostListener('document:keydown.escape')
  protected onEscape(): void {
    this.closeRequested.emit();
  }
}
