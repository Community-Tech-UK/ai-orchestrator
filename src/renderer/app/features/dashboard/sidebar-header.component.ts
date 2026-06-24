/**
 * Sidebar Header Component
 *
 * Header of the wide session sidebar. Global navigation (history, settings,
 * tools) now lives in the workspace rail (copilot_todo.md item 6), so this
 * header is focused purely on the session list it sits above.
 */

import { ChangeDetectionStrategy, Component, output } from '@angular/core';

@Component({
  selector: 'app-sidebar-header',
  standalone: true,
  imports: [],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sidebar-header">
      <span class="sidebar-title">Sessions</span>
      <div class="sidebar-header-actions">
        <button
          class="btn-header-icon"
          (click)="newChatClicked.emit()"
          title="New chat"
          aria-label="Start a new chat"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path>
          </svg>
        </button>
        <button
          class="btn-header-icon btn-header-icon--primary"
          (click)="createClicked.emit()"
          title="New session (⌘N)"
          aria-label="Create a new session"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
      </div>
    </div>
  `,
  styleUrl: './sidebar-header.component.scss'
})
export class SidebarHeaderComponent {
  createClicked = output<void>();
  newChatClicked = output<void>();
}
