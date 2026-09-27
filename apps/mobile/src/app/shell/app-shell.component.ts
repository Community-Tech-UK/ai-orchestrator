import { DestroyRef, ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { AppearanceService } from '../core/appearance.service';
import { connectionLabel } from '../core/connection-status';
import { GatewayClient } from '../core/gateway-client.service';
import { HostStore } from '../core/host-store';
import { DocReviewsComponent } from '../features/doc-review/doc-reviews.component';
import { HistoryComponent } from '../features/history/history.component';
import { LoopsComponent } from '../features/loops/loops.component';
import { PlanQueueComponent } from '../features/plan-queue/plan-queue.component';
import { SessionsComponent } from '../features/sessions/sessions.component';

export type ShellCompanion = 'sessions' | 'loops' | 'plan-queue' | 'reviews' | 'history';

export function companionForPath(path: string): ShellCompanion | null {
  const [pathname] = path.split('?');
  if (/^\/projects\/[^/]+\/sessions\/[^/]+$/.test(pathname)) return 'sessions';
  if (/^\/loops\/[^/]+$/.test(pathname)) return 'loops';
  if (/^\/plan-queue\/[^/]+$/.test(pathname)) return 'plan-queue';
  if (/^\/reviews\/[^/]+$/.test(pathname)) return 'reviews';
  if (/^\/history\/[^/]+$/.test(pathname)) return 'history';
  return null;
}

@Component({
  standalone: true,
  selector: 'app-shell',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterOutlet,
    SessionsComponent,
    LoopsComponent,
    PlanQueueComponent,
    DocReviewsComponent,
    HistoryComponent,
  ],
  host: { '(window:keydown)': 'onKey($event)' },
  template: `
    <div class="app-frame" [class.app-frame--split]="split()">
      @if (split() && companion(); as kind) {
        <aside class="app-frame__list">
          @switch (kind) {
            @case ('sessions') { <app-sessions [projectKey]="projectKey()" /> }
            @case ('loops') { <app-loops /> }
            @case ('plan-queue') { <app-plan-queue /> }
            @case ('reviews') { <app-doc-reviews /> }
            @case ('history') { <app-history /> }
          }
        </aside>
      }
      <div class="app-frame__stage">
        <router-outlet />
      </div>
      @if (split() && !companion()) {
        <p class="app-frame__empty">Select an item</p>
      }
    </div>
    <p class="sr-only" aria-live="polite">{{ connectionAnnouncement() }}</p>
  `,
})
export class AppShellComponent {
  private readonly router = inject(Router);
  private readonly gateway = inject(GatewayClient);
  private readonly hosts = inject(HostStore);
  private readonly appearance = inject(AppearanceService);
  protected readonly split = signal(false);
  private readonly url = signal(this.router.url);
  protected readonly connectionAnnouncement = signal('');
  private announcedConnection = '';

  protected readonly companion = computed(() => companionForPath(this.url()));
  protected readonly projectKey = computed(() => {
    const match = this.url().split('?')[0].match(/^\/projects\/([^/]+)\/sessions\/[^/]+$/);
    return match ? decodeURIComponent(match[1]) : '';
  });
  private readonly instanceId = computed(() => {
    const match = this.url().split('?')[0].match(/\/sessions\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : '';
  });

  constructor() {
    void this.appearance.preference();
    const media = window.matchMedia?.('(min-width: 768px)');
    const sync = () => this.split.set(!!media?.matches);
    sync();
    media?.addEventListener('change', sync);
    inject(DestroyRef).onDestroy(() => media?.removeEventListener('change', sync));
    effect(() => {
      const state = this.gateway.state?.();
      if (!state) return;
      const label = connectionLabel(state);
      if (!this.announcedConnection) {
        this.announcedConnection = label;
        return;
      }
      if (this.announcedConnection === label) return;
      this.announcedConnection = label;
      this.connectionAnnouncement.set(label);
    });
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      takeUntilDestroyed(),
    ).subscribe((event) => this.url.set(event.urlAfterRedirects));
  }

  protected onKey(event: KeyboardEvent): void {
    if (!this.split()) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    const typing = !!target?.closest('input, textarea, select, [contenteditable="true"]');
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n' && !typing) {
      event.preventDefault();
      void this.router.navigate(['/new-session']);
      return;
    }
    if (typing || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
    const path = this.router.url.split('?')[0];
    const key = decodeURIComponent(path.match(/^\/projects\/([^/]+)\/sessions\/[^/]+$/)?.[1] ?? '');
    const directory = key === '__no_workspace__' ? '' : key;
    const ids = (this.gateway.snapshot?.()?.instances ?? [])
      .filter((instance) => (instance.workingDirectory || '') === directory)
      .map((instance) => instance.id);
    if (!ids.length) return;
    const current = this.instanceId();
    const index = ids.indexOf(current);
    const nextIndex = event.key === 'ArrowDown'
      ? Math.min(ids.length - 1, index < 0 ? 0 : index + 1)
      : Math.max(0, index < 0 ? 0 : index - 1);
    const next = ids[nextIndex];
    if (!next || next === current) return;
    event.preventDefault();
    void this.router.navigate(['/projects', key || '__no_workspace__', 'sessions', next]);
  }
}
