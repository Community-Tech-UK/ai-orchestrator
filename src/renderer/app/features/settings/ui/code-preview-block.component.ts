import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { AioTooltipDirective } from '../../../shared/tooltip/aio-tooltip.directive';

@Component({
  selector: 'app-code-preview-block',
  standalone: true,
  imports: [AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="code-preview-block">
      <div class="code-preview-header">
        <span>{{ label() }}</span>
        <button type="button" class="copy-button" [appTooltipDisabledReason]="!code() ? 'There is no code to copy yet.' : null" (click)="copyRequested.emit(code())">
          Copy
        </button>
      </div>
      <pre>{{ code() }}</pre>
    </div>
  `,
  styleUrl: './code-preview-block.component.scss',
})
export class CodePreviewBlockComponent {
  readonly label = input('Preview');
  readonly code = input('');
  readonly copyRequested = output<string>();
}
