import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  ActivatedRoute,
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { filter, startWith } from 'rxjs';

import {
  getControlSurface,
  listControlNavGroups,
  tryGetControlSurface,
} from './control-surface.registry';
import type { ControlSurfaceId, ControlSurfaceItem } from './control-surface.types';
import { HelpPaneComponent } from '../help/help-pane.component';
import { CONTROL_SURFACE_HELP } from '../help/control-surface-help';
import type { HelpEntry } from '../help/help-content.types';

/** localStorage key remembering whether the Control Center help pane is collapsed. */
const HELP_COLLAPSED_KEY = 'aiorch.control.helpCollapsed';
const NAV_COLLAPSED_KEY = 'aiorch.control.navCollapsed';

@Component({
  selector: 'app-control-surface-shell',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, HelpPaneComponent],
  templateUrl: './control-surface-shell.component.html',
  styleUrl: './control-surface-shell.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ControlSurfaceShellComponent {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly navGroups = listControlNavGroups();
  private readonly activeSurfaceId = signal<ControlSurfaceId | null>(null);
  protected readonly activeSurface = computed<ControlSurfaceItem>(() => {
    const id = this.activeSurfaceId();
    return id ? getControlSurface(id) : getControlSurface('settings');
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

  protected isExactNavMatch(path: string): boolean {
    return path !== '/campaigns' && path !== '/channels';
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
    let current: ActivatedRoute | null = this.route;
    let lastId: ControlSurfaceId | null = null;

    while (current) {
      const value = current.snapshot.data['controlSurfaceId'];
      if (typeof value === 'string' && tryGetControlSurface(value)) {
        lastId = value as ControlSurfaceId;
      }
      current = current.firstChild;
    }

    return lastId;
  }
}
