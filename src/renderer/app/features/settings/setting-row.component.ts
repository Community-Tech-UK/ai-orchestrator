/**
 * Setting Row Component - Reusable row for rendering individual settings
 */

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { SettingMetadata } from '../../../../shared/types/settings.types';

interface SettingRowApi {
  selectFolder?: () => Promise<{ success: boolean; data?: string }>;
}

// Helper to access API from preload
const getApi = () => (window as unknown as { electronAPI?: SettingRowApi }).electronAPI;

@Component({
  selector: 'app-setting-row',
  standalone: true,
  imports: [FormsModule],
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
              [value]="value()"
              (change)="onSelectChange($event)"
            >
              @for (option of setting().options; track option.value) {
                <option [value]="option.value">
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
  setting = input.required<SettingMetadata>();
  value = input.required<unknown>();
  valueChange = output<{ key: string; value: unknown }>();

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

  onNumberChange(event: Event): void {
    const value = parseInt((event.target as HTMLInputElement).value, 10);
    if (!isNaN(value)) {
      this.valueChange.emit({ key: this.setting().key, value });
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
