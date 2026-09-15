import {
  afterRenderEffect,
  DestroyRef,
  effect,
  untracked,
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import { MobileBrowseStateStore } from '../../core/mobile-browse-state.store';
import { newSessionPresetState } from '../new-session/new-session.navigation';
import type { MobileHistorySessionDto } from '../../core/models';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import {
  MobileSessionRowComponent,
  type MobileSessionRowView,
} from '../../shared/mobile-session-row.component';

interface HistoryGroup {
  key: string;
  name: string;
  sessions: MobileHistorySessionDto[];
}

@Component({
  standalone: true,
  selector: 'app-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:scroll)': 'captureScroll()',
    '(window:wheel)': 'cancelScrollRestore()',
    '(window:touchmove)': 'cancelScrollRestore()',
    '(window:pointerdown)': 'cancelScrollRestore()',
    '(window:keydown)': 'onScrollKey($event)',
  },
  imports: [MobileHeaderComponent, MobileIconComponent, MobileSessionRowComponent],
  template: `
    <section class="history-screen">
      <app-mobile-header title="History">
        <button
          mobileHeaderLeading
          class="mobile-icon-button"
          type="button"
          (click)="back()"
          aria-label="Back to projects"
        >
          <app-mobile-icon name="chevron-left" />
        </button>
        <span mobileHeaderTrailing aria-hidden="true"></span>
      </app-mobile-header>

      <h1>History</h1>
      <label class="history-search">
        <app-mobile-icon name="search" />
        <input type="search" aria-label="Search history" placeholder="Search sessions or projects"
          [value]="query()" (input)="updateQuery($event)" />
      </label>

      @if (!online()) { <p class="history-state">{{ sessions().length ? 'Showing cached sessions. Connect to refresh history.' : 'Connect to the host to load history.' }}</p> }
      @if (loading()) { <p class="history-state" role="status">Loading sessions…</p> }
      @if (error()) {
        <div class="history-error" role="alert">{{ error() }}
          <button type="button" (click)="load()" [disabled]="loading()">Retry</button>
        </div>
      }
      @if (!loading() && !error() && groups().length === 0) {
        <div class="mobile-empty-state">
          <app-mobile-icon name="history" />
          <h2>{{ query().trim() ? 'No matching sessions' : 'No past sessions yet' }}</h2>
        </div>
      }
      @for (group of groups(); track group.key) {
        <section class="history-group" [attr.aria-labelledby]="'history-group-' + $index">
          <h2 [id]="'history-group-' + $index">{{ group.name }}</h2>
          @for (session of group.sessions; track session.id) {
            <app-mobile-session-row [row]="rowForSession(session)" (activate)="open(session)" />
          }
          @if (group.key !== '__no_workspace__') {
            <button class="history-new" type="button" (click)="newSession(group.key)" [disabled]="!online()">Start a new session in this project</button>
          }
        </section>
      }
    </section>
  `,
  styles: [
    `
      .history-screen { min-height: 100%; padding: var(--space-3) var(--mobile-gutter) var(--space-8); }
      h1 { margin: var(--space-8) 0 var(--space-5); font-size: var(--font-size-xl); }
      .history-group { margin-top: var(--space-6); }
      .history-group h2 { margin: 0 var(--space-3) var(--space-1); color: var(--text-secondary); font-size: var(--font-size-sm); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; }
      .history-state, .history-error { margin-top: var(--space-10); text-align: center; }
      .history-state { color: var(--text-secondary); }
      .history-error { color: var(--accent-error); }
      .mobile-empty-state > app-mobile-icon { color: var(--text-secondary); font-size: 2.5rem; }
      .mobile-empty-state h2 { margin: 0; }
      .history-search { display: flex; gap: var(--space-2); align-items: center; min-height: var(--control-size); border: 1px solid var(--separator); border-radius: var(--radius-md); padding: 0 var(--space-3); }
      .history-search input { min-width: 0; width: 100%; min-height: var(--control-size); border: 0; color: var(--text); background: transparent; font-size: 1rem; }
      .history-new, .history-error button { min-height: var(--control-size); border: 0; background: transparent; color: var(--accent-action); text-align: start; }

    `,
  ],
})
export class HistoryComponent implements OnInit {
  private readonly gateway = inject(GatewayClient);
  private readonly router = inject(Router);
  private readonly hosts = inject(HostStore);
  private readonly browse = inject(MobileBrowseStateStore);
  private currentHostId = this.hosts.activeHost()?.id ?? null;
  private readonly saved = this.browse.read('/history', this.currentHostId);
  private scrollTop = this.saved.scrollTop;
  private readonly restoreScrollPending = signal(true);
  private loadGeneration = 0;
  protected readonly query = signal(this.saved.query);
  protected readonly online = this.gateway.online;

  protected readonly sessions = signal<MobileHistorySessionDto[]>(this.gateway.dataHostId() === this.currentHostId ? this.gateway.historySessions() : []);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly groups = computed<HistoryGroup[]>(() => {
    const map = new Map<string, HistoryGroup>();
    for (const session of filterHistorySessions(this.sessions(), this.query())) {
      const key = session.workingDirectory || '__no_workspace__';
      let group = map.get(key);
      if (!group) {
        group = {
          key,
          name: session.workingDirectory ? session.projectName : 'No workspace',
          sessions: [],
        };
        map.set(key, group);
      }
      group.sessions.push(session);
    }
    return [...map.values()];
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.saveBrowse(); this.loadGeneration++; });
    effect(() => {
      const hostId = this.hosts.activeHost()?.id ?? null;
      if (hostId === this.currentHostId) return;
      untracked(() => {
        this.saveBrowse();
        this.currentHostId = hostId;
        const saved = this.browse.read('/history', hostId);
        this.query.set(saved.query);
        this.scrollTop = saved.scrollTop;
        this.restoreScrollPending.set(true);
        this.sessions.set([]);
        void this.load();
      });
    });
    afterRenderEffect(() => {
      if (!this.restoreScrollPending()) return;
      // Cached rows may render before the refresh that supplies the saved height.
      this.groups();
      const loading = this.loading();
      const scroller = document.scrollingElement ?? document.documentElement;
      const maxScroll = Math.max(0, scroller.scrollHeight - window.innerHeight);
      if (this.scrollTop > maxScroll + 1 && loading) return;
      this.restoreScrollPending.set(false);
      window.scrollTo({ top: this.scrollTop, behavior: 'instant' });
    });
  }

  async ngOnInit(): Promise<void> { await this.load(); }

  protected async load(): Promise<void> {
    const generation = ++this.loadGeneration;
    const hostId = this.currentHostId;
    this.loading.set(true);
    this.error.set(null);
    try {
      const sessions = await this.gateway.history();
      if (generation === this.loadGeneration && hostId === this.hosts.activeHost()?.id) this.sessions.set(sessions);
    } catch {
      if (generation === this.loadGeneration) this.error.set('History could not be refreshed. Check the host connection and try again.');
    } finally {
      if (generation === this.loadGeneration) this.loading.set(false);
    }
  }

  protected updateQuery(event: Event): void {
    this.cancelScrollRestore();
    this.query.set((event.target as HTMLInputElement).value);
  }
  protected captureScroll(): void { if (!this.restoreScrollPending()) this.scrollTop = window.scrollY; }
  protected cancelScrollRestore(): void {
    if (!this.restoreScrollPending()) return;
    this.restoreScrollPending.set(false);
    this.scrollTop = window.scrollY;
  }

  protected onScrollKey(event: KeyboardEvent): void {
    if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) return;
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    this.cancelScrollRestore();
  }
  private saveBrowse(): void {
    this.browse.save('/history', { ...this.browse.read('/history', this.currentHostId), query: this.query(), scrollTop: this.scrollTop }, this.currentHostId);
  }

  protected newSession(directory: string): void {
    void this.router.navigate(['/new-session'], {
      queryParams: { dir: directory },
      state: { ...this.browse.navigationState('/history'), ...newSessionPresetState(this.currentHostId, directory) },
    });
  }

  protected rowForSession(session: MobileHistorySessionDto): MobileSessionRowView {
    return {
      id: session.id,
      title: session.name,
      subtitle: [session.provider, session.model].filter(Boolean).join(' · '),
      statusLabel: session.live ? 'live' : session.archived ? 'archived' : 'history',
      tone: session.live ? 'idle' : 'history',
      unread: false,
      live: session.live,
      lastActivity: session.lastActiveAt,
    };
  }

  protected open(session: MobileHistorySessionDto): void {
    if (session.live && session.instanceId) {
      const key = session.workingDirectory || '__no_workspace__';
      this.saveBrowse();
      void this.router.navigate(['/projects', key, 'sessions', session.instanceId], { state: this.browse.navigationState('/history') });
    } else {
      this.saveBrowse();
      void this.router.navigate(['/history', session.id], { state: this.browse.navigationState('/history') });
    }
  }

  protected back(): void {
    void this.router.navigate(['/projects']);
  }
}

export function filterHistorySessions(sessions: MobileHistorySessionDto[], query: string): MobileHistorySessionDto[] {
  const value = query.trim().toLocaleLowerCase();
  return value ? sessions.filter((session) => [session.name, session.projectName, session.workingDirectory, session.provider, session.model].some((part) => part?.toLocaleLowerCase().includes(value))) : sessions;
}
