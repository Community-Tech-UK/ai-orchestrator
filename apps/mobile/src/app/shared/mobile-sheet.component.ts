import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export function mobileSheetDismissLabel(label: string): string {
  return `Close ${label}`;
}

@Component({
  standalone: true,
  selector: 'app-mobile-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'mobile-sheet-host' },
  template: `
    <button
      type="button"
      class="mobile-sheet__scrim"
      [attr.aria-label]="dismissLabel()"
      (click)="dismiss.emit()"
    ></button>
    <section class="mobile-sheet" role="dialog" aria-modal="true" [attr.aria-label]="label()">
      <div class="mobile-sheet__grabber" aria-hidden="true"></div>
      <ng-content />
    </section>
  `,
  styles: [
    `
      :host {
        position: fixed;
        inset: 0;
        z-index: var(--z-modal, 50);
        display: block;
      }

      .mobile-sheet__scrim {
        position: absolute;
        inset: 0;
        width: 100%;
        border: 0;
        background: rgba(0, 0, 0, 0.56);
      }

      .mobile-sheet {
        position: absolute;
        right: 0;
        bottom: 0;
        left: 0;
        max-height: min(78dvh, 720px);
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

      .mobile-sheet__grabber {
        width: 36px;
        height: 5px;
        border-radius: var(--radius-pill);
        background: rgba(255, 255, 255, 0.22);
        margin: 0 auto var(--space-4, 16px);
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
  readonly label = input.required<string>();
  readonly dismiss = output<void>();
  protected dismissLabel(): string {
    return mobileSheetDismissLabel(this.label());
  }
}
