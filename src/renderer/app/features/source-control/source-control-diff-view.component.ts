/**
 * SourceControlDiffViewComponent — pure presentational render of a
 * `DiffLoader`'s state, plus WS-C4 inline diff review comments.
 *
 * Used by both the modal (`source-control-diff-viewer.component.ts`)
 * and the inline expansion row
 * (`source-control-inline-diff.component.ts`). Owns no fetch logic —
 * the parent passes a `DiffLoader` instance via the `loader` input
 * and this component reads its signals.
 *
 * Rendering groups diff lines into per-hunk blocks so each `@@ … @@`
 * header is visually separated from the others. No accept/reject
 * backend exists.
 *
 * WS-C4: each non-header/meta line is a selectable row. Click, or
 * click+shift-click on a later row of the SAME side within the SAME hunk,
 * selects a contiguous line range; the keyboard equivalent is
 * focus-a-row + Shift+ArrowUp/Down to extend, Enter to open the comment
 * editor for the current selection. A saved comment becomes a
 * `DiffAnnotation` in the per-instance `DiffReviewDraftStore` (keyed by the
 * currently selected instance). "Send review" composes every draft
 * annotation for this instance into one structured packet
 * (`buildReviewPacket`) and sends it through the existing instance
 * messaging path (`InstanceStore.sendInput`) — the same path used for
 * both idle and loop-active instances — then clears the draft.
 *
 * See docs/plans/2026-07-30-sibling-audit-round2_plan.md §WS-C4.
 */

import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { groupHunks } from './diff-loader';
import type { DiffLoader } from './diff-loader';
import type { RenderedDiffLine } from './source-control.types';
import { InstanceStore } from '../../core/state/instance.store';
import { DiffReviewDraftStore } from './diff-review-draft.store';
import { buildReviewPacket } from './diff-review-packet';
import type {
  DiffAnnotation,
  DiffAnnotationLineRange,
  DiffAnnotationSide,
} from '../../../../shared/types/diff-annotation.types';

/** One selectable row, flattened across every hunk, for hit-testing/keyboard nav. */
interface SelectableRow {
  hunkIndex: number;
  lineIndex: number;
  side: DiffAnnotationSide;
  lineNumber: number;
  /** Raw rendered text (including the leading +/-/space marker) — the exact excerpt unit. */
  text: string;
}

interface SelectionAnchor {
  hunkIndex: number;
  side: DiffAnnotationSide;
  lineIndex: number;
}

interface PendingEditor {
  path: string;
  side: DiffAnnotationSide;
  lineRange: DiffAnnotationLineRange;
  excerpt: string;
  commentDraft: string;
}

function rowKey(hunkIndex: number, lineIndex: number): string {
  return `${hunkIndex}:${lineIndex}`;
}

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
        @if (currentAnnotations().length > 0 || draftCount() > 0) {
          <div class="diff-review-bar">
            <span class="diff-review-count">
              {{ currentAnnotations().length }} comment{{ currentAnnotations().length === 1 ? '' : 's' }} on this file
              @if (draftCount() !== currentAnnotations().length) {
                &middot; {{ draftCount() }} total in draft
              }
            </span>
            <button
              type="button"
              class="diff-review-send"
              [disabled]="draftCount() === 0 || sendBusy() || pendingSendConfirm()"
              (click)="sendReview()"
            >
              {{ sendBusy() ? 'Sending…' : 'Send review (' + draftCount() + ')' }}
            </button>
          </div>
          @if (pendingSendConfirm()) {
            <div class="diff-review-confirm" role="alertdialog" aria-label="Stale comments in draft">
              <span>
                {{ staleDraftAnnotations().length }} stale comment{{ staleDraftAnnotations().length === 1 ? '' : 's' }}
                will be sent with {{ staleDraftAnnotations().length === 1 ? 'its' : 'their' }} originally captured context.
              </span>
              <div class="diff-review-confirm-actions">
                <button type="button" class="diff-review-confirm-remove" (click)="removeStaleFirst()">Remove stale first</button>
                <button
                  type="button"
                  class="diff-review-confirm-send"
                  [disabled]="sendBusy()"
                  (click)="confirmSendAnyway()"
                >Send anyway</button>
              </div>
            </div>
          }
          @if (sendError(); as err) {
            <div class="diff-review-error" role="alert">{{ err }}</div>
          }
        }

        <div class="diff-hunks">
          @for (hunk of hunkGroups(); track $index; let hunkIndex = $index) {
            <div class="diff-hunk">
              <div class="diff-hunk-header">{{ hunk.header.text }}</div>
              <div class="diff-hunk-body">
                @for (line of hunk.body; track $index; let lineIndex = $index) {
                  @if (line.kind === 'meta') {
                    <div class="diff-line diff-line-meta">{{ line.text }}</div>
                  } @else {
                    <div
                      class="diff-row diff-line-{{ line.kind }}"
                      [class.selected]="isSelected(hunkIndex, lineIndex)"
                      role="button"
                      [attr.tabindex]="isTabbable(hunkIndex, lineIndex) ? 0 : -1"
                      [attr.aria-pressed]="isSelected(hunkIndex, lineIndex)"
                      [attr.aria-label]="rowAriaLabel(line)"
                      (click)="onRowClick($event, hunkIndex, lineIndex, line)"
                      (keydown)="onRowKeydown($event, hunkIndex, lineIndex, line)"
                      (focus)="focusedRowKey.set(rowKeyOf(hunkIndex, lineIndex))"
                    >
                      <span class="diff-gutter diff-gutter-old">{{ line.oldLineNumber ?? '' }}</span>
                      <span class="diff-gutter diff-gutter-new">{{ line.newLineNumber ?? '' }}</span>
                      <span class="diff-line-text">{{ line.text }}</span>
                      @if (annotationsStartingAt(line); as starting) {
                        @if (starting.length > 0) {
                          <button
                            type="button"
                            class="diff-anno-marker"
                            [title]="starting.length + ' comment(s): ' + starting[0].comment"
                            (click)="toggleExpanded($event, starting[0].id)"
                          >💬 {{ starting.length }}</button>
                        }
                      }
                    </div>
                    @for (anno of annotationsStartingAt(line); track anno.id) {
                      @if (expandedAnnotationId() === anno.id) {
                        <div class="diff-anno-card" [class.stale]="anno.state === 'stale'">
                          <div class="diff-anno-card-header">
                            <span class="diff-anno-state diff-anno-state-{{ anno.state }}">{{ anno.state }}</span>
                            <span class="diff-anno-range">{{ anno.side }} {{ formatRange(anno.lineRange) }}</span>
                            <button type="button" class="diff-anno-remove" (click)="removeAnnotation(anno.id)">Remove</button>
                          </div>
                          <div class="diff-anno-comment">{{ anno.comment }}</div>
                        </div>
                      }
                    }
                  }
                }
              </div>
            </div>
          }
        </div>

        @if (pendingEditor(); as editor) {
          <div class="diff-anno-editor" role="dialog" aria-label="Add review comment">
            <div class="diff-anno-editor-meta">
              Comment on <strong>{{ editor.side }}</strong> lines {{ formatRange(editor.lineRange) }}
            </div>
            <pre class="diff-anno-editor-excerpt">{{ editor.excerpt }}</pre>
            <textarea
              #commentTextarea
              class="diff-anno-editor-textarea"
              placeholder="What should change here?"
              [value]="editor.commentDraft"
              (input)="onEditorInput($event)"
              (keydown.escape)="cancelAnnotation()"
            ></textarea>
            <div class="diff-anno-editor-actions">
              <button type="button" class="diff-anno-editor-cancel" (click)="cancelAnnotation()">Cancel</button>
              <button
                type="button"
                class="diff-anno-editor-save"
                [disabled]="!editor.commentDraft.trim()"
                (click)="saveAnnotation()"
              >Add comment</button>
            </div>
          </div>
        }
      }
    } @else {
      <div class="diff-empty">No diff available for this file.</div>
    }
  `,
  styleUrl: './source-control-diff-view.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SourceControlDiffViewComponent {
  private readonly instanceStore = inject(InstanceStore);
  private readonly draftStore = inject(DiffReviewDraftStore);

  loader = input.required<DiffLoader>();

  /** Flat rendered lines grouped into per-hunk blocks for visual separation. */
  protected readonly hunkGroups = computed(() => groupHunks(this.loader().renderedLines()));

  /** Every selectable (non-header/meta) row, flattened for hit-testing/keyboard nav. */
  protected readonly selectableRows = computed<SelectableRow[]>(() => {
    const rows: SelectableRow[] = [];
    this.hunkGroups().forEach((hunk, hunkIndex) => {
      hunk.body.forEach((line, lineIndex) => {
        const side = sideOf(line);
        const lineNumber = side ? lineNumberOf(line, side) : null;
        if (!side || lineNumber == null) return;
        rows.push({ hunkIndex, lineIndex, side, lineNumber, text: line.text });
      });
    });
    return rows;
  });

  protected readonly selectedKeys = signal(new Set<string>());
  protected readonly selectionAnchor = signal<SelectionAnchor | null>(null);
  protected readonly focusedRowKey = signal<string | null>(null);
  protected readonly pendingEditor = signal<PendingEditor | null>(null);
  protected readonly expandedAnnotationId = signal<string | null>(null);
  protected readonly sendBusy = signal(false);
  protected readonly sendError = signal<string | null>(null);
  /** WS-C4 fresh-eyes fix: true once the user has clicked "Send review" while
   * the draft contains at least one stale annotation — gates the inline
   * confirm banner instead of sending immediately. */
  protected readonly pendingSendConfirm = signal(false);

  protected readonly commentTextareaRef = viewChild<ElementRef<HTMLTextAreaElement>>('commentTextarea');

  protected readonly currentFilePath = computed(() => this.loader().file()?.path ?? null);

  protected readonly currentAnnotations = computed<DiffAnnotation[]>(() => {
    const instanceId = this.instanceStore.selectedInstanceId();
    const path = this.currentFilePath();
    if (!instanceId || !path) return [];
    return this.draftStore.annotationsForFile(instanceId, path);
  });

  protected readonly draftCount = computed(() => {
    const instanceId = this.instanceStore.selectedInstanceId();
    return instanceId ? this.draftStore.annotationsFor(instanceId).length : 0;
  });

  /** Every draft annotation for this instance (any file) currently `stale`. */
  protected readonly staleDraftAnnotations = computed<DiffAnnotation[]>(() => {
    const instanceId = this.instanceStore.selectedInstanceId();
    if (!instanceId) return [];
    return this.draftStore.annotationsFor(instanceId).filter((a) => a.state === 'stale');
  });

  constructor() {
    // WS-C4 re-anchoring: whenever this file's rendered lines change (fresh
    // load, or a reload after the underlying diff changed), re-verify every
    // draft annotation for this (instance, path) against the new content.
    effect(() => {
      const instanceId = this.instanceStore.selectedInstanceId();
      const path = this.currentFilePath();
      const rows = this.selectableRows();
      if (!instanceId || !path) return;

      const oldLines = rows
        .filter((r) => r.side === 'old')
        .map((r) => ({ lineNumber: r.lineNumber, text: r.text }));
      const newLines = rows
        .filter((r) => r.side === 'new')
        .map((r) => ({ lineNumber: r.lineNumber, text: r.text }));

      this.draftStore.reconcile(instanceId, path, 'old', oldLines);
      this.draftStore.reconcile(instanceId, path, 'new', newLines);
    });

    // WS-C4 minor polish: autofocus the comment editor textarea as soon as
    // it renders, so a keyboard user can start typing immediately.
    effect(() => {
      if (this.pendingEditor()) {
        this.commentTextareaRef()?.nativeElement.focus();
      }
    });
  }

  protected rowKeyOf(hunkIndex: number, lineIndex: number): string {
    return rowKey(hunkIndex, lineIndex);
  }

  protected isSelected(hunkIndex: number, lineIndex: number): boolean {
    return this.selectedKeys().has(rowKey(hunkIndex, lineIndex));
  }

  protected isTabbable(hunkIndex: number, lineIndex: number): boolean {
    const focused = this.focusedRowKey();
    const key = rowKey(hunkIndex, lineIndex);
    if (focused) return focused === key;
    const first = this.selectableRows()[0];
    return !!first && rowKey(first.hunkIndex, first.lineIndex) === key;
  }

  protected rowAriaLabel(line: RenderedDiffLine): string {
    const side = sideOf(line);
    const lineNumber = side ? lineNumberOf(line, side) : null;
    const kindLabel = line.kind === 'add' ? 'added' : line.kind === 'remove' ? 'removed' : 'unchanged';
    return `${kindLabel} line ${lineNumber ?? ''}: ${line.text}`;
  }

  protected annotationsStartingAt(line: RenderedDiffLine): DiffAnnotation[] {
    const side = sideOf(line);
    const lineNumber = side ? lineNumberOf(line, side) : null;
    if (!side || lineNumber == null) return [];
    return this.currentAnnotations().filter((a) => a.side === side && a.lineRange.start === lineNumber);
  }

  protected toggleExpanded(event: Event, annotationId: string): void {
    event.stopPropagation();
    this.expandedAnnotationId.set(this.expandedAnnotationId() === annotationId ? null : annotationId);
  }

  protected removeAnnotation(annotationId: string): void {
    const instanceId = this.instanceStore.selectedInstanceId();
    if (!instanceId) return;
    this.draftStore.remove(instanceId, annotationId);
    if (this.expandedAnnotationId() === annotationId) this.expandedAnnotationId.set(null);
  }

  protected formatRange(range: DiffAnnotationLineRange): string {
    return range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`;
  }

  // ---------------------------------------------------------------------
  // Selection — click / shift-click, keyboard focus + shift-arrow, Enter.
  // ---------------------------------------------------------------------

  protected onRowClick(event: MouseEvent, hunkIndex: number, lineIndex: number, line: RenderedDiffLine): void {
    const side = sideOf(line);
    if (!side) return;
    const key = rowKey(hunkIndex, lineIndex);
    this.focusedRowKey.set(key);

    const anchor = this.selectionAnchor();
    if (event.shiftKey && anchor && anchor.hunkIndex === hunkIndex && anchor.side === side) {
      this.extendSelectionTo(hunkIndex, side, lineIndex);
      return;
    }

    this.selectionAnchor.set({ hunkIndex, side, lineIndex });
    this.selectedKeys.set(new Set([key]));
  }

  protected onRowKeydown(event: KeyboardEvent, hunkIndex: number, lineIndex: number, line: RenderedDiffLine): void {
    const side = sideOf(line);
    if (!side) return;

    if (event.key === 'Enter') {
      event.preventDefault();
      if (!this.selectedKeys().has(rowKey(hunkIndex, lineIndex))) {
        this.selectionAnchor.set({ hunkIndex, side, lineIndex });
        this.selectedKeys.set(new Set([rowKey(hunkIndex, lineIndex)]));
      }
      this.openEditorForCurrentSelection();
      return;
    }

    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();

    const flat = this.selectableRows();
    const currentFlatIndex = flat.findIndex((r) => r.hunkIndex === hunkIndex && r.lineIndex === lineIndex);
    if (currentFlatIndex === -1) return;
    const nextFlatIndex = currentFlatIndex + (event.key === 'ArrowDown' ? 1 : -1);
    if (nextFlatIndex < 0 || nextFlatIndex >= flat.length) return;
    const next = flat[nextFlatIndex];
    const nextKey = rowKey(next.hunkIndex, next.lineIndex);

    if (event.shiftKey) {
      let anchor = this.selectionAnchor();
      if (!anchor) {
        anchor = { hunkIndex, side, lineIndex };
        this.selectionAnchor.set(anchor);
        this.selectedKeys.set(new Set([rowKey(hunkIndex, lineIndex)]));
      }
      if (next.hunkIndex !== anchor.hunkIndex || next.side !== anchor.side) return; // boundary reached
      this.focusedRowKey.set(nextKey);
      this.extendSelectionTo(next.hunkIndex, next.side, next.lineIndex);
      return;
    }

    this.focusedRowKey.set(nextKey);
    this.selectionAnchor.set({ hunkIndex: next.hunkIndex, side: next.side, lineIndex: next.lineIndex });
    this.selectedKeys.set(new Set([nextKey]));
  }

  private rowsInHunkBySide(hunkIndex: number, side: DiffAnnotationSide): SelectableRow[] {
    return this.selectableRows().filter((r) => r.hunkIndex === hunkIndex && r.side === side);
  }

  private extendSelectionTo(hunkIndex: number, side: DiffAnnotationSide, lineIndex: number): void {
    const anchor = this.selectionAnchor();
    if (!anchor) return;
    const rows = this.rowsInHunkBySide(hunkIndex, side);
    const anchorPos = rows.findIndex((r) => r.lineIndex === anchor.lineIndex);
    const targetPos = rows.findIndex((r) => r.lineIndex === lineIndex);
    if (anchorPos === -1 || targetPos === -1) return;
    const [lo, hi] = anchorPos <= targetPos ? [anchorPos, targetPos] : [targetPos, anchorPos];
    const keys = new Set<string>();
    for (let i = lo; i <= hi; i++) {
      keys.add(rowKey(hunkIndex, rows[i].lineIndex));
    }
    this.selectedKeys.set(keys);
  }

  // ---------------------------------------------------------------------
  // Comment editor
  // ---------------------------------------------------------------------

  protected openEditorForCurrentSelection(): void {
    const anchor = this.selectionAnchor();
    const path = this.currentFilePath();
    if (!anchor || !path) return;
    const keys = this.selectedKeys();
    const rows = this.rowsInHunkBySide(anchor.hunkIndex, anchor.side)
      .filter((r) => keys.has(rowKey(anchor.hunkIndex, r.lineIndex)))
      .sort((a, b) => a.lineIndex - b.lineIndex);
    if (rows.length === 0) return;

    const lineNumbers = rows.map((r) => r.lineNumber).sort((a, b) => a - b);
    this.pendingEditor.set({
      path,
      side: anchor.side,
      lineRange: { start: lineNumbers[0], end: lineNumbers[lineNumbers.length - 1] },
      excerpt: rows.map((r) => r.text).join('\n'),
      commentDraft: '',
    });
  }

  protected onEditorInput(event: Event): void {
    const value = (event.target as HTMLTextAreaElement).value;
    const editor = this.pendingEditor();
    if (!editor) return;
    this.pendingEditor.set({ ...editor, commentDraft: value });
  }

  protected saveAnnotation(): void {
    const editor = this.pendingEditor();
    const instanceId = this.instanceStore.selectedInstanceId();
    const comment = editor?.commentDraft.trim();
    if (!editor || !instanceId || !comment) return;

    this.draftStore.add(instanceId, {
      path: editor.path,
      side: editor.side,
      lineRange: editor.lineRange,
      excerpt: editor.excerpt,
      comment,
    });
    this.pendingEditor.set(null);
    this.selectedKeys.set(new Set());
    this.selectionAnchor.set(null);
  }

  protected cancelAnnotation(): void {
    this.pendingEditor.set(null);
  }

  // ---------------------------------------------------------------------
  // Send review — one structured packet through the existing send path.
  //
  // WS-C4 fresh-eyes fix: sending a draft that contains a stale annotation
  // is a silent honesty problem (the packet would tell the agent to act on
  // possibly-gone lines without saying so). `sendReview()` now stops and
  // shows an inline confirm banner the first time it finds a stale
  // annotation; the user either removes the stale ones or explicitly sends
  // anyway. The main "Send review" button is disabled while the banner is
  // showing so only its two actions can proceed.
  // ---------------------------------------------------------------------

  protected async sendReview(): Promise<void> {
    const instanceId = this.instanceStore.selectedInstanceId();
    if (!instanceId) return;
    const annotations = this.draftStore.annotationsFor(instanceId);
    if (annotations.length === 0) return;

    if (this.staleDraftAnnotations().length > 0) {
      this.pendingSendConfirm.set(true);
      return;
    }

    await this.dispatchReview(instanceId, annotations);
  }

  /** "Send anyway" — bypasses the stale check the user already confirmed. */
  protected async confirmSendAnyway(): Promise<void> {
    const instanceId = this.instanceStore.selectedInstanceId();
    if (!instanceId) return;
    const annotations = this.draftStore.annotationsFor(instanceId);
    if (annotations.length === 0) {
      this.pendingSendConfirm.set(false);
      return;
    }
    await this.dispatchReview(instanceId, annotations);
  }

  /** "Remove stale first" — drops only the stale annotations, keeps the rest of the draft. */
  protected removeStaleFirst(): void {
    const instanceId = this.instanceStore.selectedInstanceId();
    if (!instanceId) return;
    for (const annotation of this.staleDraftAnnotations()) {
      this.draftStore.remove(instanceId, annotation.id);
    }
    this.pendingSendConfirm.set(false);
  }

  private async dispatchReview(instanceId: string, annotations: DiffAnnotation[]): Promise<void> {
    const packet = buildReviewPacket(annotations);
    this.sendBusy.set(true);
    this.sendError.set(null);
    try {
      await this.instanceStore.sendInput(instanceId, packet);
      this.draftStore.clear(instanceId);
      this.pendingSendConfirm.set(false);
    } catch (err) {
      // Draft is intentionally left untouched on failure — nothing was
      // confirmed sent, so nothing should be discarded.
      this.sendError.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.sendBusy.set(false);
    }
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for tests.
// ---------------------------------------------------------------------------

/** Which annotation side a rendered line belongs to (null for header/meta). */
export function sideOf(line: RenderedDiffLine): DiffAnnotationSide | null {
  if (line.kind === 'remove') return 'old';
  if (line.kind === 'add' || line.kind === 'context') return 'new';
  return null;
}

/** The line number on `side` for `line` (null if not applicable). */
export function lineNumberOf(line: RenderedDiffLine, side: DiffAnnotationSide): number | null {
  return (side === 'old' ? line.oldLineNumber : line.newLineNumber) ?? null;
}
