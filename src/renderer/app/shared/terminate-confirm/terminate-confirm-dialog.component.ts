/**
 * Decision 16(b) — the terminate confirmation, mounted once at app level.
 *
 * See `terminate-confirm.store.ts` for why this is not local to the instance
 * list.
 *
 * **Escape works two ways, and both of them actually fire.** The original
 * version had `(keydown.escape)` on the overlay and nothing else; that binding
 * never ran, because nothing focused the overlay, so Escape did nothing at all.
 * The fix was a `document` listener, which fires regardless of focus. Keeping
 * only that would leave the backdrop's click-to-dismiss with no keyboard
 * equivalent on the element itself — so the dialog now takes focus when it
 * opens, which a modal should do in any case (a modal that leaves focus behind
 * strands keyboard users and is not announced by a screen reader), and the
 * overlay binding is live rather than decorative.
 */
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  effect,
  inject,
  viewChild,
} from '@angular/core';

import { TerminateConfirmStore } from './terminate-confirm.store';

@Component({
  selector: 'app-terminate-confirm-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (confirmStore.pendingId()) {
      <div
        class="confirm-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby="terminate-confirm-title"
        (click)="onBackdropClick($event)"
        (keydown.escape)="confirmStore.cancel()"
      >
        <div #dialog class="confirm-dialog" tabindex="-1">
          <h3 id="terminate-confirm-title">Close {{ confirmStore.pendingName() }}?</h3>
          <p>
            This stops the agent and closes the session. Any work it has not
            written to disk is lost.
            @if (confirmStore.pendingIsArchived()) {
              The conversation is kept in history.
            }
          </p>
          <div class="confirm-actions">
            <button
              type="button"
              class="btn-cancel"
              (click)="confirmStore.cancel()"
            >Keep running</button>
            <button
              type="button"
              class="btn-confirm danger"
              (click)="confirmStore.confirm()"
            >Close session</button>
          </div>
        </div>
      </div>
    }
  `,
  styleUrl: './terminate-confirm-dialog.component.scss',
})
export class TerminateConfirmDialogComponent {
  protected readonly confirmStore = inject(TerminateConfirmStore);

  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');

  constructor() {
    // Focus follows the prompt, so Escape and Tab land where the user is being
    // asked a question rather than on whatever they were doing before.
    effect(() => {
      if (this.confirmStore.pendingId() === null) return;
      this.dialog()?.nativeElement.focus();
    });
  }

  /**
   * Dismiss only for a click on the backdrop itself. Comparing target to
   * currentTarget rather than putting a `stopPropagation` handler on the dialog:
   * that handler was not an affordance, it existed solely to cancel this one,
   * and a click listener on a non-interactive element is what the a11y rule is
   * there to catch.
   */
  protected onBackdropClick(event: MouseEvent): void {
    if (event.target !== event.currentTarget) return;
    this.confirmStore.cancel();
  }

  @HostListener('document:keydown', ['$event'])
  protected onDocumentKeyDown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    if (this.confirmStore.pendingId() === null) return;
    event.preventDefault();
    this.confirmStore.cancel();
  }
}
