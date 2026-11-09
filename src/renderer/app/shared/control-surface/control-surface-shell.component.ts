import { AioTooltipDirective } from '../tooltip/aio-tooltip.directive';
import { AppIconButtonDirective } from '../tooltip/icon-button.directive';
import { ChangeDetectionStrategy, Component, DestroyRef, type ElementRef, computed, inject, signal, viewChild } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  ActivatedRoute,
  type ActivatedRouteSnapshot,
  NavigationEnd,
  Router,
  RouterLink,
  RouterOutlet,
} from '@angular/router';
import { filter, startWith } from 'rxjs';

import {
  getControlSurface,
  listControlNavGroups,
  tryGetControlSurface,
} from './control-surface.registry';
import type { ControlSurfaceId, ControlSurfaceItem } from './control-surface.types';
import { ControlSurfaceIconPipe } from './control-surface-icon.pipe';
import { searchControlNav } from './control-surface-search';
import { hubOfSurface, navigationHubs } from './navigation-hubs';
import { HelpPaneComponent } from '../help/help-pane.component';
import { CONTROL_SURFACE_HELP } from '../help/control-surface-help';
import { SettingsStore } from '../../core/state/settings.store';
import type { HelpEntry } from '../help/help-content.types';

/** localStorage key remembering whether the Control Center help pane is collapsed. */
const HELP_COLLAPSED_KEY = 'aiorch.control.helpCollapsed';
const NAV_COLLAPSED_KEY = 'aiorch.control.navCollapsed';

@Component({
  selector: 'app-control-surface-shell',
  standalone: true,
  imports: [RouterLink, RouterOutlet, HelpPaneComponent, AioTooltipDirective, AppIconButtonDirective, ControlSurfaceIconPipe],
  templateUrl: './control-surface-shell.component.html',
  styleUrl: './control-surface-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ControlSurfaceShellComponent {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  private readonly settings = inject(SettingsStore);
  protected readonly navGroups = computed(() => listControlNavGroups(this.settings.settings().observationMemoryEnabled));
  private readonly navSearchInput = viewChild<ElementRef<HTMLInputElement>>('navSearchInput');
  protected readonly navQuery = signal('');
  /** Null while the search box is empty, which shows the normal page list. */
  protected readonly navResults = computed(() => searchControlNav(this.navQuery(), this.navGroups()));
  protected readonly hubs = computed(() => navigationHubs(this.settings.settings().observationMemoryEnabled));
  private readonly activeSurfaceId = signal<ControlSurfaceId | null>(null);
  protected readonly activeSurface = computed<ControlSurfaceItem>(() => {
    const id = this.activeSurfaceId();
    return id ? getControlSurface(id) : getControlSurface('settings');
  });
  /** The hub holding the open page; its other pages show as tabs above the page. */
  protected readonly activeHub = computed(() => {
    const hubId = hubOfSurface(this.activeSurface().id)?.id;
    return this.hubs().find(hub => hub.id === hubId);
  });

  /** Whether the contextual help pane is collapsed to a thin rail. */
  protected readonly helpCollapsed = signal(this.readHelpCollapsed());
  protected readonly controlNavCollapsed = signal(this.readControlNavCollapsed());

  /** Help & tips content for the active surface. */
  protected readonly activeHelp = computed<HelpEntry>(
    () => CONTROL_SURFACE_HELP[this.activeSurface().id],
  );

  /**
   * The Settings page renders its own per-tab help pane, so the shell-level
   * pane is suppressed there to avoid showing two.
   */
  protected readonly showHelpPane = computed(() => this.activeSurface().id !== 'settings');

  protected readonly showControlNav = computed(() => this.activeSurface().id !== 'settings');

  constructor() {
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        startWith(null),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.activeSurfaceId.set(this.findActiveSurfaceId()));
  }

  protected backToDashboard(): void {
    void this.router.navigateByUrl(this.activeSurface().backRoute ?? '/');
  }

  protected onNavSearch(event: Event): void {
    this.navQuery.set((event.target as HTMLInputElement).value);
  }

  protected clearNavSearch(): void {
    this.navQuery.set('');
  }

  /** The chosen link leaves the page with the results, so keep keyboard focus in the column. */
  protected onNavResultChosen(): void {
    this.clearNavSearch();
    this.navSearchInput()?.nativeElement.focus();
  }

  protected onNavSearchEscape(event: Event): void {
    if (!this.navQuery()) return;
    event.stopPropagation();
    this.clearNavSearch();
  }

  /** Enter takes the best match, so a page or setting opens without leaving the keyboard. */
  protected openFirstNavResult(event: Event): void {
    const first = this.navResults()?.[0]?.results[0];
    if (!first || (event as KeyboardEvent).isComposing) return;
    void this.router.navigate([first.path], { queryParams: first.queryParams, fragment: first.fragment });
    this.clearNavSearch();
  }

  /** Toggle the help pane and remember the choice. */
  protected toggleHelp(): void {
    const collapsed = !this.helpCollapsed();
    this.helpCollapsed.set(collapsed);
    try {
      localStorage.setItem(HELP_COLLAPSED_KEY, String(collapsed));
    } catch {
      // Storage may be unavailable (private mode, quota); non-fatal.
    }
  }

  protected toggleControlNav(): void {
    const collapsed = !this.controlNavCollapsed();
    if (collapsed) this.clearNavSearch();
    this.controlNavCollapsed.set(collapsed);
    try {
      localStorage.setItem(NAV_COLLAPSED_KEY, String(collapsed));
    } catch {
      // Storage may be unavailable (private mode, quota); non-fatal.
    }
  }

  private readHelpCollapsed(): boolean {
    try {
      return localStorage.getItem(HELP_COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  }

  private readControlNavCollapsed(): boolean {
    try {
      return localStorage.getItem(NAV_COLLAPSED_KEY) === 'true';
    } catch {
      return false;
    }
  }

  private findActiveSurfaceId(): ControlSurfaceId | null {
    // The recognized snapshot tree is complete before the shell is constructed;
    // live child routes receive their snapshots only as their outlets activate.
    let current: ActivatedRouteSnapshot | null = this.route.snapshot;
    let lastId: ControlSurfaceId | null = null;

    while (current) {
      const value = current.data['controlSurfaceId'];
      if (typeof value === 'string' && tryGetControlSurface(value)) {
        lastId = value as ControlSurfaceId;
      }
      current = current.firstChild;
    }

    return lastId;
  }
}
