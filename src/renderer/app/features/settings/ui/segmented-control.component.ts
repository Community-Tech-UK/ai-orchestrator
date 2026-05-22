/**
 * Segmented Control - reusable single-select control for the settings UI kit
 * (copilot_todo.md item 4). Used for compact choices such as theme selection.
 */

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export interface SegmentOption {
  value: string;
  label: string;
  /** Optional supporting hint shown under the label. */
  hint?: string;
}

@Component({
  selector: 'app-segmented-control',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="segmented" role="radiogroup" [attr.aria-label]="ariaLabel() || null">
      @for (option of options(); track option.value) {
        <button
          type="button"
          class="segment"
          role="radio"
          [class.active]="option.value === value()"
          [attr.aria-checked]="option.value === value()"
          (click)="select(option.value)"
        >
          <span class="segment-label">{{ option.label }}</span>
          @if (option.hint) {
            <span class="segment-hint">{{ option.hint }}</span>
          }
        </button>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .segmented {
        display: flex;
        gap: 2px;
        padding: 3px;
        background: var(--segment-track-bg);
        border: 1px solid var(--segment-track-border);
        border-radius: var(--radius-md);
      }

      .segment {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1px;
        padding: var(--spacing-sm) var(--spacing-md);
        border: 1px solid transparent;
        border-radius: var(--radius-sm);
        background: transparent;
        color: var(--segment-fg);
        font-size: var(--text-base);
        font-weight: 500;
        cursor: pointer;
        transition:
          background var(--transition-fast),
          color var(--transition-fast);
      }

      .segment:hover:not(.active) {
        color: var(--segment-fg-active);
        background: var(--glass-light);
      }

      .segment.active {
        background: var(--segment-thumb-bg);
        border-color: var(--segment-thumb-border);
        color: var(--segment-fg-active);
        box-shadow: var(--shadow-sm);
      }

      .segment-hint {
        font-size: var(--text-2xs);
        font-weight: 400;
        color: var(--text-muted);
      }
    `,
  ],
})
export class SegmentedControlComponent {
  readonly options = input.required<SegmentOption[]>();
  readonly value = input.required<string>();
  readonly ariaLabel = input<string>();
  readonly valueChange = output<string>();

  select(value: string): void {
    if (value !== this.value()) {
      this.valueChange.emit(value);
    }
  }
}
