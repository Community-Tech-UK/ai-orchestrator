import { ChangeDetectionStrategy, Component, input } from '@angular/core';

export type ValidationRowStatus = 'pass' | 'warn' | 'fail' | 'info';

@Component({
  selector: 'app-validation-row',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="validation-row" [attr.data-status]="status()">
      <span class="status-dot" aria-hidden="true"></span>
      <div class="validation-copy">
        <span class="validation-label">{{ label() }}</span>
        @if (detail()) {
          <span class="validation-detail">{{ detail() }}</span>
        }
      </div>
    </div>
  `,
  styleUrl: './validation-row.component.scss',
})
export class ValidationRowComponent {
  readonly status = input<ValidationRowStatus>('info');
  readonly label = input('');
  readonly detail = input('');
}
