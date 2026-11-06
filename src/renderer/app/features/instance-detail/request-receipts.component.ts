import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { RequestReceipt } from './user-input-request.receipts';

export type { RequestReceipt } from './user-input-request.receipts';

/** The grey lines that say what happened to a question or approval after its card closed. */
@Component({
  selector: 'app-request-receipts',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="receipts" aria-live="polite">
      @for (receipt of receipts(); track receipt.id) {
        <div class="receipt">
          <span class="receipt-text">{{ receipt.text }}</span>
          @if (receipt.subject) {
            <span class="receipt-subject">({{ receipt.subject }})</span>
          }
          <button
            type="button"
            class="receipt-dismiss"
            [attr.aria-label]="'Dismiss: ' + receipt.text"
            (click)="dismissed.emit(receipt.id)"
          >
            Dismiss
          </button>
        </div>
      }
    </div>
  `,
  styles: `
    .receipts {
      color: var(--text-muted);
      font-size: 12px;
      padding: 0 var(--spacing-md);
    }
    .receipt {
      display: flex;
      align-items: baseline;
      gap: var(--spacing-sm);
      margin: var(--spacing-sm) 0;
    }
    .receipt-subject {
      color: var(--text-secondary);
    }
    .receipt-dismiss {
      background: transparent;
      border: 0;
      color: var(--text-secondary);
      cursor: pointer;
      font: inherit;
      text-decoration: underline;
    }
  `,
})
export class RequestReceiptsComponent {
  receipts = input.required<readonly RequestReceipt[]>();
  dismissed = output<string>();
}
