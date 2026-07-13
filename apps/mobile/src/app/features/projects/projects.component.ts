import {
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
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
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
  reconcileProjectGroupUpdate,
  releasePendingProjectGroups,
  sessionTargetRoute,
  toggleExpandedProjectKey,
  type NavigationTarget,
  type ProjectListGroup,
} from './project-list.view-model';

type OrganizeMode = 'project' | 'chronological';

@Component({
  standalone: true,
  selector: 'app-projects',
  changeDetection: ChangeDetectionStrategy.OnPush,
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
          <button type="button" (click)="togglePause()" [disabled]="!online()">
            <span class="projects-menu__icon"></span>
            <app-mobile-icon [name]="paused() ? 'play' : 'pause'" />
            <span>{{ paused() ? 'Resume agents' : 'Pause agents' }}</span>
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

      <h1 class="projects-title">{{ mode() === 'project' ? 'Projects' : 'Sessions' }}</h1>

      @if (!online() && renderedGroups().length === 0) {
        <div class="mobile-empty-state projects-empty">
          <app-mobile-icon name="host" />
          <h2>Connection unavailable</h2>
          <p>{{ state() === 'connecting' ? 'Connecting to the selected host.' : 'Reconnect to Tailscale or choose another host.' }}</p>
          <button class="mobile-primary-button" type="button" (click)="toHosts()">Manage hosts</button>
        </div>
      } @else {
        @if (!online()) {
          <p id="projects-offline-help" class="projects-offline">
            Offline. Cached sessions remain available; reconnect to start new work.
          </p>
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
                    <span class="project-name">{{ group.project.name }}</span>
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
                    @for (session of group.sessions; track session.id) {
                      <app-mobile-session-row
                        [row]="session"
                        (activate)="openSession(group.project.key, session)"
                      />
                    } @empty {
                      <p class="project-empty">No sessions yet</p>
                    }
                  </div>
                }
              </article>
            } @empty {
              <div class="mobile-empty-state projects-empty">
                <app-mobile-icon name="folder" />
                <h2>{{ searchQuery().trim() ? 'No matching sessions' : 'No projects yet' }}</h2>
                <p>{{ searchQuery().trim() ? 'Try a project, session, provider, or model name.' : 'Start a session to add work from this host.' }}</p>
              </div>
            }
          </div>
        } @else {
          <div class="chronological-list">
            @for (session of chronologicalRows(); track session.id) {
              <app-mobile-session-row [row]="session" (activate)="openChronologicalSession(session)" />
            } @empty {
              <div class="mobile-empty-state projects-empty">
                <app-mobile-icon name="history" />
                <h2>No sessions yet</h2>
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

  protected readonly state = this.gateway.state;
  protected readonly online = this.gateway.online;
  protected readonly mode = signal<OrganizeMode>('project');
  protected readonly menuOpen = signal(false);
  protected readonly searchQuery = signal('');
  protected readonly recentDirs = signal<MobileRecentDirDto[]>([]);
  protected readonly expandedProjectKeys = signal<Set<string>>(new Set());
  protected readonly renderedGroups = signal<ProjectListGroup[]>([]);
  protected readonly rowPressActive = signal(false);
  private readonly pendingGroups = signal<ProjectListGroup[] | null>(null);
  private initialDisclosureApplied = false;
  private rowPressReleaseTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly sourceGroups = computed(() =>
    buildProjectGroups(
      this.gateway.snapshot()?.projects ?? [],
      this.gateway.snapshot()?.instances ?? [],
      this.gateway.historySessions(),
      this.recentDirs(),
    ),
  );
  protected readonly visibleGroups = computed(() =>
    filterProjectGroups(this.renderedGroups(), this.searchQuery()),
  );
  protected readonly chronologicalRows = computed(() =>
    flattenChronologicalSessions(
      filterProjectGroups(this.renderedGroups(), this.searchQuery()),
    ),
  );
  protected readonly promptCount = computed(() => this.gateway.prompts().length);
  protected readonly paused = computed(() => this.gateway.pause().isPaused);
  protected readonly hostName = computed(
    () => this.gateway.snapshot()?.hostName ?? this.hostStore.activeHost()?.name ?? 'Host',
  );
  protected readonly hostSubtitle = computed(() =>
    this.online() ? this.hostName() : `${this.hostName()} · ${this.state()}`,
  );
  protected readonly connectionColor = computed(() =>
    this.online() ? 'var(--accent-online)' : 'var(--text-secondary)',
  );
  protected readonly projectComposeAriaLabel = projectComposeAriaLabel;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      if (this.rowPressReleaseTimer) clearTimeout(this.rowPressReleaseTimer);
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
    try {
      this.recentDirs.set(await this.gateway.recentDirs());
    } catch {
      /* Live and persisted projects still render without recent directories. */
    }
  }

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

  protected setMode(mode: OrganizeMode): void {
    this.mode.set(mode);
    this.menuOpen.set(false);
  }

  protected async togglePause(): Promise<void> {
    this.menuOpen.set(false);
    try {
      await this.gateway.setPause(!this.paused());
    } catch {
      /* The connection indicator remains the recovery path. */
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
    const prompt = this.gateway.prompts()[0];
    const instance = this.gateway
      .snapshot()
      ?.instances.find((candidate) => candidate.id === prompt?.instanceId);
    if (!prompt || !instance) return;
    const key = instance.workingDirectory || '__no_workspace__';
    void this.router.navigate(['/projects', key, 'sessions', instance.id]);
  }

  protected openSession(projectKey: string, session: MobileSessionRowView): void {
    this.releaseRowPress();
    void this.router.navigate(sessionTargetRoute(projectKey, session));
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
    if (target.queryParams) {
      void this.router.navigate(target.commands, { queryParams: target.queryParams });
      return;
    }
    void this.router.navigate(target.commands);
  }
}
