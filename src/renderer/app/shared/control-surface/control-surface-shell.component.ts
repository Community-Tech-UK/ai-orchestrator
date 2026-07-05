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

@Component({
  selector: 'app-control-surface-shell',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
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
