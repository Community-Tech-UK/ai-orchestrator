import { AfterViewInit, ChangeDetectionStrategy, Component, ElementRef, OnDestroy, inject, input, output, viewChild } from '@angular/core';
import { DOCUMENT } from '@angular/common';

let nextDescriptionId = 0;

/**
 * The yes/no box for a change that would cost something real (Oct-2 T17): a large conversation left
 * behind by a new session, or re-read at full price. One component, so the model picker in the header,
 * the one in the composer and the auto-approve toggle all ask the same way.
 */
@Component({
  selector: 'app-runtime-change-confirm',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="runtime-confirm" role="alertdialog" aria-label="Confirm the change" [attr.aria-describedby]="descriptionId"
      (keydown.escape)="onEscape($event)" data-testid="runtime-change-confirm">
      <span class="runtime-confirm__text" [id]="descriptionId">{{ text() }}</span>
      <button type="button" class="runtime-confirm__yes" [attr.aria-describedby]="descriptionId" (click)="confirmed.emit()">{{ confirmLabel() }}</button>
      <button #cancelButton type="button" class="runtime-confirm__no" [attr.aria-describedby]="descriptionId" (click)="cancelled.emit()">{{ cancelLabel() }}</button>
    </div>
  `,
  styles: [`
    :host { display: block; flex-basis: 100%; }

    .runtime-confirm {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border: 1px solid var(--warning-color, #eab308);
      border-radius: 8px;
      font-size: 12px;
      color: var(--text-primary);
    }

    .runtime-confirm__text {
      flex: 1;
      min-width: 0;
    }

    .runtime-confirm button {
      padding: 2px 10px;
      border: 1px solid currentColor;
      border-radius: 6px;
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }
  `],
})
export class RuntimeChangeConfirmComponent implements AfterViewInit, OnDestroy {
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly cancelButton = viewChild.required<ElementRef<HTMLButtonElement>>('cancelButton');
  private restoreFocusTarget: HTMLElement | null = null;
  protected readonly descriptionId = `runtime-change-description-${++nextDescriptionId}`;
  /** The sentence that explains why the change is being held for a yes. */
  readonly text = input.required<string>();
  readonly confirmLabel = input('Switch anyway');
  readonly cancelLabel = input('Keep current');
  readonly confirmed = output<void>();
  readonly cancelled = output<void>();

  ngAfterViewInit(): void {
    const active = this.document.activeElement;
    this.restoreFocusTarget = active instanceof HTMLElement ? active : null;
    this.cancelButton().nativeElement.focus();
  }

  ngOnDestroy(): void {
    // This question is non-modal: leaving it for another control must keep that new focus.
    if (this.host.nativeElement.contains(this.document.activeElement) && this.restoreFocusTarget?.isConnected) {
      this.restoreFocusTarget.focus();
    }
  }

  protected onEscape(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.cancelled.emit();
  }
}
