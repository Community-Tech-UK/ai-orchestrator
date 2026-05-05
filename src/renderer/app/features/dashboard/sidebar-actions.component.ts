import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

@Component({
  selector: 'app-sidebar-actions',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="sidebar-actions" aria-label="Workspace actions">
      <a
        class="action"
        routerLink="/chat-search"
        routerLinkActive="active"
        title="Search projects, sessions, and messages"
      >
        <svg class="action-icon" width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="11" cy="11" r="8"></circle>
          <path d="m21 21-4.3-4.3"></path>
        </svg>
        <span class="action-label">Search</span>
      </a>

      <a
        class="action"
        routerLink="/automations"
        routerLinkActive="active"
        title="Scheduled and recurring agent runs"
      >
        <svg class="action-icon" width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"></circle>
          <polyline points="12 6 12 12 16 14"></polyline>
        </svg>
        <span class="action-label">Automations</span>
      </a>

      <a
        class="action"
        routerLink="/browser"
        routerLinkActive="active"
        title="Managed Browser Gateway profiles"
      >
        <svg class="action-icon" width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="4" width="18" height="14" rx="2"></rect>
          <path d="M8 20h8"></path>
          <path d="M12 18v2"></path>
        </svg>
        <span class="action-label">Browser</span>
      </a>

      <a
        class="action"
        routerLink="/plugins"
        routerLinkActive="active"
        title="Manage installed plugins"
      >
        <svg class="action-icon" width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="7" height="7" rx="1.5"></rect>
          <rect x="14" y="3" width="7" height="7" rx="1.5"></rect>
          <rect x="3" y="14" width="7" height="7" rx="1.5"></rect>
          <rect x="14" y="14" width="7" height="7" rx="1.5"></rect>
        </svg>
        <span class="action-label">Plugins</span>
      </a>

      <button
        type="button"
        class="action"
        [class.active]="moreOpen()"
        (click)="moreClicked.emit()"
        [attr.aria-expanded]="moreOpen()"
        title="More tools and views"
      >
        <svg class="action-icon" width="16" height="16" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="5" cy="12" r="1.5"></circle>
          <circle cx="12" cy="12" r="1.5"></circle>
          <circle cx="19" cy="12" r="1.5"></circle>
        </svg>
        <span class="action-label">More…</span>
      </button>
    </nav>
  `,
  styles: [`
    :host { display: block; }

    .sidebar-actions {
      display: flex;
      flex-direction: column;
      padding: 8px 10px;
      gap: 2px;
      border-bottom: 1px solid var(--glass-border);
    }

    .action {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 8px 10px;
      border-radius: 8px;
      background: none;
      border: none;
      color: var(--text-secondary);
      text-decoration: none;
      font-size: 13px;
      cursor: pointer;
      width: 100%;
      text-align: left;
      transition: background var(--transition-fast), color var(--transition-fast);

      &:hover {
        background: var(--glass-light);
        color: var(--text-primary);
      }

      &.active {
        background: rgba(var(--primary-rgb), 0.12);
        color: var(--primary-color);

        .action-icon { color: var(--primary-color); }
      }
    }

    .action-icon {
      flex-shrink: 0;
      color: var(--text-muted);
      transition: color var(--transition-fast);
    }

    .action-label {
      flex: 1;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `],
})
export class SidebarActionsComponent {
  moreOpen = input(false);
  moreClicked = output<void>();
}
