/**
 * Sidebar Navigation Component
 * Collapsible navigation menu with one link per hub. The hub's other pages are tabs inside the Control Center.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map } from 'rxjs';

import { SettingsStore } from '../../core/state/settings.store';
import { AutomationStore } from '../../core/state/automation.store';
import { DocReviewStore } from '../doc-review/doc-review.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { ControlSurfaceIconPipe } from '../../shared/control-surface/control-surface-icon.pipe';
import { hubIdOfUrl, navigationHubs } from '../../shared/control-surface/navigation-hubs';

@Component({
  selector: 'app-sidebar-nav',
  standalone: true,
  imports: [RouterLink, AioTooltipDirective, ControlSurfaceIconPipe],
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
          @for (hub of hubs(); track hub.id) {
            <a class="nav-item"
              [routerLink]="hub.path"
              [class.active]="hub.id === activeHubId()"
              [attr.aria-current]="hub.id === activeHubId() ? 'true' : null"
              [appTooltip]="hub.summary"
              [attr.aria-label]="hub.ariaLabel">
              <svg class="nav-icon" width="14" height="14" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
                [innerHTML]="hub.icon | controlSurfaceIcon">
              </svg>
              <span class="nav-label">{{ hub.label }}</span>
              @if (hub.badge) {
                <span class="nav-badge">{{ hub.badge }}</span>
              }
            </a>
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
  private readonly settings = inject(SettingsStore);
  private readonly router = inject(Router);
  /** The hub of the open page, so every page in a hub marks it, not only the one it opens on. */
  private readonly currentUrl = toSignal(
    this.router.events.pipe(filter(event => event instanceof NavigationEnd), map(event => event.urlAfterRedirects)),
    { initialValue: this.router.url },
  );
  readonly activeHubId = computed(() => hubIdOfUrl(this.currentUrl()));
  /**
   * One entry per hub with a page on the dashboard menu, opening on that page. A hub's count adds up the work
   * waiting in the pages it holds.
   */
  readonly hubs = computed(() => navigationHubs(this.settings.settings().observationMemoryEnabled).flatMap(hub => {
    const entry = hub.pages.find(page => page.showInDashboardNav);
    if (!entry) return [];
    const badge = hub.pages.reduce((count, page) => count + this.waitingOn(page.id), 0);
    // The visible count sits beside the label, so the spoken name carries it too.
    const ariaLabel = badge ? `${hub.label}, ${badge} waiting` : hub.label;
    return [{ ...hub, path: entry.path, badge, ariaLabel }];
  }));
  readonly unreadAutomations = this.automationStore.unreadCount;
  readonly pendingDocReviews = this.docReviewStore.pendingCount;

  private waitingOn(pageId: string): number {
    if (pageId === 'automations') return this.unreadAutomations();
    if (pageId === 'doc-review') return this.pendingDocReviews();
    return 0;
  }
}
