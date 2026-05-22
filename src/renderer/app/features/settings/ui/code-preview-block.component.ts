import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'app-code-preview-block',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="code-preview-block">
      <div class="code-preview-header">
        <span>{{ label }}</span>
        <button type="button" class="copy-button" [disabled]="!code" (click)="copyRequested.emit(code)">
          Copy
        </button>
      </div>
      <pre>{{ code }}</pre>
    </div>
  `,
  styleUrl: './code-preview-block.component.scss',
})
export class CodePreviewBlockComponent {
  @Input() label = 'Preview';
  @Input() code = '';
  @Output() readonly copyRequested = new EventEmitter<string>();
}
