/**
 * Settings Component - Application settings modal (container)
 */

import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { GeneralSettingsTabComponent } from './general-settings-tab.component';
import { OrchestrationSettingsTabComponent } from './orchestration-settings-tab.component';
import { MemorySettingsTabComponent } from './memory-settings-tab.component';
import { DisplaySettingsTabComponent } from './display-settings-tab.component';
import { AdvancedSettingsTabComponent } from './advanced-settings-tab.component';
import { KeyboardSettingsTabComponent } from './keyboard-settings-tab.component';
import { PermissionsSettingsTabComponent } from './permissions-settings-tab.component';
import { EcosystemSettingsTabComponent } from './ecosystem-settings-tab.component';
import { ReviewSettingsTabComponent } from './review-settings-tab.component';

type SettingsTab =
  | 'general'
  | 'orchestration'
  | 'memory'
  | 'display'
  | 'ecosystem'
  | 'permissions'
  | 'review'
  | 'advanced'
  | 'keyboard';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [
    GeneralSettingsTabComponent,
    OrchestrationSettingsTabComponent,
    MemorySettingsTabComponent,
    DisplaySettingsTabComponent,
    EcosystemSettingsTabComponent,
    ReviewSettingsTabComponent,
    AdvancedSettingsTabComponent,
    KeyboardSettingsTabComponent,
    PermissionsSettingsTabComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="settings-overlay"
      (click)="onOverlayClick($event)"
      (keydown)="onOverlayKeydown($event)"
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-title"
      tabindex="0"
    >
      <div class="settings-modal">
        <div class="settings-header">
          <h2 id="settings-title">Settings</h2>
          <button class="btn-close" (click)="closeDialog.emit()" title="Close">
            <span class="close-icon">&times;</span>
          </button>
        </div>

        <div class="settings-content">
          <!-- Tabs -->
          <div class="settings-tabs">
            <button
              class="tab"
              [class.active]="activeTab === 'general'"
              (click)="activeTab =('general')"
            >
              General
            </button>
            <button
              class="tab"
              [class.active]="activeTab === 'orchestration'"
              (click)="activeTab =('orchestration')"
            >
              Orchestration
            </button>
            <button
              class="tab"
              [class.active]="activeTab === 'memory'"
              (click)="activeTab =('memory')"
            >
              Memory
            </button>
            <button
              class="tab"
              [class.active]="activeTab === 'display'"
              (click)="activeTab =('display')"
            >
              Display
            </button>
            <button
              class="tab"
              [class.active]="activeTab === 'ecosystem'"
              (click)="activeTab =('ecosystem')"
            >
              Ecosystem
            </button>
            <button
              class="tab"
              [class.active]="activeTab === 'permissions'"
              (click)="activeTab =('permissions')"
            >
              Permissions
            </button>
            <button
              class="tab"
              [class.active]="activeTab === 'review'"
              (click)="activeTab = 'review'"
            >
              Cross-Model Review
            </button>
            <button
              class="tab"
              [class.active]="activeTab === 'advanced'"
              (click)="activeTab =('advanced')"
            >
              Advanced
            </button>
            <button
              class="tab"
              [class.active]="activeTab === 'keyboard'"
              (click)="activeTab =('keyboard')"
            >
              Keyboard
            </button>
          </div>

          <!-- Tab Content -->
          <div class="settings-form">
            @switch (activeTab) {
              @case ('general') {
                <app-general-settings-tab />
              }
              @case ('orchestration') {
                <app-orchestration-settings-tab />
              }
              @case ('memory') {
                <app-memory-settings-tab />
              }
              @case ('display') {
                <app-display-settings-tab />
              }
              @case ('ecosystem') {
                <app-ecosystem-settings-tab />
              }
              @case ('permissions') {
                <app-permissions-settings-tab />
              }
              @case ('review') {
                <app-review-settings-tab />
              }
              @case ('advanced') {
                <app-advanced-settings-tab />
              }
              @case ('keyboard') {
                <app-keyboard-settings-tab />
              }
            }
          </div>
        </div>

        <div class="settings-footer">
          <button class="btn-reset" (click)="resetAll()">
            Reset All to Defaults
          </button>
          <button class="btn-done" (click)="closeDialog.emit()">Done</button>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      .settings-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: var(--overlay-dark-medium);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
      }

      .settings-modal {
        width: 620px;
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
        border: none;
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
        border: none;
        color: white;
        border-radius: var(--radius-sm);
        font-weight: 500;
        cursor: pointer;
        transition: all var(--transition-fast);

        &:hover {
          background: var(--primary-hover);
        }
      }
    `
  ]
})
export class SettingsComponent {
  private store = inject(SettingsStore);
  closeDialog = output<void>();

  activeTab = 'general' as SettingsTab;

  onOverlayClick(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('settings-overlay')) {
      this.closeDialog.emit();
    }
  }

  onOverlayKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.closeDialog.emit();
    }
  }

  resetAll(): void {
    if (
      confirm('Are you sure you want to reset all settings to their defaults?')
    ) {
      this.store.reset();
    }
  }
}
