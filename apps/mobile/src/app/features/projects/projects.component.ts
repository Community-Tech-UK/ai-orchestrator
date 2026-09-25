import {
  afterRenderEffect,
  untracked,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import {
  connectionHelpText,
  connectionLabel,
  offlineBannerText,
} from '../../core/connection-status';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import { MobileBrowseStateStore } from '../../core/mobile-browse-state.store';
import { newSessionPresetState } from '../new-session/new-session.navigation';
import { ApprovalPresentationStore } from '../../core/approval-presentation.store';
import type { MobileRecentDirDto } from '../../core/models';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import {
  MobileSessionRowComponent,
  type MobileSessionRowView,
} from '../../shared/mobile-session-row.component';
import {
  buildProjectGroups,
  filterProjectGroups,
  flattenChronologicalSessions,
  initialExpandedProjectKeys,
  newSessionNavigation,
  projectComposeAriaLabel,
  projectSummary,
  projectParentLabel,
  projectSessionPreview,
  reconcileProjectGroupUpdate,
  releasePendingProjectGroups,
  sessionTargetRoute,
  toggleExpandedProjectKey,
  type NavigationTarget,
  type ProjectListGroup,
  type SessionStateFilter,
} from './project-list.view-model';

type OrganizeMode = 'project' | 'chronological';

export function projectsEmptyStateTitle(
  stateFilter: SessionStateFilter,
  query: string,
  mode: OrganizeMode = 'project',
): string {
  if (stateFilter === 'attention') return 'Nothing needs attention';
  if (stateFilter === 'active') return 'No active sessions';
  if (query.trim()) return 'No matching sessions';
  return mode === 'project' ? 'No projects yet' : 'No sessions yet';
}

@Component({
  standalone: true,
  selector: 'app-projects',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '(window:scroll)': 'captureScroll()',
    '(window:wheel)': 'cancelScrollRestore()',
    '(window:touchmove)': 'cancelScrollRestore()',
    '(window:pointerdown)': 'cancelScrollRestore()',
    '(window:keydown)': 'onScrollKey($event)',
  },
  imports: [
    MobileHeaderComponent,
    MobileIconComponent,
    MobileSessionRowComponent,
  ],
  template: `
    <section class="projects-screen">
      <app-mobile-header
        title="Harness"
        [subtitle]="hostSubtitle()"
        [statusColor]="connectionColor()"
      >
        <button
          mobileHeaderLeading
          class="mobile-icon-button"
          type="button"
          (click)="toHosts()"
          aria-label="Hosts"
        >
          <app-mobile-icon name="menu" />
        </button>
        <button
          mobileHeaderTrailing
          class="mobile-icon-button"
          type="button"
          (click)="menuOpen.set(!menuOpen())"
          aria-label="More options"
          [attr.aria-expanded]="menuOpen()"
        >
          <app-mobile-icon name="more" />
        </button>
      </app-mobile-header>

      @if (menuOpen()) {
        <button
          class="projects-menu__scrim"
          type="button"
          aria-label="Close options"
          (click)="menuOpen.set(false)"
        ></button>
        <aside class="projects-menu" aria-label="Project options">
          <span class="projects-menu__caption">Organize</span>
          <button type="button" (click)="setMode('project')">
            <span class="projects-menu__icon">
              @if (mode() === 'project') { <app-mobile-icon name="check" /> }
            </span>
            <app-mobile-icon name="folder" />
            <span>By project</span>
          </button>
          <button type="button" (click)="setMode('chronological')">
            <span class="projects-menu__icon">
              @if (mode() === 'chronological') { <app-mobile-icon name="check" /> }
            </span>
            <app-mobile-icon name="history" />
            <span>Chronological</span>
          </button>

          <span class="projects-menu__separator"></span>
          <span class="projects-menu__caption">Manage</span>
          @if (promptCount() > 0) {
            <button type="button" class="projects-menu__attention" (click)="openFirstPrompt()">
              <span class="projects-menu__icon"></span>
              <app-mobile-icon name="warning" />
              <span>{{ promptCount() }} awaiting approval</span>
            </button>
          }
          <button type="button" (click)="togglePause()" [disabled]="!online() || pausePending()">
            <span class="projects-menu__icon"></span>
            <app-mobile-icon [name]="paused() ? 'play' : 'pause'" />
            <span>{{ pausePending() ? 'Updating…' : paused() ? 'Resume agents' : 'Pause agents' }}</span>
          </button>
          <button type="button" (click)="openHistory()">
            <span class="projects-menu__icon"></span>
            <app-mobile-icon name="history" />
            <span>History</span>
          </button>
          <button type="button" (click)="toHosts()">
            <span class="projects-menu__icon"></span>
            <app-mobile-icon name="host" />
            <span>Hosts</span>
          </button>
        </aside>
      }

      <div class="projects-heading">
        <h1 class="projects-title">{{ mode() === 'project' ? 'Projects' : 'Sessions' }}</h1>
        <div class="projects-state-filter" role="group" aria-label="Filter sessions by state">
          <button
            type="button"
            class="projects-state-filter__button"
            [class.projects-state-filter__button--active]="stateFilter() === 'all'"
            [attr.aria-pressed]="stateFilter() === 'all'"
            (click)="setStateFilter('all')"
          >
            All
          </button>
          <button
            type="button"
            class="projects-state-filter__button"
            [class.projects-state-filter__button--active]="stateFilter() === 'active'"
            [attr.aria-pressed]="stateFilter() === 'active'"
            (click)="setStateFilter('active')"
          >
            Active
          </button>
          <button type="button" class="projects-state-filter__button"
            [class.projects-state-filter__button--active]="stateFilter() === 'attention'"
            [attr.aria-pressed]="stateFilter() === 'attention'" (click)="setStateFilter('attention')">
            Needs attention
          </button>
        </div>
      </div>

      @if (promptCount() > 0) {
        <button type="button" class="projects-needs-you" (click)="openFirstPrompt()">
          <app-mobile-icon name="warning" />
          <span>Needs you · {{ promptCount() }} {{ promptCount() === 1 ? 'request' : 'requests' }}</span>
          <app-mobile-icon class="needs-you-caret" name="chevron-down" />
        </button>
      }
      @if (pausePending()) { <p class="projects-feedback" role="status">Waiting for the host to {{ paused() ? 'resume' : 'pause' }} agents…</p> }
      @if (pauseError()) {
        <div class="projects-feedback" role="alert">{{ pauseError() }}
          <button type="button" (click)="togglePause()" [disabled]="!online() || pausePending()">Retry</button>
        </div>
      }
      @if (directoryError()) {
        <div class="projects-feedback" role="status">Recent folders could not be loaded.
          <button type="button" (click)="loadDirectories()" [disabled]="directoryLoading() || !online()">Retry</button>
        </div>
      }
      @if (historyState().status === 'error') {
        <div class="projects-feedback" role="status">Past sessions could not be refreshed.
          <button type="button" (click)="retryHistory()" [disabled]="!online()">Retry</button>
        </div>
      }
      @if (online() && renderedGroups().length === 0 && (directoryLoading() || historyState().status === 'loading')) {
        <p class="projects-feedback" role="status">Loading projects and sessions…</p>
      } @else if (!online() && renderedGroups().length === 0) {
        <div class="mobile-empty-state projects-empty">
          <app-mobile-icon name="host" />
          <h2>Connection unavailable</h2>
          <p>{{ connectionHelp() }}</p>
          <button class="mobile-primary-button" type="button" (click)="toHosts()">Manage hosts</button>
        </div>
      } @else {
        @if (!online()) {
          <p id="projects-offline-help" class="projects-offline">{{ offlineBanner() }}</p>
        }

        @if (mode() === 'project') {
          <div class="project-list">
            @for (group of visibleGroups(); track group.project.key) {
              <article
                class="project-group"
                (pointerdown)="beginRowPress()"
                (pointerup)="scheduleRowPressRelease()"
                (pointercancel)="releaseRowPress()"
              >
                <div class="project-row">
                  <button
                    type="button"
                    class="project-disclosure mobile-pressable"
                    (click)="toggleProject(group.project.key); releaseRowPress()"
                    [attr.aria-expanded]="isExpanded(group.project.key)"
                  >
                    <app-mobile-icon name="folder" />
                    <span class="project-identity">
                      <span class="project-name">{{ group.project.name }}</span>
                      @if (projectParentLabel(group, renderedGroups()); as parent) { <span class="project-summary">{{ parent }}</span> }
                      @if (projectSummary(group); as summary) { <span class="project-summary">{{ summary }}</span> }
                    </span>
                    <span class="project-caret" [class.project-caret--open]="isExpanded(group.project.key)">
                      <app-mobile-icon name="chevron-down" />
                    </span>
                  </button>
                  <button
                    type="button"
                    class="project-compose mobile-icon-button"
                    (click)="newSessionInProject(group.project.path, $event)"
                    [disabled]="!online()"
                    [attr.aria-label]="projectComposeAriaLabel(group.project)"
                    [attr.aria-describedby]="!online() ? 'projects-offline-help' : null"
                  >
                    <app-mobile-icon name="compose" />
                  </button>
                </div>

                @if (isExpanded(group.project.key) || searchQuery().trim()) {
                  <div class="project-sessions">
                    @for (session of previewSessions(group); track session.id) {
                      <app-mobile-session-row
                        [row]="session"
                        [nested]="true"
                        [showSubtitle]="distinctProviders(group)"
                        (activate)="openSession(group.project.key, session)"
                      />
                    } @empty {
                      <p class="project-empty">No sessions yet</p>
                    }
                    @if (previewSessions(group).length < group.sessions.length) {
                      <button class="project-show-all" type="button" (click)="showAll(group.project.key); releaseRowPress()">Show all {{ group.sessions.length }} sessions</button>
                    }
                  </div>
                }
              </article>
            } @empty {
              <div class="mobile-empty-state projects-empty">
                <app-mobile-icon name="folder" />
                <h2>{{ projectsEmptyStateTitle(stateFilter(), searchQuery(), mode()) }}</h2>
                <p>
                  @if (stateFilter() === 'active') {
                    Switch to All to see past and inactive sessions.
                  } @else if (searchQuery().trim()) {
                    Try a project, session, provider, or model name.
                  } @else {
                    Start a session to add work from this host.
                  }
                </p>
              </div>
            }
          </div>
        } @else {
          <div class="chronological-list" (pointerdown)="beginRowPress()" (pointerup)="scheduleRowPressRelease()" (pointercancel)="releaseRowPress()">
            @for (session of chronologicalRows(); track session.id) {
              <app-mobile-session-row [row]="session" (activate)="openChronologicalSession(session)" />
            } @empty {
              <div class="mobile-empty-state projects-empty">
                <app-mobile-icon name="history" />
                <h2>{{ projectsEmptyStateTitle(stateFilter(), searchQuery(), mode()) }}</h2>
                @if (stateFilter() === 'active') {
                  <p>Switch to All to see past and inactive sessions.</p>
                }
              </div>
            }
          </div>
        }
      }

      <div class="mobile-bottom-dock">
        <label class="projects-search">
          <app-mobile-icon name="search" />
          <input
            type="search"
            aria-label="Search sessions"
            placeholder="Search Sessions"
            [value]="searchQuery()"
            (input)="updateSearch($event)"
          />
        </label>
        <button
          type="button"
          class="projects-new mobile-primary-button"
          (click)="newSession()"
          [disabled]="!online()"
          [attr.aria-describedby]="!online() ? 'projects-offline-help' : null"
        >
          <app-mobile-icon name="compose" />
          New
        </button>
      </div>
    </section>
  `,
  styleUrls: ['./projects.component.scss'],
})
export class ProjectsComponent implements OnInit {
  private readonly gateway = inject(GatewayClient);
  private readonly hostStore = inject(HostStore);
  private readonly router = inject(Router);
  private readonly browse = inject(MobileBrowseStateStore);
  private readonly approvals = inject(ApprovalPresentationStore);
  private currentHostId = this.hostStore.activeHost()?.id ?? null;
  private readonly saved = this.browse.read('/projects', this.currentHostId);
  private scrollTop = this.saved.scrollTop;
  private readonly restoreScrollPending = signal(true);

  protected readonly state = this.gateway.state;
  protected readonly historyState = this.gateway.historyState;
  protected readonly online = this.gateway.online;
  protected readonly mode = signal<OrganizeMode>(this.saved.mode);
  protected readonly stateFilter = signal<SessionStateFilter>(this.saved.filter);
  protected readonly menuOpen = signal(false);
  protected readonly searchQuery = signal(this.saved.query);
  protected readonly recentDirs = signal<MobileRecentDirDto[]>([]);
  protected readonly expandedProjectKeys = signal<Set<string>>(new Set(this.saved.expandedKeys ?? []));
  protected readonly renderedGroups = signal<ProjectListGroup[]>([]);
  protected readonly rowPressActive = signal(false);
  private readonly pendingGroups = signal<ProjectListGroup[] | null>(null);
  protected readonly showAllKeys = signal(new Set(this.saved.showAllKeys));
  protected readonly pausePending = signal(false);
  protected readonly pauseError = signal<string | null>(null);
  protected readonly directoryLoading = signal(false);
  protected readonly directoryError = signal(false);
  private requestGeneration = 0;
  private pauseGeneration = 0;
  private initialDisclosureApplied = this.saved.expandedKeys !== null;
  private rowPressReleaseTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now = signal(Date.now());
  private readonly freshnessTimer = setInterval(() => this.now.set(Date.now()), 1000);

  private readonly sourceGroups = computed(() =>
    this.gateway.dataHostId() !== (this.hostStore.activeHost()?.id ?? null) ? [] : buildProjectGroups(
      this.gateway.snapshot()?.projects ?? [],
      this.gateway.snapshot()?.instances ?? [],
      this.gateway.historySessions(),
      this.recentDirs(),
    ),
  );
  protected readonly visibleGroups = computed(() =>
    filterProjectGroups(this.renderedGroups(), this.searchQuery(), this.stateFilter()),
  );
  protected readonly chronologicalRows = computed(() =>
    flattenChronologicalSessions(this.visibleGroups()),
  );
  private heldPromptCount = 0;
  protected readonly promptCount = computed(() => this.rowPressActive() ? this.heldPromptCount : this.approvals.requests().length);
  protected readonly paused = computed(() => this.gateway.pause().isPaused);
  protected readonly hostName = computed(
    () => this.gateway.snapshot()?.hostName ?? this.hostStore.activeHost()?.name ?? 'Host',
  );
  protected readonly hostSubtitle = computed(() =>
    this.online() ? this.hostName() : `${this.hostName()} · ${connectionLabel(this.state())}`,
  );
  protected readonly connectionHelp = computed(() => connectionHelpText(this.state()));
  protected readonly offlineBanner = computed(() =>
    offlineBannerText(this.state(), this.gateway.lastServerFrameAt(), this.now()),
  );
  protected readonly connectionColor = computed(() =>
    this.online() ? 'var(--accent-online)' : 'var(--text-secondary)',
  );
  protected readonly projectComposeAriaLabel = projectComposeAriaLabel;
  protected readonly projectSummary = projectSummary;
  protected readonly projectParentLabel = projectParentLabel;
  protected readonly projectsEmptyStateTitle = projectsEmptyStateTitle;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.saveBrowse();
      this.requestGeneration++;
      this.pauseGeneration++;
      if (this.rowPressReleaseTimer) clearTimeout(this.rowPressReleaseTimer);
      clearInterval(this.freshnessTimer);
    });

    effect(() => {
      const hostId = this.hostStore.activeHost()?.id ?? null;
      if (hostId === this.currentHostId) return;
      untracked(() => {
        this.saveBrowse();
        this.currentHostId = hostId;
        const saved = this.browse.read('/projects', hostId);
        this.searchQuery.set(saved.query);
        this.stateFilter.set(saved.filter);
        this.mode.set(saved.mode);
        this.expandedProjectKeys.set(new Set(saved.expandedKeys ?? []));
        this.showAllKeys.set(new Set(saved.showAllKeys));
        this.initialDisclosureApplied = saved.expandedKeys !== null;
        this.scrollTop = saved.scrollTop;
        this.restoreScrollPending.set(true);
        this.recentDirs.set([]);
        this.renderedGroups.set([]);
        this.pendingGroups.set(null);
        this.rowPressActive.set(false);
        this.menuOpen.set(false);
        this.pauseGeneration++;
        this.pausePending.set(false);
        this.pauseError.set(null);
        void this.loadDirectories();
      });
    });

    afterRenderEffect(() => {
      if (!this.restoreScrollPending()) return;
      // Recheck geometry after asynchronous rows have actually rendered.
      this.renderedGroups();
      const loadsPending = this.directoryLoading()
        || this.historyState().status === 'loading'
        || this.state() === 'connecting'
        || (this.online() && !this.gateway.snapshot());
      const scroller = document.scrollingElement ?? document.documentElement;
      const maxScroll = Math.max(0, scroller.scrollHeight - window.innerHeight);
      if (this.scrollTop > maxScroll + 1 && loadsPending) return;
      this.restoreScrollPending.set(false);
      window.scrollTo({ top: this.scrollTop, behavior: 'instant' });
    });

    effect(() => {
      const incoming = this.sourceGroups();
      const next = reconcileProjectGroupUpdate(
        this.renderedGroups(),
        this.pendingGroups(),
        incoming,
        this.rowPressActive(),
      );
      if (next.rendered !== this.renderedGroups()) this.renderedGroups.set(next.rendered);
      if (next.pending !== this.pendingGroups()) this.pendingGroups.set(next.pending);
      if (!this.initialDisclosureApplied && incoming.length > 0) {
        this.initialDisclosureApplied = true;
        this.expandedProjectKeys.set(initialExpandedProjectKeys(incoming));
      }
    });
  }

  async ngOnInit(): Promise<void> {
    await this.loadDirectories();
  }

  protected async loadDirectories(): Promise<void> {
    const generation = ++this.requestGeneration;
    const hostId = this.currentHostId;
    this.directoryLoading.set(true);
    this.directoryError.set(false);
    try {
      const directories = await this.gateway.recentDirs();
      if (generation === this.requestGeneration && hostId === this.hostStore.activeHost()?.id) this.recentDirs.set(directories);
    } catch {
      if (generation === this.requestGeneration) this.directoryError.set(true);
    } finally {
      if (generation === this.requestGeneration) this.directoryLoading.set(false);
    }
  }

  protected captureScroll(): void {
    if (!this.restoreScrollPending()) this.scrollTop = window.scrollY;
  }

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
    this.browse.save('/projects', {
      query: this.searchQuery(), filter: this.stateFilter(), mode: this.mode(),
      expandedKeys: this.initialDisclosureApplied ? [...this.expandedProjectKeys()] : null,
      showAllKeys: [...this.showAllKeys()], scrollTop: this.scrollTop,
    }, this.currentHostId);
  }

  protected distinctProviders(group: ProjectListGroup): boolean {
    return new Set(group.sessions.map((session) => session.subtitle)).size > 1;
  }

  protected previewSessions(group: ProjectListGroup) {
    return projectSessionPreview(group, this.searchQuery(), this.showAllKeys().has(group.project.key));
  }

  protected showAll(key: string): void {
    this.showAllKeys.update((keys) => new Set(keys).add(key));
  }

  protected retryHistory(): void { void this.gateway.loadHistory(); }

  protected isExpanded(key: string): boolean {
    return this.expandedProjectKeys().has(key);
  }

  protected toggleProject(key: string): void {
    this.expandedProjectKeys.set(toggleExpandedProjectKey(this.expandedProjectKeys(), key));
  }

  protected beginRowPress(): void {
    if (this.rowPressReleaseTimer) {
      clearTimeout(this.rowPressReleaseTimer);
      this.rowPressReleaseTimer = null;
    }
    this.heldPromptCount = this.approvals.requests().length;
    this.rowPressActive.set(true);
  }

  protected scheduleRowPressRelease(): void {
    if (this.rowPressReleaseTimer) return;
    this.rowPressReleaseTimer = setTimeout(() => {
      this.rowPressReleaseTimer = null;
      this.releaseRowPress();
    }, 0);
  }

  protected releaseRowPress(): void {
    if (this.rowPressReleaseTimer) {
      clearTimeout(this.rowPressReleaseTimer);
      this.rowPressReleaseTimer = null;
    }
    this.rowPressActive.set(false);
    this.renderedGroups.set(
      releasePendingProjectGroups(this.renderedGroups(), this.pendingGroups()),
    );
    this.pendingGroups.set(null);
  }

  protected updateSearch(event: Event): void {
    this.searchQuery.set((event.target as HTMLInputElement).value);
  }

  protected setStateFilter(filter: SessionStateFilter): void {
    this.stateFilter.set(filter);
  }

  protected setMode(mode: OrganizeMode): void {
    this.mode.set(mode);
    this.menuOpen.set(false);
  }

  protected async togglePause(): Promise<void> {
    if (this.pausePending() || !this.online()) return;
    const generation = ++this.pauseGeneration;
    const target = !this.paused();
    this.pausePending.set(true);
    this.pauseError.set(null);
    try {
      await this.gateway.setPause(target);
      if (generation === this.pauseGeneration) this.menuOpen.set(false);
    } catch {
      if (generation === this.pauseGeneration) this.pauseError.set(`Could not ${target ? 'pause' : 'resume'} agents. Check the host connection and try again.`);
    } finally {
      if (generation === this.pauseGeneration) this.pausePending.set(false);
    }
  }

  protected toHosts(): void {
    this.menuOpen.set(false);
    void this.router.navigate(['/']);
  }

  protected openHistory(): void {
    this.menuOpen.set(false);
    void this.router.navigate(['/history']);
  }

  protected openFirstPrompt(): void {
    this.menuOpen.set(false);
    this.approvals.open();
  }

  protected openSession(projectKey: string, session: MobileSessionRowView): void {
    this.releaseRowPress();
    this.saveBrowse();
    void this.router.navigate(sessionTargetRoute(projectKey, session), { state: this.browse.navigationState('/projects') });
  }

  protected openChronologicalSession(session: MobileSessionRowView): void {
    const project = this.renderedGroups().find((group) =>
      group.sessions.some((candidate) => candidate.id === session.id && candidate.live === session.live),
    );
    if (project) this.openSession(project.project.key, session);
  }

  protected newSessionInProject(path: string, event: Event): void {
    this.releaseRowPress();
    event.stopPropagation();
    this.navigateToNewSession(newSessionNavigation(path || undefined));
  }

  protected newSession(): void {
    this.navigateToNewSession(newSessionNavigation());
  }

  private navigateToNewSession(target: NavigationTarget): void {
    const state = {
      ...this.browse.navigationState('/projects'),
      ...newSessionPresetState(this.currentHostId, target.queryParams?.dir),
    };
    if (target.queryParams) {
      void this.router.navigate(target.commands, { queryParams: target.queryParams, state });
      return;
    }
    void this.router.navigate(target.commands, { state });
  }
}
