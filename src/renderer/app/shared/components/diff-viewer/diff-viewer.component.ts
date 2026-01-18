/**
 * Diff Viewer Component - Display file differences
 *
 * Features:
 * - Side-by-side and inline diff views
 * - Syntax highlighting
 * - Line numbers
 * - Accept/reject per change (optional)
 */

import {
  Component,
  input,
  output,
  computed,
  signal,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { DiffService, DiffLine, DiffResult } from '../../../core/services/diff.service';

export type DiffViewMode = 'inline' | 'split';

export interface DiffAction {
  lineIndex: number;
  action: 'accept' | 'reject';
  line: DiffLine;
}

@Component({
  selector: 'app-diff-viewer',
  standalone: true,
  template: `
    <div class="diff-viewer" [class.split-view]="viewMode() === 'split'">
      <!-- Header -->
      <div class="diff-header">
        <div class="diff-stats">
          <span class="stat additions">+{{ stats().additions }}</span>
          <span class="stat deletions">-{{ stats().deletions }}</span>
        </div>

        <div class="view-toggle">
          <button
            class="toggle-btn"
            [class.active]="viewMode() === 'inline'"
            (click)="viewMode.set('inline')"
          >
            Inline
          </button>
          <button
            class="toggle-btn"
            [class.active]="viewMode() === 'split'"
            (click)="viewMode.set('split')"
          >
            Split
          </button>
        </div>

        @if (fileName()) {
          <div class="file-name">{{ fileName() }}</div>
        }
      </div>

      <!-- Content -->
      @if (viewMode() === 'inline') {
        <!-- Inline View -->
        <div class="diff-content inline">
          <table class="diff-table">
            <tbody>
              @for (line of diffResult().lines; track $index; let i = $index) {
                <tr
                  class="diff-line"
                  [class.line-add]="line.type === 'add'"
                  [class.line-remove]="line.type === 'remove'"
                  [class.line-info]="line.type === 'info'"
                >
                  <td class="line-number old">
                    {{ line.oldLineNumber || '' }}
                  </td>
                  <td class="line-number new">
                    {{ line.newLineNumber || '' }}
                  </td>
                  <td class="line-marker">
                    @if (line.type === 'add') { + }
                    @else if (line.type === 'remove') { - }
                    @else if (line.type === 'info') { @@ }
                  </td>
                  <td class="line-content">
                    @if (line.changes) {
                      @for (change of line.changes; track $index) {
                        <span
                          [class.char-add]="change.added"
                          [class.char-remove]="change.removed"
                        >{{ change.value }}</span>
                      }
                    } @else {
                      {{ line.content }}
                    }
                  </td>
                  @if (interactive()) {
                    <td class="line-actions">
                      @if (line.type === 'add' || line.type === 'remove') {
                        <button
                          class="action-btn accept"
                          title="Accept change"
                          (click)="emitAction(i, 'accept', line)"
                        >
                          <svg viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                          </svg>
                        </button>
                        <button
                          class="action-btn reject"
                          title="Reject change"
                          (click)="emitAction(i, 'reject', line)"
                        >
                          <svg viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd" />
                          </svg>
                        </button>
                      }
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>
      } @else {
        <!-- Split View -->
        <div class="diff-content split">
          <div class="split-pane old-pane">
            <div class="pane-header">Original</div>
            <table class="diff-table">
              <tbody>
                @for (line of splitView().oldLines; track $index) {
                  <tr
                    class="diff-line"
                    [class.line-remove]="line.type === 'remove'"
                    [class.line-empty]="line.type === 'add'"
                  >
                    <td class="line-number">
                      {{ line.oldLineNumber || '' }}
                    </td>
                    <td class="line-content">
                      @if (line.type !== 'add') {
                        @if (line.changes && line.type === 'remove') {
                          @for (change of line.changes; track $index) {
                            @if (!change.added) {
                              <span [class.char-remove]="change.removed">{{ change.value }}</span>
                            }
                          }
                        } @else {
                          {{ line.content }}
                        }
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>

          <div class="split-pane new-pane">
            <div class="pane-header">Modified</div>
            <table class="diff-table">
              <tbody>
                @for (line of splitView().newLines; track $index) {
                  <tr
                    class="diff-line"
                    [class.line-add]="line.type === 'add'"
                    [class.line-empty]="line.type === 'remove'"
                  >
                    <td class="line-number">
                      {{ line.newLineNumber || '' }}
                    </td>
                    <td class="line-content">
                      @if (line.type !== 'remove') {
                        @if (line.changes && line.type === 'add') {
                          @for (change of line.changes; track $index) {
                            @if (!change.removed) {
                              <span [class.char-add]="change.added">{{ change.value }}</span>
                            }
                          }
                        } @else {
                          {{ line.content }}
                        }
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .diff-viewer {
      display: flex;
      flex-direction: column;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      overflow: hidden;
      background: var(--bg-primary);
    }

    .diff-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      padding: var(--spacing-sm) var(--spacing-md);
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
    }

    .diff-stats {
      display: flex;
      gap: var(--spacing-sm);
      font-family: var(--font-mono);
      font-size: 0.875em;
    }

    .stat {
      padding: 0.125em 0.5em;
      border-radius: var(--radius-sm);
    }

    .stat.additions {
      background: var(--success-bg);
      color: var(--success-color);
    }

    .stat.deletions {
      background: var(--error-bg);
      color: var(--error-color);
    }

    .view-toggle {
      display: flex;
      gap: 1px;
      background: var(--border-color);
      border-radius: var(--radius-sm);
      overflow: hidden;
    }

    .toggle-btn {
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 0.75em;
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      border: none;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      &.active {
        background: var(--primary-color);
        color: white;
      }
    }

    .file-name {
      margin-left: auto;
      font-family: var(--font-mono);
      font-size: 0.875em;
      color: var(--text-secondary);
    }

    .diff-content {
      overflow: auto;
      font-family: var(--font-mono);
      font-size: 0.875em;
      line-height: 1.5;
    }

    .diff-content.split {
      display: flex;
    }

    .split-pane {
      flex: 1;
      min-width: 0;
      overflow: auto;

      &:first-child {
        border-right: 1px solid var(--border-color);
      }
    }

    .pane-header {
      padding: var(--spacing-xs) var(--spacing-sm);
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
      font-size: 0.75em;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .diff-table {
      width: 100%;
      border-collapse: collapse;
      table-layout: fixed;
    }

    .diff-line {
      &:hover {
        background: var(--bg-hover);
      }

      &.line-add {
        background: rgba(16, 185, 129, 0.1);

        .line-number, .line-marker {
          background: rgba(16, 185, 129, 0.2);
          color: var(--success-color);
        }
      }

      &.line-remove {
        background: rgba(239, 68, 68, 0.1);

        .line-number, .line-marker {
          background: rgba(239, 68, 68, 0.2);
          color: var(--error-color);
        }
      }

      &.line-info {
        background: var(--bg-secondary);
        color: var(--text-muted);

        .line-content {
          font-style: italic;
        }
      }

      &.line-empty {
        background: var(--bg-secondary);

        .line-content {
          opacity: 0;
        }
      }
    }

    .line-number {
      width: 50px;
      padding: 0 var(--spacing-sm);
      text-align: right;
      color: var(--text-muted);
      background: var(--bg-secondary);
      user-select: none;
      vertical-align: top;

      &.old, &.new {
        width: 40px;
      }
    }

    .line-marker {
      width: 20px;
      padding: 0 var(--spacing-xs);
      text-align: center;
      color: var(--text-muted);
      background: var(--bg-secondary);
      user-select: none;
      vertical-align: top;
    }

    .line-content {
      padding: 0 var(--spacing-sm);
      white-space: pre-wrap;
      word-break: break-all;
    }

    .char-add {
      background: rgba(16, 185, 129, 0.3);
      border-radius: 2px;
    }

    .char-remove {
      background: rgba(239, 68, 68, 0.3);
      border-radius: 2px;
    }

    .line-actions {
      width: 60px;
      padding: 0 var(--spacing-xs);
      text-align: center;
      vertical-align: middle;
    }

    .action-btn {
      width: 20px;
      height: 20px;
      padding: 2px;
      margin: 0 2px;
      border: none;
      border-radius: var(--radius-sm);
      cursor: pointer;
      opacity: 0;
      transition: all var(--transition-fast);

      svg {
        width: 100%;
        height: 100%;
      }

      &.accept {
        background: var(--success-bg);
        color: var(--success-color);

        &:hover {
          background: var(--success-color);
          color: white;
        }
      }

      &.reject {
        background: var(--error-bg);
        color: var(--error-color);

        &:hover {
          background: var(--error-color);
          color: white;
        }
      }
    }

    .diff-line:hover .action-btn {
      opacity: 1;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DiffViewerComponent {
  // Inputs
  oldContent = input<string>('');
  newContent = input<string>('');
  fileName = input<string>('');
  interactive = input<boolean>(false);
  initialViewMode = input<DiffViewMode>('inline');

  // Outputs
  actionClicked = output<DiffAction>();

  // State
  viewMode = signal<DiffViewMode>('inline');

  private diffService = inject(DiffService);

  constructor() {
    // Initialize view mode from input
    const initial = this.initialViewMode();
    if (initial) {
      this.viewMode.set(initial);
    }
  }

  // Computed values
  diffResult = computed(() => {
    return this.diffService.computeDiffWithCharChanges(
      this.oldContent(),
      this.newContent()
    );
  });

  stats = computed(() => {
    const result = this.diffResult();
    return {
      additions: result.additions,
      deletions: result.deletions,
      changes: result.changes,
    };
  });

  splitView = computed(() => {
    const result = this.diffResult();
    const oldLines: DiffLine[] = [];
    const newLines: DiffLine[] = [];

    // Group lines for split view
    let i = 0;
    while (i < result.lines.length) {
      const line = result.lines[i];

      if (line.type === 'unchanged') {
        oldLines.push(line);
        newLines.push(line);
        i++;
      } else if (line.type === 'remove') {
        // Check if next line is an add (modification)
        if (i + 1 < result.lines.length && result.lines[i + 1].type === 'add') {
          oldLines.push(line);
          newLines.push(result.lines[i + 1]);
          i += 2;
        } else {
          oldLines.push(line);
          newLines.push({ ...line, type: 'remove' as const }); // placeholder for alignment
          i++;
        }
      } else if (line.type === 'add') {
        oldLines.push({ ...line, type: 'add' as const }); // placeholder for alignment
        newLines.push(line);
        i++;
      } else {
        // info lines
        oldLines.push(line);
        newLines.push(line);
        i++;
      }
    }

    return { oldLines, newLines };
  });

  emitAction(index: number, action: 'accept' | 'reject', line: DiffLine): void {
    this.actionClicked.emit({ lineIndex: index, action, line });
  }
}
