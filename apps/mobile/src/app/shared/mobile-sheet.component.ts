import { afterRenderEffect, ChangeDetectionStrategy, Component, DestroyRef, ElementRef, inject, input, output } from '@angular/core';
import { AppLockService } from '../core/app-lock.service';

export function mobileSheetDismissLabel(label: string): string {
  return `Close ${label}`;
}

@Component({
  standalone: true,
  selector: 'app-mobile-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mobile-sheet-host' },
  template: `
    <dialog class="mobile-sheet__dialog" [attr.aria-label]="label()" tabindex="-1"
      (cancel)="cancel($event)" (keydown)="keydown($event)" (click)="backdrop($event)">
      <section class="mobile-sheet">
        <header class="mobile-sheet__header">
          <h2>{{ label() }}</h2>
          <button type="button" class="mobile-sheet__close" autofocus
            [disabled]="!dismissible()" [attr.aria-label]="dismissLabel()"
            (click)="requestDismiss()">{{ closeLabel() }}</button>
        </header>
        <ng-content />
      </section>
    </dialog>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .mobile-sheet__dialog {
        position: fixed;
        inset: 0;
        width: 100%;
        height: 100%;
        max-width: none;
        max-height: none;
        margin: 0;
        padding: 0;
        border: 0;
        background: transparent;
        overflow: hidden;
      }

      .mobile-sheet__dialog::backdrop {
        background: rgba(0, 0, 0, 0.56);
      }

      .mobile-sheet {
        position: absolute;
        right: 0;
        bottom: 0;
        left: 0;
        max-height: calc(100dvh - env(safe-area-inset-top) - 16px);
        overflow-y: auto;
        border: 1px solid var(--separator, rgba(255, 255, 255, 0.1));
        border-bottom: 0;
        border-radius: var(--radius-sheet, 24px) var(--radius-sheet, 24px) 0 0;
        background: var(--surface-raised, #1c1c1e);
        color: var(--text);
        padding: var(--space-2, 8px) var(--mobile-gutter, 20px)
          calc(var(--space-5, 20px) + env(safe-area-inset-bottom));
        animation: mobile-sheet-in var(--motion-enter, 220ms) cubic-bezier(0.22, 1, 0.36, 1);
        overscroll-behavior: contain;
      }

      .mobile-sheet__header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3, 12px);
        margin-bottom: var(--space-3, 12px);
      }

      .mobile-sheet__header h2 { min-width: 0; overflow-wrap: anywhere; }

      .mobile-sheet__close {
        min-width: 44px;
        min-height: 44px;
        flex: none;
        border: 0;
        border-radius: 12px;
        padding: 8px 12px;
        background: var(--surface-2);
        color: var(--text);
        font: inherit;
      }

      @keyframes mobile-sheet-in {
        from {
          transform: translateY(18px);
          opacity: 0;
        }
      }
    `,
  ],
})
export class MobileSheetComponent {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly appLock = inject(AppLockService);
  readonly label = input.required<string>();
  readonly closeLabel = input('Close');
  readonly dismissible = input(true);
  readonly returnFocusTo = input<HTMLElement | null>(null);
  readonly dismiss = output<void>();
  private opener: HTMLElement | null = null;

  constructor() {
    // The native modal supplies focus entry/containment/return and makes the
    // background inert, including sheets underneath it. Yield its top layer
    // when biometrics lock the app, so it can never cover the lock screen.
    afterRenderEffect(() => {
      const dialog = this.element.nativeElement.querySelector('dialog');
      if (!dialog) return;
      if (this.appLock.locked()) {
        if (dialog.open) dialog.close();
      } else if (!dialog.open) {
        this.opener ??= this.returnFocusTo() ??
          (document.activeElement instanceof HTMLElement ? document.activeElement : null);
        dialog.showModal();
      }
    });
    inject(DestroyRef).onDestroy(() => {
      this.element.nativeElement.querySelector('dialog')?.close();
      if (!this.appLock.locked() && this.opener?.isConnected) this.opener.focus({ preventScroll: true });
    });
  }

  protected requestDismiss(): void {
    if (this.dismissible()) this.dismiss.emit();
  }

  protected cancel(event: Event): void {
    event.preventDefault();
    this.requestDismiss();
  }

  protected keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') { this.cancel(event); return; }
    if (event.key !== 'Tab') return;
    const dialog = event.currentTarget as HTMLDialogElement;
    const controls = [...dialog.querySelectorAll<HTMLElement>(
      'button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
      event.preventDefault(); first.focus();
    }
  }

  protected backdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.requestDismiss();
  }

  protected dismissLabel(): string {
    return mobileSheetDismissLabel(this.label());
  }
}
