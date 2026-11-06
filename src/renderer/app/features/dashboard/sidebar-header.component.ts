/**
 * Sidebar Header Component
 *
 * Header of the wide session sidebar. Global navigation (history, settings,
 * tools) now lives in the workspace rail (copilot_todo.md item 6), so this
 * header is focused purely on the session list it sits above.
 */

import { ContextMenuComponent, type ContextMenuItem } from '../../shared/components/context-menu/context-menu.component';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';
import { ChangeDetectionStrategy, Component, output, signal } from '@angular/core';

@Component({
  selector: 'app-sidebar-header',
  standalone: true,
  imports: [ContextMenuComponent, AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sidebar-header">
      <span class="sidebar-title">Sessions</span>
      <div class="sidebar-header-actions">
        <button
          type="button" class="btn-header-icon btn-header-icon--primary"
          (click)="createClicked.emit()"
          [appTooltip]="newSessionTooltip"
          appTooltipShortcut="new-instance"
          aria-label="Create a new session"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
        </button>
        <button #menuTrigger type="button" class="btn-header-icon" aria-label="New session options" aria-haspopup="menu"
          [attr.aria-expanded]="menuOpen()" [appTooltip]="optionsTooltip" (click)="openMenu($event)">▾</button>
      </div>
    </div>
    <app-context-menu [items]="menuItems" [x]="menuX()" [y]="menuY()" [visible]="menuOpen()" [focusOnOpen]="true" [triggerElement]="menuTrigger" (closed)="closeMenu()" />
  `,
  styleUrl: './sidebar-header.component.scss'
})
export class SidebarHeaderComponent {
  readonly menuOpen = signal(false);
  readonly menuX = signal(0);
  readonly menuY = signal(0);
  readonly newSessionTooltip = copyFor('newSession');
  readonly optionsTooltip = copyFor('newSessionOptions');
  private opener: HTMLElement | null = null;
  readonly menuItems: ContextMenuItem[] = [{ label: 'Quick chat (no folder)', action: () => this.newChatClicked.emit() }];
  openMenu(event: MouseEvent): void {
    this.opener = event.currentTarget as HTMLElement;
    const rect = this.opener.getBoundingClientRect();
    this.menuX.set(rect.left); this.menuY.set(rect.bottom); this.menuOpen.set(!this.menuOpen());
  }
  closeMenu(): void { this.menuOpen.set(false); this.opener?.focus(); }
  createClicked = output<void>();
  newChatClicked = output<void>();
}
