import { AfterViewChecked, ChangeDetectionStrategy, ChangeDetectorRef, Component, ElementRef, inject, OnDestroy, viewChild } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { ConfirmService, type ConfirmOptions } from './confirm.service';
import { createFocusTrap, type FocusTrapHandle } from '../utils/focus-trap';

@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (service.pending(); as request) {
      <div class="confirm-overlay" (pointerdown)="onBackdropPointerDown($event)">
        <section #dialog class="confirm-dialog" role="dialog" aria-modal="true"
          aria-labelledby="harness-confirm-title" aria-describedby="harness-confirm-message">
          <h2 id="harness-confirm-title">{{ request.title }}</h2>
          <p id="harness-confirm-message">{{ request.message }}</p>
          <div class="confirm-actions">
            <button #cancel type="button" data-cancel (click)="service.resolve(false)">{{ request.cancelLabel }}</button>
            <button #action type="button" data-confirm [class.danger]="request.danger" (click)="service.resolve(true)">
              {{ request.confirmLabel }}
            </button>
          </div>
        </section>
      </div>
    }
  `,
  styles: [`
    .confirm-overlay { position: fixed; inset: 0; z-index: 1200; background: rgba(0, 0, 0, .6);
      display: flex; align-items: center; justify-content: center; -webkit-app-region: no-drag; }
    .confirm-dialog { width: 460px; max-width: calc(100vw - 32px); max-height: calc(100vh - 32px); overflow: auto;
      box-sizing: border-box; padding: 20px; border-radius: var(--radius-md, 10px); border: 1px solid var(--border-color);
      background: var(--bg-secondary); color: var(--text-primary); box-shadow: 0 16px 48px rgba(0, 0, 0, .5); }
    h2 { margin: 0 0 12px; font-size: 16px; }
    p { margin: 0 0 20px; font-size: 13px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
    .confirm-actions { display: flex; justify-content: flex-end; gap: 8px; }
    button { padding: 8px 16px; border-radius: var(--radius-sm, 6px); border: 1px solid var(--border-color);
      background: var(--bg-tertiary); color: var(--text-primary); font: inherit; cursor: pointer; }
    [data-confirm] { background: var(--primary-color); color: var(--bg-primary); }
    .danger { background: var(--error-color); color: white; }
    button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 3px; }
  `],
})
export class ConfirmDialogComponent implements AfterViewChecked, OnDestroy {
  protected readonly service = inject(ConfirmService);
  private readonly document = inject(DOCUMENT);
  private readonly changeDetector = inject(ChangeDetectorRef);
  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');
  private readonly cancel = viewChild<ElementRef<HTMLButtonElement>>('cancel');
  private readonly action = viewChild<ElementRef<HTMLButtonElement>>('action');
  private trap: FocusTrapHandle | null = null;
  private shownRequest: ConfirmOptions | null = null;

  ngAfterViewChecked(): void {
    const request = this.service.pending();
    if (request === this.shownRequest) return;
    this.closeTrap();
    this.shownRequest = request;
    const dialog = this.dialog()?.nativeElement;
    if (!request || !dialog) return;
    this.trap = createFocusTrap(dialog, {
      initialFocus: (request.danger ? this.cancel() : this.action())?.nativeElement,
    });
    this.trap.activate();
    this.document.addEventListener('keydown', this.onDocumentKeydown, true);
  }

  protected onBackdropPointerDown(event: PointerEvent): void {
    if (event.target === event.currentTarget) event.preventDefault();
  }

  private readonly onDocumentKeydown = (event: KeyboardEvent): void => {
    this.onKeydown(event);
    this.changeDetector.markForCheck();
  };

  protected onKeydown(event: KeyboardEvent): void {
    if (!this.service.pending()) return;
    // Keep application shortcuts inside the modal; Tab still reaches the focus trap.
    if (event.key !== 'Tab') event.stopImmediatePropagation();
    if (event.key === 'Escape' || event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (event.key === 'Escape') {
        this.service.resolve(false);
        return;
      }
      // Enter follows the focused button's meaning: Cancel cancels. Only when
      // focus is not on a button does Enter act as the dialog's confirm
      // shortcut, and never on a danger box (Enter does not confirm those).
      const target = event.target instanceof Element ? event.target : null;
      const danger = this.service.pending()?.danger === true;
      if (target?.closest('button[data-cancel]')) {
        this.service.resolve(false);
        return;
      }
      if (!danger && (target?.closest('button[data-confirm]') || !target?.closest('button'))) {
        this.service.resolve(true);
      }
    }
  }

  ngOnDestroy(): void {
    this.closeTrap();
    this.service.cancelAll();
  }

  private closeTrap(): void {
    this.document.removeEventListener('keydown', this.onDocumentKeydown, true);
    this.trap?.deactivate();
    this.trap?.restore();
    this.trap = null;
  }
}
