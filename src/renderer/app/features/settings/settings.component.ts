/**
 * Settings Component - Full-page settings with left sidebar navigation
 * Modeled after the Claude desktop app settings layout.
 */

import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { Router } from '@angular/router';
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
import { ConnectionsSettingsTabComponent } from './connections-settings-tab.component';
import { RemoteNodesSettingsTabComponent } from './remote-nodes-settings-tab.component';
import { CliHealthSettingsTabComponent } from './cli-health-settings-tab.component';

type SettingsTab =
  | 'general'
  | 'orchestration'
  | 'connections'
  | 'memory'
  | 'display'
  | 'ecosystem'
  | 'permissions'
  | 'review'
  | 'advanced'
  | 'keyboard'
  | 'remote-nodes'
  | 'cli-health';

interface SettingsNavItem {
  id: SettingsTab;
  label: string;
  group?: string;
}

const NAV_ITEMS: SettingsNavItem[] = [
  { id: 'general', label: 'General' },
  { id: 'connections', label: 'Connections' },
  { id: 'display', label: 'Display' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'orchestration', label: 'Orchestration', group: 'Agents' },
  { id: 'review', label: 'Cross-Model Review', group: 'Agents' },
  { id: 'memory', label: 'Memory', group: 'Agents' },
  { id: 'cli-health', label: 'CLI Health', group: 'Advanced' },
  { id: 'remote-nodes', label: 'Remote Nodes', group: 'Advanced' },
  { id: 'ecosystem', label: 'Ecosystem', group: 'Advanced' },
  { id: 'advanced', label: 'Advanced', group: 'Advanced' },
];

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
    PermissionsSettingsTabComponent,
    ConnectionsSettingsTabComponent,
    RemoteNodesSettingsTabComponent,
    CliHealthSettingsTabComponent
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="settings-page" (keydown)="onKeydown($event)" tabindex="0">
      <!-- Left sidebar nav -->
      <aside class="settings-sidebar">
        <button class="back-btn" (click)="goBack()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/>
          </svg>
          Settings
        </button>

        <nav class="settings-nav">
          @for (item of ungroupedItems; track item.id) {
            <button
              class="nav-item"
              [class.active]="activeTab() === item.id"
              (click)="activeTab.set(item.id)"
            >
              {{ item.label }}
            </button>
          }

          @for (group of groups; track group) {
            <span class="nav-group-label">{{ group }}</span>
            @for (item of getGroupItems(group); track item.id) {
              <button
                class="nav-item"
                [class.active]="activeTab() === item.id"
                (click)="activeTab.set(item.id)"
              >
                {{ item.label }}
              </button>
            }
          }
        </nav>
      </aside>

      <!-- Main content area -->
      <main class="settings-content">
        <div class="settings-body">
          @switch (activeTab()) {
            @case ('general') {
              <app-general-settings-tab />
            }
            @case ('connections') {
              <app-connections-settings-tab />
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
            @case ('remote-nodes') {
              <app-remote-nodes-settings-tab />
            }
            @case ('cli-health') {
              <app-cli-health-settings-tab />
            }
          }
        </div>
      </main>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }

    .settings-page {
      display: flex;
      height: 100vh;
      background: var(--bg-primary, #0f0f0f);
      color: var(--text-primary, #e5e5e5);
      outline: none;
    }

    /* ── Left sidebar ── */
    .settings-sidebar {
      width: 220px;
      min-width: 220px;
      border-right: 1px solid var(--border-color, #2a2a2e);
      padding: 1.25rem 0.75rem;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
      overflow-y: auto;
      background: var(--bg-secondary, #1a1a1a);
    }

    .back-btn {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      background: none;
      border: none;
      color: var(--text-primary, #e5e5e5);
      cursor: pointer;
      font-size: 1.125rem;
      font-weight: 600;
      padding: 0.375rem 0.5rem;
      margin-bottom: 1rem;
      border-radius: 6px;
      transition: background 0.15s ease;
    }

    .back-btn:hover {
      background: rgba(255, 255, 255, 0.06);
    }

    .back-btn svg {
      color: var(--text-muted, #888);
    }

    .settings-nav {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .nav-item {
      display: block;
      width: 100%;
      text-align: left;
      padding: 0.5rem 0.75rem;
      background: none;
      border: none;
      border-radius: 6px;
      color: var(--text-secondary, #aaa);
      font-size: 0.875rem;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.1s ease;
    }

    .nav-item:hover {
      background: rgba(255, 255, 255, 0.06);
      color: var(--text-primary, #e5e5e5);
    }

    .nav-item.active {
      background: rgba(255, 255, 255, 0.1);
      color: var(--text-primary, #e5e5e5);
    }

    .nav-group-label {
      display: block;
      padding: 1rem 0.75rem 0.375rem;
      font-size: 0.6875rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-muted, #666);
    }

    /* ── Main content ── */
    .settings-content {
      flex: 1;
      overflow-y: auto;
      padding: 2rem 2.5rem;
    }

    .settings-body {
      max-width: 680px;
    }
  `]
})
export class SettingsComponent {
  private store = inject(SettingsStore);
  private router = inject(Router);

  /** Still emitted when opened as a modal (legacy callers). */
  closeDialog = output<void>();

  activeTab = signal<SettingsTab>('general');

  readonly navItems = NAV_ITEMS;
  readonly ungroupedItems = NAV_ITEMS.filter(i => !i.group);
  readonly groups = [...new Set(NAV_ITEMS.filter(i => i.group).map(i => i.group!))];

  getGroupItems(group: string): SettingsNavItem[] {
    return NAV_ITEMS.filter(i => i.group === group);
  }

  goBack(): void {
    // If opened as modal, emit close; otherwise navigate home
    this.closeDialog.emit();
    void this.router.navigate(['/']);
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      this.goBack();
    }
  }

  resetAll(): void {
    if (confirm('Are you sure you want to reset all settings to their defaults?')) {
      this.store.reset();
    }
  }
}
