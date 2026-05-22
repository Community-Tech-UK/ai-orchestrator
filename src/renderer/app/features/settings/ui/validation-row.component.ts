import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

export type ValidationRowStatus = 'pass' | 'warn' | 'fail' | 'info';

@Component({
  selector: 'app-validation-row',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="validation-row" [attr.data-status]="status">
      <span class="status-dot" aria-hidden="true"></span>
      <div class="validation-copy">
        <span class="validation-label">{{ label }}</span>
        @if (detail) {
          <span class="validation-detail">{{ detail }}</span>
        }
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .validation-row {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-sm);
        padding: var(--density-card-padding);
        border: 1px solid var(--pill-info-border);
        border-radius: var(--radius-md);
        background: var(--pill-info-bg);
      }

      .status-dot {
        width: 9px;
        height: 9px;
        margin-top: 4px;
        border-radius: var(--radius-full);
        background: var(--pill-info-fg);
        flex-shrink: 0;
      }

      .validation-copy {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }

      .validation-label {
        font-size: var(--text-sm);
        font-weight: 700;
        color: var(--text-primary);
      }

      .validation-detail {
        font-size: var(--text-sm);
        color: var(--text-secondary);
        line-height: var(--leading-snug);
      }

      .validation-row[data-status='pass'] {
        border-color: var(--pill-ok-border);
        background: var(--pill-ok-bg);
      }

      .validation-row[data-status='pass'] .status-dot {
        background: var(--pill-ok-fg);
      }

      .validation-row[data-status='warn'] {
        border-color: var(--pill-warn-border);
        background: var(--pill-warn-bg);
      }

      .validation-row[data-status='warn'] .status-dot {
        background: var(--pill-warn-fg);
      }

      .validation-row[data-status='fail'] {
        border-color: var(--pill-error-border);
        background: var(--pill-error-bg);
      }

      .validation-row[data-status='fail'] .status-dot {
        background: var(--pill-error-fg);
      }
    `,
  ],
})
export class ValidationRowComponent {
  @Input() status: ValidationRowStatus = 'info';
  @Input() label = '';
  @Input() detail = '';
}
