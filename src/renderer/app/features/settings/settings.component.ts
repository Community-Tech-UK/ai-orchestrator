/**
 * Settings Component - Application settings modal
 */

import {
  Component,
  inject,
  output,
  signal,
  computed,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SettingsStore } from '../../core/state/settings.store';
import { KeybindingService } from '../../core/services/keybinding.service';
import type { SettingMetadata, AppSettings } from '../../../../shared/types/settings.types';

// Helper to access API from preload
const getApi = () => (window as any).electronAPI;

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="settings-overlay" (click)="onOverlayClick($event)">
      <div class="settings-modal">
        <div class="settings-header">
          <h2>Settings</h2>
          <button class="btn-close" (click)="close.emit()" title="Close">
            <span class="close-icon">&times;</span>
          </button>
        </div>

        <div class="settings-content">
          <!-- Tabs -->
          <div class="settings-tabs">
            <button
              class="tab"
              [class.active]="activeTab() === 'general'"
              (click)="activeTab.set('general')"
            >
              General
            </button>
            <button
              class="tab"
              [class.active]="activeTab() === 'orchestration'"
              (click)="activeTab.set('orchestration')"
            >
              Orchestration
            </button>
            <button
              class="tab"
              [class.active]="activeTab() === 'memory'"
              (click)="activeTab.set('memory')"
            >
              Memory
            </button>
            <button
              class="tab"
              [class.active]="activeTab() === 'display'"
              (click)="activeTab.set('display')"
            >
              Display
            </button>
            <button
              class="tab"
              [class.active]="activeTab() === 'advanced'"
              (click)="activeTab.set('advanced')"
            >
              Advanced
            </button>
            <button
              class="tab"
              [class.active]="activeTab() === 'keyboard'"
              (click)="activeTab.set('keyboard')"
            >
              Keyboard
            </button>
          </div>

          <!-- Settings Form -->
          <div class="settings-form">
            @switch (activeTab()) {
              @case ('general') {
                @for (setting of store.generalSettings(); track setting.key) {
                  <div class="setting-row">
                    <div class="setting-info">
                      <label [for]="setting.key" class="setting-label">{{ setting.label }}</label>
                      <p class="setting-description">{{ setting.description }}</p>
                    </div>
                    <div class="setting-control">
                      @switch (setting.type) {
                        @case ('boolean') {
                          <label class="toggle">
                            <input
                              type="checkbox"
                              [id]="setting.key"
                              [checked]="getValue(setting.key)"
                              (change)="onBooleanChange(setting.key, $event)"
                            />
                            <span class="toggle-slider"></span>
                          </label>
                        }
                        @case ('select') {
                          <select
                            [id]="setting.key"
                            [value]="getValue(setting.key)"
                            (change)="onSelectChange(setting.key, $event)"
                          >
                            @for (option of setting.options; track option.value) {
                              <option [value]="option.value">{{ option.label }}</option>
                            }
                          </select>
                        }
                        @case ('directory') {
                          <div class="directory-input">
                            <input
                              type="text"
                              [id]="setting.key"
                              [value]="getValue(setting.key)"
                              [placeholder]="setting.placeholder || 'Select folder...'"
                              readonly
                            />
                            <button class="btn-browse" (click)="browseFolder(setting.key)">
                              Browse
                            </button>
                          </div>
                        }
                      }
                    </div>
                  </div>
                }
              }
              @case ('orchestration') {
                @for (setting of store.orchestrationSettings(); track setting.key) {
                  <div class="setting-row">
                    <div class="setting-info">
                      <label [for]="setting.key" class="setting-label">{{ setting.label }}</label>
                      <p class="setting-description">{{ setting.description }}</p>
                    </div>
                    <div class="setting-control">
                      @switch (setting.type) {
                        @case ('boolean') {
                          <label class="toggle">
                            <input
                              type="checkbox"
                              [id]="setting.key"
                              [checked]="getValue(setting.key)"
                              (change)="onBooleanChange(setting.key, $event)"
                            />
                            <span class="toggle-slider"></span>
                          </label>
                        }
                        @case ('number') {
                          <input
                            type="number"
                            [id]="setting.key"
                            [value]="getValue(setting.key)"
                            [min]="setting.min"
                            [max]="setting.max"
                            (change)="onNumberChange(setting.key, $event)"
                          />
                        }
                      }
                    </div>
                  </div>
                }
              }
              @case ('memory') {
                @for (setting of store.memorySettings(); track setting.key) {
                  <div class="setting-row">
                    <div class="setting-info">
                      <label [for]="setting.key" class="setting-label">{{ setting.label }}</label>
                      <p class="setting-description">{{ setting.description }}</p>
                    </div>
                    <div class="setting-control">
                      @switch (setting.type) {
                        @case ('boolean') {
                          <label class="toggle">
                            <input
                              type="checkbox"
                              [id]="setting.key"
                              [checked]="getValue(setting.key)"
                              (change)="onBooleanChange(setting.key, $event)"
                            />
                            <span class="toggle-slider"></span>
                          </label>
                        }
                        @case ('number') {
                          <input
                            type="number"
                            [id]="setting.key"
                            [value]="getValue(setting.key)"
                            [min]="setting.min"
                            [max]="setting.max"
                            (change)="onNumberChange(setting.key, $event)"
                          />
                        }
                      }
                    </div>
                  </div>
                }
              }
              @case ('display') {
                @for (setting of store.displaySettings(); track setting.key) {
                  <div class="setting-row">
                    <div class="setting-info">
                      <label [for]="setting.key" class="setting-label">{{ setting.label }}</label>
                      <p class="setting-description">{{ setting.description }}</p>
                    </div>
                    <div class="setting-control">
                      @switch (setting.type) {
                        @case ('boolean') {
                          <label class="toggle">
                            <input
                              type="checkbox"
                              [id]="setting.key"
                              [checked]="getValue(setting.key)"
                              (change)="onBooleanChange(setting.key, $event)"
                            />
                            <span class="toggle-slider"></span>
                          </label>
                        }
                        @case ('number') {
                          <input
                            type="number"
                            [id]="setting.key"
                            [value]="getValue(setting.key)"
                            [min]="setting.min"
                            [max]="setting.max"
                            (change)="onNumberChange(setting.key, $event)"
                          />
                        }
                      }
                    </div>
                  </div>
                }
              }
              @case ('advanced') {
                @for (setting of store.advancedSettings(); track setting.key) {
                  <div class="setting-row">
                    <div class="setting-info">
                      <label [for]="setting.key" class="setting-label">{{ setting.label }}</label>
                      <p class="setting-description">{{ setting.description }}</p>
                    </div>
                    <div class="setting-control">
                      @switch (setting.type) {
                        @case ('number') {
                          <input
                            type="number"
                            [id]="setting.key"
                            [value]="getValue(setting.key)"
                            [min]="setting.min"
                            [max]="setting.max"
                            (change)="onNumberChange(setting.key, $event)"
                          />
                        }
                        @case ('string') {
                          <input
                            type="text"
                            [id]="setting.key"
                            [value]="getValue(setting.key)"
                            [placeholder]="setting.placeholder || ''"
                            (change)="onStringChange(setting.key, $event)"
                          />
                        }
                      }
                    </div>
                  </div>
                }

                <!-- Future Settings Note -->
                <div class="future-settings-note">
                  <h4>Coming Soon</h4>
                  <ul>
                    <li>Session auto-save/restore</li>
                    <li>Notification preferences</li>
                    <li>Export/import settings</li>
                    <li>Per-project settings</li>
                  </ul>
                </div>
              }
              @case ('keyboard') {
                <div class="keyboard-shortcuts-section">
                  <p class="keyboard-intro">
                    These keyboard shortcuts help you work faster. Press the shortcut combination shown to trigger the action.
                  </p>
                  @for (category of keybindingCategories(); track category.name) {
                    <div class="shortcut-category">
                      <h3 class="category-title">{{ category.name }}</h3>
                      <div class="shortcut-list">
                        @for (binding of category.bindings; track binding.id) {
                          <div class="shortcut-row">
                            <div class="shortcut-info">
                              <span class="shortcut-name">{{ binding.name }}</span>
                              <span class="shortcut-desc">{{ binding.description }}</span>
                            </div>
                            <div class="shortcut-keys">
                              <kbd>{{ keybindingService.formatBinding(binding) }}</kbd>
                            </div>
                          </div>
                        }
                      </div>
                    </div>
                  }
                </div>
              }
            }
          </div>
        </div>

        <div class="settings-footer">
          <button class="btn-reset" (click)="resetAll()">
            Reset All to Defaults
          </button>
          <button class="btn-done" (click)="close.emit()">
            Done
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .settings-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .settings-modal {
      width: 600px;
      max-width: 90vw;
      max-height: 80vh;
      background: var(--bg-primary);
      border-radius: var(--radius-lg);
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }

    .settings-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--spacing-md) var(--spacing-lg);
      border-bottom: 1px solid var(--border-color);
      background: var(--bg-secondary);
    }

    .settings-header h2 {
      margin: 0;
      font-size: 18px;
      font-weight: 600;
    }

    .btn-close {
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border-radius: var(--radius-sm);
      font-size: 24px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }
    }

    .settings-content {
      flex: 1;
      overflow-y: auto;
      padding: var(--spacing-lg);
    }

    .settings-tabs {
      display: flex;
      gap: var(--spacing-xs);
      margin-bottom: var(--spacing-lg);
      border-bottom: 1px solid var(--border-color);
      padding-bottom: var(--spacing-sm);
    }

    .tab {
      padding: var(--spacing-sm) var(--spacing-md);
      background: transparent;
      border: none;
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-weight: 500;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--bg-tertiary);
        color: var(--text-primary);
      }

      &.active {
        background: var(--primary-color);
        color: white;
      }
    }

    .settings-form {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
    }

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
    input[type="number"],
    input[type="text"] {
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

    input[type="number"] {
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

    /* Future Settings Note */
    .future-settings-note {
      margin-top: var(--spacing-lg);
      padding: var(--spacing-md);
      background: var(--bg-tertiary);
      border-radius: var(--radius-md);
      border: 1px dashed var(--border-color);

      h4 {
        margin: 0 0 var(--spacing-sm);
        font-size: 14px;
        color: var(--text-secondary);
      }

      ul {
        margin: 0;
        padding-left: var(--spacing-lg);
        color: var(--text-muted);
        font-size: 13px;
      }

      li {
        margin-bottom: var(--spacing-xs);
      }
    }

    /* Keyboard Shortcuts */
    .keyboard-shortcuts-section {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-lg);
    }

    .keyboard-intro {
      margin: 0;
      color: var(--text-secondary);
      font-size: 13px;
      line-height: 1.5;
    }

    .shortcut-category {
      background: var(--bg-secondary);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
    }

    .category-title {
      margin: 0 0 var(--spacing-sm);
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
      border-bottom: 1px solid var(--border-color);
      padding-bottom: var(--spacing-xs);
    }

    .shortcut-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .shortcut-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: var(--radius-sm);

      &:hover {
        background: var(--bg-tertiary);
      }
    }

    .shortcut-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .shortcut-name {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .shortcut-desc {
      font-size: 11px;
      color: var(--text-muted);
    }

    .shortcut-keys {
      flex-shrink: 0;
    }

    .shortcut-keys kbd {
      display: inline-flex;
      align-items: center;
      padding: 4px 8px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-primary);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
    }

    .settings-footer {
      display: flex;
      justify-content: space-between;
      padding: var(--spacing-md) var(--spacing-lg);
      border-top: 1px solid var(--border-color);
      background: var(--bg-secondary);
    }

    .btn-reset {
      padding: var(--spacing-sm) var(--spacing-md);
      background: transparent;
      border: 1px solid var(--error-color);
      color: var(--error-color);
      border-radius: var(--radius-sm);
      font-weight: 500;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--error-color);
        color: white;
      }
    }

    .btn-done {
      padding: var(--spacing-sm) var(--spacing-lg);
      background: var(--primary-color);
      color: white;
      border-radius: var(--radius-sm);
      font-weight: 500;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--primary-hover);
      }
    }
  `],
})
export class SettingsComponent {
  store = inject(SettingsStore);
  keybindingService = inject(KeybindingService);
  close = output<void>();

  activeTab = signal<'general' | 'orchestration' | 'memory' | 'display' | 'advanced' | 'keyboard'>('general');

  // Computed: keybindings grouped by category
  keybindingCategories = computed(() => {
    const byCategory = this.keybindingService.bindingsByCategory();
    const categories: Array<{ name: string; bindings: any[] }> = [];
    byCategory.forEach((bindings, name) => {
      categories.push({ name, bindings });
    });
    return categories;
  });

  onOverlayClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('settings-overlay')) {
      this.close.emit();
    }
  }

  getValue(key: string): unknown {
    return this.store.get(key as keyof AppSettings);
  }

  onBooleanChange(key: string, event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.store.set(key as keyof AppSettings, checked as any);
  }

  onSelectChange(key: string, event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.store.set(key as keyof AppSettings, value as any);
  }

  onNumberChange(key: string, event: Event): void {
    const value = parseInt((event.target as HTMLInputElement).value, 10);
    if (!isNaN(value)) {
      this.store.set(key as keyof AppSettings, value as any);
    }
  }

  onStringChange(key: string, event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.store.set(key as keyof AppSettings, value as any);
  }

  async browseFolder(key: string): Promise<void> {
    const api = getApi();
    if (!api) return;

    const response = await api.selectFolder();
    if (response.success && response.data) {
      this.store.set(key as keyof AppSettings, response.data as any);
    }
  }

  resetAll(): void {
    if (confirm('Are you sure you want to reset all settings to their defaults?')) {
      this.store.reset();
    }
  }
}
