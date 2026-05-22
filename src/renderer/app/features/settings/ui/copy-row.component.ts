import { ChangeDetectionStrategy, Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'app-copy-row',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="copy-row">
      <span class="copy-label">{{ label }}</span>
      <div class="copy-control">
        <input
          type="text"
          class="copy-input"
          [class.mono]="mono"
          [value]="value"
          readonly
        />
        <button
          type="button"
          class="copy-button"
          [disabled]="!value"
          (click)="copyRequested.emit(value)"
        >
          Copy
        </button>
      </div>
    </div>
  `,
  styleUrl: './copy-row.component.scss',
})
export class CopyRowComponent {
  @Input() label = '';
  @Input() value = '';
  @Input() mono = true;
  @Output() readonly copyRequested = new EventEmitter<string>();
}
