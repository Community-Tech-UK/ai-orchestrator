/**
 * Sidebar Navigation Component
 * Collapsible navigation menu with grouped links to all feature pages
 */

import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal
} from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AutomationStore } from '../../core/state/automation.store';

interface NavItem {
  label: string;
  route: string;
  icon: string; // SVG path(s)
  viewBox?: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Connect',
    items: [
      {
        label: 'Discord & WhatsApp',
        route: '/channels',
        icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h8"/><path d="M8 14h4"/>'
      },
      {
        label: 'Remote Access',
        route: '/remote-access',
        icon: '<path d="M5 12a7 7 0 0 1 14 0"/><path d="M8 12a4 4 0 0 1 8 0"/><circle cx="12" cy="17" r="1"/>'
      },
      {
        label: 'Browser Gateway',
        route: '/browser',
        icon: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 20h8"/><path d="M12 18v2"/>'
      },
      {
        label: 'Instance Messaging',
        route: '/communication',
        icon: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="M22 6l-10 7L2 6"/>'
      }
    ]
  },
  {
    label: 'Agents',
    items: [
      {
        label: 'Automations',
        route: '/automations',
        icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'
      },
      {
        label: 'Workflows',
        route: '/workflows',
        icon: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'
      },
      {
        label: 'Agent Roles',
        route: '/specialists',
        icon: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'
      },
      {
        label: 'Debate Arena',
        route: '/debate',
        icon: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'
      },
      {
        label: 'Code Reviews',
        route: '/reviews',
        icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>'
      },
      {
        label: 'Verification',
        route: '/verification',
        icon: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="M22 4 12 14.01l-3-3"/>'
      },
      {
        label: 'Supervisor',
        route: '/supervision',
        icon: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4l3 3"/>'
      }
    ]
  },
  {
    label: 'Knowledge',
    items: [
      {
        label: 'Skills',
        route: '/skills',
        icon: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>'
      },
      {
        label: 'Memory Browser',
        route: '/memory',
        icon: '<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><path d="M22 6l-10 7L2 6"/>'
      },
      {
        label: 'Learning Database',
        route: '/rlm',
        icon: '<path d="M12 3l9 4.5v9L12 21 3 16.5v-9L12 3z"/><path d="M12 12l9-4.5"/><path d="M12 12L3 7.5"/><path d="M12 12v9"/>'
      },
      {
        label: 'Knowledge Graph',
        route: '/knowledge',
        icon: '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><line x1="8.5" y1="7.5" x2="15.5" y2="7.5"/><line x1="7" y1="8.5" x2="10.5" y2="16"/><line x1="17" y1="8.5" x2="13.5" y2="16"/>'
      },
      {
        label: 'Training Data',
        route: '/training',
        icon: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'
      },
      {
        label: 'Telemetry',
        route: '/observations',
        icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'
      }
    ]
  },
  {
    label: 'Code Tools',
    items: [
      {
        label: 'Editor',
        route: '/editor',
        icon: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/>'
      },
      {
        label: 'Multi-File Edit',
        route: '/multi-edit',
        icon: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>'
      },
      {
        label: 'Plan Mode',
        route: '/plan',
        icon: '<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><path d="M14 2v6h6"/>'
      },
      {
        label: 'Search Code',
        route: '/search',
        icon: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'
      },
      {
        label: 'Semantic Search',
        route: '/semantic-search',
        icon: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/><path d="M11 8v6"/><path d="M8 11h6"/>'
      },
      {
        label: 'Language Server',
        route: '/lsp',
        icon: '<path d="M16 18l6-6-6-6"/><path d="M8 6l-6 6 6 6"/>'
      },
      {
        label: 'Git',
        route: '/vcs',
        icon: '<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/><path d="M6 9a9 9 0 0 0 9 9"/>'
      },
      {
        label: 'Background Jobs',
        route: '/tasks',
        icon: '<path d="M3 4h18"/><path d="M8 4v16"/><path d="M16 8v12"/><path d="M12 12v8"/><rect x="3" y="4" width="18" height="16" rx="2"/>'
      }
    ]
  },
  {
    label: 'Monitor',
    items: [
      {
        label: 'Costs & Usage',
        route: '/cost',
        icon: '<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'
      },
      {
        label: 'Statistics',
        route: '/stats',
        icon: '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>'
      },
      {
        label: 'Logs',
        route: '/logs',
        icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/>'
      },
      {
        label: 'Replay',
        route: '/replay',
        icon: '<path d="M4 4v16"/><path d="M20 4v16"/><path d="M8 8l8 4-8 4z"/>'
      },
      {
        label: 'Security',
        route: '/security',
        icon: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'
      }
    ]
  }
];

@Component({
  selector: 'app-sidebar-nav',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sidebar-nav" [class.expanded]="expanded()">
      <button class="nav-toggle" (click)="expanded.set(!expanded())">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/>
          <rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/>
        </svg>
        <span class="toggle-label">Tools & Views</span>
        <svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      @if (expanded()) {
        <nav class="nav-menu" role="navigation" aria-label="Feature navigation">
          @for (group of groups; track group.label) {
            <div class="nav-group">
              <span class="group-label">{{ group.label }}</span>
              @for (item of group.items; track item.route) {
                <a class="nav-item"
                  [routerLink]="item.route"
                  routerLinkActive="active"
                  [title]="item.label">
                  <svg class="nav-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                    [innerHTML]="item.icon">
                  </svg>
                  <span class="nav-label">{{ item.label }}</span>
                  @if (item.route === '/automations' && unreadAutomations() > 0) {
                    <span class="nav-badge">{{ unreadAutomations() }}</span>
                  }
                </a>
              }
            </div>
          }
        </nav>
      }
    </div>
  `,
  styles: [`
    :host { display: block; }

    .sidebar-nav {
      border-top: 1px solid var(--border-subtle, rgba(255,255,255,0.06));
      margin-top: auto;
    }

    .nav-toggle {
      display: flex;
      align-items: center;
      gap: 5px;
      width: 100%;
      padding: 5px 12px;
      background: none;
      border: none;
      color: var(--text-muted, #9a9aa0);
      cursor: pointer;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      opacity: 0.7;
      transition: all 0.15s ease;

      &:hover {
        opacity: 1;
        color: var(--primary-color, #f59e0b);
        background: rgba(245, 158, 11, 0.04);
      }
    }

    .toggle-label { flex: 1; text-align: left; }

    .chevron {
      transition: transform 0.2s ease;
    }

    .expanded .chevron {
      transform: rotate(180deg);
    }

    .nav-menu {
      max-height: 45vh;
      overflow-y: auto;
      padding: 0 4px 8px;
      scrollbar-width: thin;
      scrollbar-color: var(--border-color, #2a2a2e) transparent;

      &::-webkit-scrollbar { width: 4px; }
      &::-webkit-scrollbar-track { background: transparent; }
      &::-webkit-scrollbar-thumb {
        background: var(--border-color, #2a2a2e);
        border-radius: 2px;
      }
    }

    .nav-group {
      margin-bottom: 4px;
    }

    .group-label {
      display: block;
      padding: 6px 8px 2px;
      font-size: 9px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted, #9a9aa0);
      opacity: 0.7;
    }

    .nav-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 8px;
      margin: 1px 0;
      border-radius: 4px;
      color: var(--text-secondary, #c4c4c9);
      text-decoration: none;
      font-size: 12px;
      transition: all 0.1s ease;
      cursor: pointer;

      &:hover {
        background: rgba(245, 158, 11, 0.06);
        color: var(--text-primary, #fafaf9);
      }

      &.active {
        background: rgba(245, 158, 11, 0.1);
        color: var(--primary-color, #f59e0b);

        .nav-icon { color: var(--primary-color, #f59e0b); }
      }
    }

    .nav-icon {
      flex-shrink: 0;
      color: var(--text-muted, #9a9aa0);
      transition: color 0.1s ease;
    }

    .nav-label {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .nav-badge {
      margin-left: auto;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border-radius: 999px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--warning-color, #f59e0b);
      color: #111;
      font-size: 10px;
      font-weight: 700;
    }
  `]
})
export class SidebarNavComponent {
  private readonly automationStore = inject(AutomationStore);
  readonly expanded = signal(true);
  readonly groups = NAV_GROUPS;
  readonly unreadAutomations = this.automationStore.unreadCount;
}
