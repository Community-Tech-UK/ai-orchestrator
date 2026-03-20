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
    <div class="setting-row">
      <div class="setting-info">
        <label [for]="setting().key" class="setting-label">{{
          setting().label
        }}</label>
        <p class="setting-description">
          {{ setting().description }}
        </p>
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
  styles: [
    `
      .setting-row {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: var(--spacing-lg);
        padding: var(--spacing-md);
        background: var(--bg-secondary);
        border-radius: var(--radius-md);
      }

      .setting-info {
        flex: 1;
      }

      .setting-label {
        display: block;
        font-weight: 500;
        margin-bottom: var(--spacing-xs);
        color: var(--text-primary);
      }

      .setting-description {
        margin: 0;
        font-size: 12px;
        color: var(--text-secondary);
        line-height: 1.4;
      }

      .setting-control {
        flex-shrink: 0;
        min-width: 150px;
      }

      /* Toggle Switch */
      .toggle {
        position: relative;
        display: inline-block;
        width: 48px;
        height: 26px;
      }

      .toggle input {
        opacity: 0;
        width: 0;
        height: 0;
      }

      .toggle-slider {
        position: absolute;
        cursor: pointer;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: var(--bg-tertiary);
        border-radius: 26px;
        transition: var(--transition-fast);

        &::before {
          content: '';
          position: absolute;
          height: 20px;
          width: 20px;
          left: 3px;
          bottom: 3px;
          background: white;
          border-radius: 50%;
          transition: var(--transition-fast);
        }
      }

      .toggle input:checked + .toggle-slider {
        background: var(--primary-color);
      }

      .toggle input:checked + .toggle-slider::before {
        transform: translateX(22px);
      }

      /* Select */
      select {
        width: 100%;
        padding: var(--spacing-sm);
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        font-size: 14px;
        cursor: pointer;

        &:focus {
          outline: none;
          border-color: var(--primary-color);
        }
      }

      /* Number/Text Input */
      input[type='number'],
      input[type='text'] {
        width: 100%;
        padding: var(--spacing-sm);
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        font-size: 14px;

        &:focus {
          outline: none;
          border-color: var(--primary-color);
        }
      }

      input[type='number'] {
        width: 80px;
      }

      /* Directory Input */
      .directory-input {
        display: flex;
        gap: var(--spacing-xs);
      }

      .directory-input input {
        flex: 1;
      }

      .btn-browse {
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        color: var(--text-primary);
        font-size: 13px;
        cursor: pointer;
        white-space: nowrap;

        &:hover {
          background: var(--bg-primary);
        }
      }

      .multi-select-options {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .multi-select-option {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
        cursor: pointer;
      }
    `
  ]
})
export class SettingRowComponent {
  setting = input.required<SettingMetadata>();
  value = input.required<unknown>();
  valueChange = output<{ key: string; value: unknown }>();

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
