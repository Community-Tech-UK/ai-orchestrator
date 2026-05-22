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
  `,
  styleUrl: './sidebar-header.component.scss'
})
export class SidebarHeaderComponent {
  createClicked = output<void>();
}
