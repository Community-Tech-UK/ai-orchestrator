/**
 * B4 — the four presets, plus what the current configuration actually does.
 *
 * Purely presentational, and that claim is load-bearing: an earlier design had
 * this component look up the selected preset's canned contract prose itself,
 * which is precisely how it came to display "never runs a destructive command"
 * for a run that had destructive commands switched on. It now renders whatever
 * `contractText` the host resolved from the real current values and computes no
 * contract text of its own.
 */
import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';

import { LOOP_PRESETS, type LoopPresetId, type LoopPresetOverride } from './loop-presets';

@Component({
  selector: 'app-loop-preset-picker',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="loop-presets" aria-labelledby="loop-presets-title">
      <h4 id="loop-presets-title" class="loop-presets__title">Start from an intent</h4>

      <div class="loop-presets__choices" role="group" aria-labelledby="loop-presets-title">
        @for (preset of presets; track preset.id) {
          <button
            type="button"
            class="loop-presets__choice"
            [class.is-selected]="selectedPresetId() === preset.id"
            [attr.aria-pressed]="selectedPresetId() === preset.id"
            [attr.data-preset-id]="preset.id"
            (click)="presetSelected.emit(preset.id)"
          >
            <span class="loop-presets__choice-label">{{ preset.label }}</span>
            <span class="loop-presets__choice-intent">{{ preset.intent }}</span>
          </button>
        }
      </div>

      @if (contractText()) {
        <p class="loop-presets__contract">{{ contractText() }}</p>
      }

      @if (overrides().length > 0) {
        <div class="loop-presets__overrides">
          <button
            type="button"
            class="loop-presets__overrides-toggle"
            [attr.aria-expanded]="showOverrides()"
            (click)="showOverrides.set(!showOverrides())"
          >{{ overrides().length }} change{{ overrides().length === 1 ? '' : 's' }} from this preset</button>

          @if (showOverrides()) {
            <ul class="loop-presets__overrides-list">
              @for (override of overrides(); track override.field) {
                <li class="loop-presets__override">
                  <span class="loop-presets__override-label">{{ override.label }}</span>
                  <span class="loop-presets__override-values">
                    {{ display(override.presetValue) }} → {{ display(override.currentValue) }}
                  </span>
                </li>
              }
            </ul>
            <button
              type="button"
              class="loop-presets__reset"
              (click)="presetReset.emit()"
            >Reset to preset</button>
          }
        </div>
      }
    </section>
  `,
  styleUrl: './loop-preset-picker.component.scss',
})
export class LoopPresetPickerComponent {
  protected readonly presets = LOOP_PRESETS;

  /**
   * Sticky: the last preset actually clicked, not "does the current state match
   * one". Without a remembered choice there is nothing for the changes drawer
   * to diff against.
   */
  readonly selectedPresetId = input<LoopPresetId | null>(null);
  /** Resolved by the host from the real current values. Never computed here. */
  readonly contractText = input<string>('');
  readonly overrides = input<readonly LoopPresetOverride[]>([]);

  readonly presetSelected = output<LoopPresetId>();
  readonly presetReset = output<void>();

  protected readonly showOverrides = signal(false);

  protected display(value: unknown): string {
    if (value === null) return 'none';
    if (value === true) return 'on';
    if (value === false) return 'off';
    return String(value);
  }
}
