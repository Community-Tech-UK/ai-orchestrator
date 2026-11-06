import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { AioTooltipDirective } from '../../../shared/tooltip/aio-tooltip.directive';

@Component({
  selector: 'app-copy-row',
  standalone: true,
  imports: [AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="copy-row">
      <span class="copy-label">{{ label() }}</span>
      <div class="copy-control">
        <input
          type="text"
          class="copy-input"
          [class.mono]="mono()"
          [value]="value()"
          readonly
        />
        <button
          type="button"
          class="copy-button"
          [appTooltipDisabledReason]="!value() ? 'There is nothing to copy yet.' : null"
          (click)="copyRequested.emit(value())"
        >
          Copy
        </button>
      </div>
    </div>
  `,
  styleUrl: './copy-row.component.scss',
})
export class CopyRowComponent {
  readonly label = input('');
  readonly value = input('');
  readonly mono = input(true);
  readonly copyRequested = output<string>();
}
