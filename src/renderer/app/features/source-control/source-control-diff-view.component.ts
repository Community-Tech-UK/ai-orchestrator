/**
 * SourceControlDiffViewComponent — pure presentational render of a
 * `DiffLoader`'s state.
 *
 * Used by both the modal (`source-control-diff-viewer.component.ts`)
 * and the inline expansion row
 * (`source-control-inline-diff.component.ts`). Owns no fetch logic —
 * the parent passes a `DiffLoader` instance via the `loader` input
 * and this component reads its signals.
 *
 * Rendering groups diff lines into per-hunk blocks so each `@@ … @@`
 * header is visually separated from the others. This is purely
 * presentational — no accept/reject backend exists.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { groupHunks } from './diff-loader';
import type { DiffLoader } from './diff-loader';

@Component({
  selector: 'app-source-control-diff-view',
  standalone: true,
  template: `
    @if (loader().isLoading() && !loader().file()) {
      <div class="diff-loading">Loading diff…</div>
    } @else if (loader().errorMessage(); as err) {
      <div class="diff-error">{{ err }}</div>
    } @else if (loader().file(); as f) {
      @if (f.isBinary) {
        <div class="diff-binary">Binary file — not displayed.</div>
      } @else if (f.hunks.length === 0) {
        <div class="diff-empty">No textual changes.</div>
      } @else {
        <div class="diff-hunks">
          @for (hunk of hunkGroups(); track $index) {
            <div class="diff-hunk">
              <div class="diff-hunk-header">{{ hunk.header.text }}</div>
              <pre class="diff-pre">@for (line of hunk.body; track $index) {<span class="diff-line diff-line-{{ line.kind }}">{{ line.text }}</span><br />}</pre>
            </div>
          }
        </div>
      }
    } @else {
      <div class="diff-empty">No diff available for this file.</div>
    }
  `,
  styles: [`
    :host {
      display: block;
    }

    .diff-loading,
    .diff-error,
    .diff-empty,
    .diff-binary {
      padding: 32px 18px;
      text-align: center;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
    }

    .diff-error {
      color: var(--error-color);
    }

    .diff-hunks {
      display: flex;
      flex-direction: column;
    }

    .diff-hunk {
      border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.06));

      &:last-child {
        border-bottom: none;
      }
    }

    .diff-hunk-header {
      padding: 4px 18px;
      font-family: var(--font-mono);
      font-size: 11px;
      background: rgba(120, 140, 220, 0.1);
      color: #8a9be8;
      border-top: 1px solid rgba(120, 140, 220, 0.15);
      border-bottom: 1px solid rgba(120, 140, 220, 0.15);
      user-select: none;
    }

    .diff-pre {
      margin: 0;
      padding: 4px 0;
      font-family: var(--font-mono);
      font-size: 12px;
      line-height: 1.5;
      color: var(--text-primary);
      white-space: pre;
      tab-size: 2;
    }

    .diff-line {
      display: inline-block;
      width: 100%;
      padding: 0 18px;
      box-sizing: border-box;
    }

    .diff-line-add {
      background: rgba(40, 200, 80, 0.12);
      color: #95e0a8;
    }

    .diff-line-remove {
      background: rgba(232, 80, 80, 0.12);
      color: #f0a0a0;
    }

    .diff-line-meta {
      color: var(--text-muted);
      opacity: 0.7;
    }

    .diff-line-context {
      color: var(--text-secondary);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SourceControlDiffViewComponent {
  loader = input.required<DiffLoader>();

  /** Flat rendered lines grouped into per-hunk blocks for visual separation. */
  protected readonly hunkGroups = computed(() => groupHunks(this.loader().renderedLines()));
}
