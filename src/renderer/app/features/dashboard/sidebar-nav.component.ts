/**
 * Sidebar Navigation Component
 * Collapsible navigation menu with grouped links to dashboard-visible surfaces.
 */

import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { AutomationStore } from '../../core/state/automation.store';
import { DocReviewStore } from '../doc-review/doc-review.store';
import { listDashboardNavGroups } from '../../shared/control-surface/control-surface-nav';

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
          @for (group of groups; track group.id) {
            <div class="nav-group">
              <span class="group-label">{{ group.label }}</span>
              @for (item of group.items; track item.id) {
                <a class="nav-item"
                  [routerLink]="item.path"
                  routerLinkActive="active"
                  [title]="item.label">
                  <svg class="nav-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                    [innerHTML]="item.icon">
                  </svg>
                  <span class="nav-label">{{ item.label }}</span>
                  @if (item.id === 'automations' && unreadAutomations() > 0) {
                    <span class="nav-badge">{{ unreadAutomations() }}</span>
                  }
                  @if (item.id === 'doc-review' && pendingDocReviews() > 0) {
                    <span class="nav-badge">{{ pendingDocReviews() }}</span>
                  }
                </a>
              }
            </div>
          }
        </nav>
      }
    </div>
  `,
  styleUrl: './sidebar-nav.component.scss',
})
export class SidebarNavComponent {
  private readonly automationStore = inject(AutomationStore);
  private readonly docReviewStore = inject(DocReviewStore);
  readonly expanded = signal(true);
  readonly groups = listDashboardNavGroups();
  readonly unreadAutomations = this.automationStore.unreadCount;
  readonly pendingDocReviews = this.docReviewStore.pendingCount;
}
