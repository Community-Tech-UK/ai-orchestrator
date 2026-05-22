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
  styles: [
    `
      :host {
        display: block;
      }

      .copy-row {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .copy-label {
        font-size: var(--text-sm);
        font-weight: 600;
        color: var(--text-secondary);
      }

      .copy-control {
        display: flex;
        gap: var(--spacing-sm);
      }

      .copy-input {
        flex: 1;
        min-width: 0;
        padding: var(--spacing-sm);
        background: var(--surface-sunken-bg);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        font-size: var(--text-sm);
      }

      .copy-input.mono {
        font-family: var(--font-mono);
      }

      .copy-button {
        flex: 0 0 auto;
        padding: var(--spacing-sm) var(--spacing-md);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        font-size: var(--text-sm);
        font-weight: 700;
        cursor: pointer;
      }

      .copy-button:hover:not(:disabled) {
        background: var(--bg-hover);
      }

      .copy-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `,
  ],
})
export class CopyRowComponent {
  @Input() label = '';
  @Input() value = '';
  @Input() mono = true;
  @Output() readonly copyRequested = new EventEmitter<string>();
}
