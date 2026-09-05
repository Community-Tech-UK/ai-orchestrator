/**
 * Setting Row Component - Reusable row for rendering individual settings
 */

import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { DEFAULT_SETTINGS } from '../../../../shared/types/settings-defaults';
import type { SettingMetadata } from '../../../../shared/types/settings.types';

interface SettingRowApi {
  selectFolder?: () => Promise<{ success: boolean; data?: string }>;
}

// Helper to access API from preload
const getApi = () => (window as unknown as { electronAPI?: SettingRowApi }).electronAPI;

@Component({
  selector: 'app-setting-row',
  standalone: true,
  imports: [AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="setting-row" [attr.data-tone]="rowTone()">
      <div class="setting-info">
        <label [for]="setting().key" class="setting-label">{{
          setting().label
        }}</label>
        <p class="setting-description">
          {{ setting().description }}
        </p>
        @if (rowBadge(); as badge) {
          <span class="risk-pill">{{ badge }}</span>
        }
        @if (isModified()) {
          <button
            type="button"
            class="setting-reset"
            (click)="resetToDefault()"
            [appTooltip]="resetTooltip()"
            [attr.aria-label]="resetTooltip()"
          >Reset</button>
        }
      </div>
      <div class="setting-control">
        @switch (setting().type) {
          @case ('boolean') {
            <label class="toggle">
              <input
                type="checkbox"
                [id]="setting().key"
                [checked]="value()"
                (change)="onBooleanChange($event)"
              />
              <span class="toggle-slider"></span>
            </label>
          }
          @case ('select') {
            <select
              [id]="setting().key"
              (change)="onSelectChange($event)"
            >
              @for (option of selectOptions(); track option.value) {
                <option [value]="option.value" [selected]="isSelectedOption(option.value)">
                  {{ option.label }}
                </option>
              }
            </select>
          }
          @case ('number') {
            <input
              type="number"
              [id]="setting().key"
              [value]="value()"
              [min]="setting().min"
              [max]="setting().max"
              (change)="onNumberChange($event)"
            />
          }
          @case ('string') {
            <input
              type="text"
              [id]="setting().key"
              [value]="value()"
              [placeholder]="setting().placeholder || ''"
              (change)="onStringChange($event)"
            />
          }
          @case ('directory') {
            <div class="directory-input">
              <input
                type="text"
                [id]="setting().key"
                [value]="value()"
                [placeholder]="setting().placeholder || 'Select folder...'"
                readonly
              />
              <button class="btn-browse" (click)="browseFolder()">
                Browse
              </button>
            </div>
          }
          @case ('json') {
            <div class="json-editor">
              <textarea
                [id]="setting().key"
                rows="6"
                spellcheck="false"
                [value]="jsonText()"
                (input)="onJsonInput($event)"
                (change)="onJsonCommit($event)"
              ></textarea>
              @if (jsonError(); as err) {
                <p class="json-error" role="alert">{{ err }}</p>
              }
            </div>
          }
          @case ('multi-select') {
            <div class="multi-select-options">
              @for (option of setting().options ?? []; track option.value) {
                <label class="multi-select-option">
                  <input
                    type="checkbox"
                    [checked]="isOptionSelected(option.value)"
                    (change)="toggleMultiSelectOption(option.value)"
                  />
                  {{ option.label }}
                </label>
              }
            </div>
          }
        }
      </div>
    </div>
  `,
  styleUrl: './setting-row.component.scss',
})
export class SettingRowComponent {
  /**
   * UX4.1 — a per-setting reset. Shown only when the current value differs from
   * the shipped default, so a row the user has never touched carries no extra
   * control. The default is read from `DEFAULT_SETTINGS` rather than passed in,
   * so every caller gets it without threading a new input through five tabs.
   */
  protected readonly defaultValue = computed<unknown>(
    () => (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[this.setting().key],
  );

  protected readonly isModified = computed(() => {
    const current = this.value();
    const fallback = this.defaultValue();
    if (fallback === undefined) return false;
    return JSON.stringify(current ?? null) !== JSON.stringify(fallback ?? null);
  });

  protected readonly resetTooltip = computed(() => {
    const fallback = this.defaultValue();
    const shown = typeof fallback === 'string' && fallback.length === 0
      ? 'empty'
      : String(fallback);
    return `Reset to the default (${shown})`;
  });

  protected resetToDefault(): void {
    this.jsonDraft.set(null);
    this.jsonError.set(null);
    this.valueChange.emit({ key: this.setting().key, value: this.defaultValue() });
  }

  setting = input.required<SettingMetadata>();
  value = input.required<unknown>();
  /**
   * Runtime-loaded options for a `select` row, used when the choices aren't
   * known statically in metadata (e.g. the list of managed browser profiles).
   * When provided, these take precedence over `setting().options`.
   */
  dynamicOptions = input<{ value: string | number; label: string }[] | null>(null);
  valueChange = output<{ key: string; value: unknown }>();

  /**
   * Options shown in a `select` control. Prefers runtime `dynamicOptions`, then
   * the static metadata options. If the current value isn't represented in the
   * list (e.g. a profile that was deleted or hand-entered before), it's prepended
   * so the saved value is preserved rather than silently dropped.
   */
  selectOptions(): { value: string | number; label: string }[] {
    const options = this.dynamicOptions() ?? this.setting().options ?? [];
    const current = this.value();
    if (
      (typeof current === 'string' || typeof current === 'number') &&
      current !== '' &&
      !options.some((option) => String(option.value) === String(current))
    ) {
      return [{ value: current, label: String(current) }, ...options];
    }
    return options;
  }

  rowTone(): 'risk' | null {
    switch (this.setting().key) {
      case 'defaultYoloMode':
      case 'mcpDisableProviderBackups':
      case 'mcpAllowWorldWritableParent':
        return 'risk';
      default:
        return null;
    }
  }

  rowBadge(): string | null {
    switch (this.setting().key) {
      case 'defaultYoloMode':
        return 'High trust';
      case 'mcpDisableProviderBackups':
      case 'mcpAllowWorldWritableParent':
        return 'Safety override';
      default:
        return null;
    }
  }

  onBooleanChange(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.valueChange.emit({ key: this.setting().key, value: checked });
  }

  onSelectChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.valueChange.emit({ key: this.setting().key, value });
  }

  isSelectedOption(optionValue: string | number): boolean {
    return String(optionValue) === String(this.value());
  }

  /**
   * S1.7: the `min`/`max` attributes on a number input are advisory — a user can
   * type 999999 into a field capped at 10 and `change` still fires with it. The
   * write then either persists an out-of-range value or is rejected by the main
   * process and silently reverted (S1.4). Clamp before emitting, and put the
   * clamped value back in the box so the field never disagrees with the state.
   */
  onNumberChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const parsed = parseInt(input.value, 10);
    if (isNaN(parsed)) {
      input.value = String(this.value() ?? '');
      return;
    }
    const { min, max } = this.setting();
    let clamped = parsed;
    if (min !== undefined && clamped < min) clamped = min;
    if (max !== undefined && clamped > max) clamped = max;
    if (clamped !== parsed) input.value = String(clamped);
    this.valueChange.emit({ key: this.setting().key, value: clamped });
  }

  /** Live text while editing a `json` row, so an invalid draft is not discarded. */
  protected readonly jsonDraft = signal<string | null>(null);
  protected readonly jsonError = signal<string | null>(null);

  protected readonly jsonText = computed(() => {
    const draft = this.jsonDraft();
    if (draft !== null) return draft;
    const raw = this.value();
    if (typeof raw === 'string') return raw;
    return raw === undefined || raw === null ? '' : JSON.stringify(raw, null, 2);
  });

  protected onJsonInput(event: Event): void {
    const text = (event.target as HTMLTextAreaElement).value;
    this.jsonDraft.set(text);
    this.jsonError.set(this.validateJson(text));
  }

  /**
   * Commit on blur/change only, and only when the text parses. An invalid draft
   * stays on screen with its error rather than being written or silently thrown
   * away — these keys hold allow/deny lists where a truncated write is worse
   * than no write.
   */
  protected onJsonCommit(event: Event): void {
    const text = (event.target as HTMLTextAreaElement).value;
    const error = this.validateJson(text);
    this.jsonError.set(error);
    if (error) return;
    this.jsonDraft.set(null);
    this.valueChange.emit({ key: this.setting().key, value: text.trim() });
  }

  private validateJson(text: string): string | null {
    const trimmed = text.trim();
    if (trimmed === '') return null;
    try {
      JSON.parse(trimmed);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : 'Invalid JSON';
    }
  }

  onStringChange(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.valueChange.emit({ key: this.setting().key, value });
  }

  async browseFolder(): Promise<void> {
    const api = getApi();
    if (!api?.selectFolder) return;

    const response = await api.selectFolder();
    if (response.success && response.data) {
      this.valueChange.emit({ key: this.setting().key, value: response.data });
    }
  }

  isOptionSelected(optionValue: string | number): boolean {
    const current = this.value();
    return Array.isArray(current) && current.includes(optionValue);
  }

  toggleMultiSelectOption(optionValue: string | number): void {
    const current = this.value();
    const arr = Array.isArray(current) ? [...current] : [];
    const idx = arr.indexOf(optionValue);
    if (idx >= 0) {
      arr.splice(idx, 1);
    } else {
      arr.push(optionValue);
    }
    this.valueChange.emit({ key: this.setting().key, value: arr });
  }
}
