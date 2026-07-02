/**
 * Workspace Rail - a slim icon rail for global destinations.
 *
 * copilot_todo.md items 6 & 7: lifts global navigation out of the wide
 * session sidebar into a persistent, tooltip-first rail, and gives the
 * control plane a clear, always-visible entry point instead of hiding it
 * behind a "More…" affordance.
 */

import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { AutomationStore } from '../../core/state/automation.store';

@Component({
  selector: 'app-workspace-rail',
  standalone: true,
  imports: [RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <nav class="workspace-rail" aria-label="Workspace navigation">
      <div class="rail-section">
        <a
          class="rail-btn"
          routerLink="/chat-search"
          routerLinkActive="active"
          title="Search projects, sessions, and messages"
          aria-label="Search"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.8-3.8" />
          </svg>
        </a>

        <a
          class="rail-btn"
          routerLink="/automations"
          routerLinkActive="active"
          title="Scheduled and recurring agent runs"
          aria-label="Automations"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" />
          </svg>
          @if (unreadAutomations() > 0) {
            <span class="rail-badge">{{ unreadAutomations() > 99 ? '99+' : unreadAutomations() }}</span>
          }
        </a>

        <a
          class="rail-btn"
          routerLink="/browser"
          routerLinkActive="active"
          title="Managed Browser Gateway profiles"
          aria-label="Browser"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="4" width="18" height="14" rx="2" /><path d="M8 20h8" /><path d="M12 18v2" />
          </svg>
        </a>

        <a
          class="rail-btn"
          routerLink="/plugins"
          routerLinkActive="active"
          title="Manage installed plugins"
          aria-label="Plugins"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" />
            <rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" />
          </svg>
        </a>
      </div>

      <div class="rail-spacer"></div>

      <div class="rail-section">
        <button
          type="button"
          class="rail-btn"
          [class.active]="controlPlaneOpen()"
          [attr.aria-expanded]="controlPlaneOpen()"
          (click)="toggleControlPlane.emit()"
          title="Tools & Views"
          aria-label="Tools and Views"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" /><path d="M14 3v18" />
          </svg>
        </button>

        <button
          type="button"
          class="rail-btn"
          [class.active]="sideChatOpen()"
          [attr.aria-expanded]="sideChatOpen()"
          (click)="toggleSideChat.emit()"
          title="Side chat (⌥⌘S)"
          aria-label="Side chat"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            <path d="M13 3v18" />
          </svg>
        </button>

        <button
          type="button"
          class="rail-btn"
          (click)="historyClicked.emit()"
          title="Session history (⌘H)"
          aria-label="History"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7.5v5l4 2" />
          </svg>
        </button>

        <button
          type="button"
          class="rail-btn"
          (click)="settingsClicked.emit()"
          title="Settings (⌘,)"
          aria-label="Settings"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </nav>
  `,
  styleUrl: './workspace-rail.component.scss',
})
export class WorkspaceRailComponent {
  private readonly automationStore = inject(AutomationStore);

  /** Whether the control plane is currently open (drives the active state). */
  readonly controlPlaneOpen = input(false);
  /** Whether the side-chat panel is currently open (drives the active state). */
  readonly sideChatOpen = input(false);

  readonly toggleControlPlane = output<void>();
  readonly toggleSideChat = output<void>();
  readonly historyClicked = output<void>();
  readonly settingsClicked = output<void>();

  readonly unreadAutomations = this.automationStore.unreadCount;
}
