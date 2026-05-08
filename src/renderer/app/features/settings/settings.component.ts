/**
 * Settings Component - Full-page settings with left sidebar navigation
 * Modeled after the Claude desktop app settings layout.
 */

import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
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
import { ProviderQuotaSettingsTabComponent } from './provider-quota-settings-tab.component';
import { NetworkSettingsTabComponent } from './network-settings-tab.component';
import { DoctorSettingsTabComponent } from './doctor-settings-tab.component';
import { RtkSavingsTabComponent } from './rtk-savings-tab.component';
import { McpPageComponent } from '../mcp/mcp-page.component';
import { HooksPageComponent } from '../hooks/hooks-page.component';
import { WorktreePageComponent } from '../worktree/worktree-page.component';
import { SnapshotPageComponent } from '../snapshots/snapshot-page.component';
import { ArchivePageComponent } from '../archive/archive-page.component';
import { RemoteConfigPageComponent } from '../remote-config/remote-config-page.component';
import { ModelsPageComponent } from '../models/models-page.component';

type SettingsTab =
  | 'general'
  | 'orchestration'
  | 'connections'
  | 'network'
  | 'memory'
  | 'display'
  | 'ecosystem'
  | 'permissions'
  | 'review'
  | 'advanced'
  | 'keyboard'
  | 'remote-nodes'
  | 'doctor'
  | 'cli-health'
  | 'provider-quota'
  | 'rtk-savings'
  | 'models'
  | 'mcp'
  | 'hooks'
  | 'worktrees'
  | 'snapshots'
  | 'archive'
  | 'remote-config';

/** Tabs whose content is an embedded full-width feature page (no 680px cap). */
const WIDE_TABS: ReadonlySet<SettingsTab> = new Set<SettingsTab>([
  'models',
  'mcp',
  'hooks',
  'worktrees',
  'snapshots',
  'archive',
  'remote-config',
  'doctor',
]);

interface SettingsNavItem {
  id: SettingsTab;
  label: string;
  group?: string;
}

const NAV_ITEMS: SettingsNavItem[] = [
  { id: 'general', label: 'General' },
  { id: 'connections', label: 'Connections' },
  { id: 'network', label: 'Network' },
  { id: 'display', label: 'Display' },
  { id: 'keyboard', label: 'Keyboard' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'orchestration', label: 'Orchestration', group: 'Agents' },
  { id: 'review', label: 'Cross-Model Review', group: 'Agents' },
  { id: 'memory', label: 'Memory', group: 'Agents' },
  { id: 'models', label: 'Models', group: 'Configuration' },
  { id: 'mcp', label: 'MCP Servers', group: 'Configuration' },
  { id: 'hooks', label: 'Hooks', group: 'Configuration' },
  { id: 'worktrees', label: 'Worktrees', group: 'Configuration' },
  { id: 'snapshots', label: 'Snapshots', group: 'Configuration' },
  { id: 'archive', label: 'Archive', group: 'Configuration' },
  { id: 'remote-config', label: 'Remote Config', group: 'Configuration' },
  { id: 'cli-health', label: 'CLI Health', group: 'Advanced' },
  { id: 'doctor', label: 'Doctor', group: 'Advanced' },
  { id: 'provider-quota', label: 'Provider Quota', group: 'Advanced' },
  { id: 'rtk-savings', label: 'RTK Savings', group: 'Advanced' },
  { id: 'remote-nodes', label: 'Remote Nodes', group: 'Advanced' },
  { id: 'ecosystem', label: 'Ecosystem', group: 'Advanced' },
  { id: 'advanced', label: 'Advanced', group: 'Advanced' },
];

const SETTINGS_TAB_IDS = new Set<SettingsTab>(NAV_ITEMS.map((item) => item.id));

function isSettingsTab(value: string | null): value is SettingsTab {
  return Boolean(value && SETTINGS_TAB_IDS.has(value as SettingsTab));
}

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
    NetworkSettingsTabComponent,
    DoctorSettingsTabComponent,
    RemoteNodesSettingsTabComponent,
    CliHealthSettingsTabComponent,
    ProviderQuotaSettingsTabComponent,
    RtkSavingsTabComponent,
    McpPageComponent,
    HooksPageComponent,
    WorktreePageComponent,
    SnapshotPageComponent,
    ArchivePageComponent,
    RemoteConfigPageComponent,
    ModelsPageComponent,
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
              (click)="selectTab(item.id)"
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
                (click)="selectTab(item.id)"
              >
                {{ item.label }}
              </button>
            }
          }
        </nav>
      </aside>

      <!-- Main content area -->
      <main class="settings-content" [class.wide]="isWideTab()">
        <div class="settings-body" [class.wide]="isWideTab()">
          @switch (activeTab()) {
            @case ('general') {
              <app-general-settings-tab />
            }
            @case ('connections') {
              <app-connections-settings-tab />
            }
            @case ('network') {
              <app-network-settings-tab />
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
            @case ('doctor') {
              <app-doctor-settings-tab />
            }
            @case ('provider-quota') {
              <app-provider-quota-settings-tab />
            }
            @case ('rtk-savings') {
              <app-rtk-savings-tab />
            }
            @case ('models') {
              <app-models-page />
            }
            @case ('mcp') {
              <app-mcp-page />
            }
            @case ('hooks') {
              <app-hooks-page />
            }
            @case ('worktrees') {
              <app-worktree-page />
            }
            @case ('snapshots') {
              <app-snapshot-page />
            }
            @case ('archive') {
              <app-archive-page />
            }
            @case ('remote-config') {
              <app-remote-config-page />
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

    .settings-content.wide {
      padding: 0;
    }

    .settings-body {
      max-width: 680px;
    }

    .settings-body.wide {
      max-width: none;
      height: 100%;
    }
  `]
})
export class SettingsComponent {
  private store = inject(SettingsStore);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  /** Still emitted when opened as a modal (legacy callers). */
  closeDialog = output<void>();

  activeTab = signal<SettingsTab>('general');
  readonly isWideTab = computed(() => WIDE_TABS.has(this.activeTab()));

  readonly navItems = NAV_ITEMS;
  readonly ungroupedItems = NAV_ITEMS.filter(i => !i.group);
  readonly groups = [...new Set(NAV_ITEMS.filter(i => i.group).map(i => i.group!))];

  constructor() {
    this.route.fragment
      .pipe(takeUntilDestroyed())
      .subscribe((fragment) => {
        if (isSettingsTab(fragment)) {
          this.activeTab.set(fragment);
        }
      });

    this.route.queryParamMap
      .pipe(takeUntilDestroyed())
      .subscribe((params) => {
        const tab = params.get('tab');
        if (isSettingsTab(tab)) {
          this.activeTab.set(tab);
        }
      });
  }

  getGroupItems(group: string): SettingsNavItem[] {
    return NAV_ITEMS.filter(i => i.group === group);
  }

  selectTab(tab: SettingsTab): void {
    this.activeTab.set(tab);
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { tab, section: tab === 'doctor' ? this.route.snapshot.queryParamMap.get('section') : null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
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
