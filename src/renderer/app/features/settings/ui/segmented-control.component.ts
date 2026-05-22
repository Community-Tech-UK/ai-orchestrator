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
  styleUrl: './segmented-control.component.scss',
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
