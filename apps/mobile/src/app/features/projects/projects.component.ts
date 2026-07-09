import {
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
import { displayStatusColor, displayStatusLabel } from '../../core/status';
import type { MobileInstanceDto, MobileProjectDto, MobileRecentDirDto } from '../../core/models';

type OrganizeMode = 'project' | 'chronological';

@Component({
  standalone: true,
  selector: 'app-projects',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="screen">
      <header class="top">
        <button class="icon" (click)="toHosts()" aria-label="Hosts">☰</button>
        <span class="conn">
          <span class="dot" [class.on]="online()"></span>{{ stateLabel() }}
        </span>
        <button class="icon" (click)="menuOpen.set(!menuOpen())" aria-label="Organize">⋯</button>
      </header>

      @if (menuOpen()) {
        <div class="popover">
          <span class="cap">Organize</span>
          <button (click)="setMode('project')">{{ mode() === 'project' ? '✓ ' : '' }}By project</button>
          <button (click)="setMode('chronological')">
            {{ mode() === 'chronological' ? '✓ ' : '' }}Chronological
          </button>
        </div>
      }

      <h1>{{ hostName() }}</h1>

      <div class="rollup">
        <button class="pill" [class.paused]="paused()" (click)="togglePause()" [disabled]="!online()">
          {{ paused() ? '⏸ Paused' : '▶ Active' }}
        </button>
        @if (promptCount() > 0) {
          <span class="pill attention">{{ promptCount() }} awaiting approval</span>
        }
        <button class="pill" (click)="openHistory()">🕘 History</button>
      </div>

      @if (!online() && projects().length === 0) {
        <p class="muted">{{ state() === 'connecting' ? 'Connecting…' : 'Not connected.' }}</p>
      }

      @if (mode() === 'project') {
        <h2 class="section">Projects</h2>
        @if (mergedProjects().length === 0 && online()) {
          <p class="muted">No projects yet. Tap ＋ New to start one.</p>
        }
        <ul class="list">
          @for (p of mergedProjects(); track p.key) {
            <li>
              <button class="row" (click)="openProject(p)">
                <span class="folder">🗀</span>
                <span class="info">
                  <span class="name">{{ p.name }}</span>
                  <span class="meta">
                    {{ p.sessionCount === 0 ? 'No sessions · tap to start' : p.sessionCount + ' session' + (p.sessionCount === 1 ? '' : 's') }}
                  </span>
                </span>
                @if (p.pendingApprovalCount > 0) {
                  <span class="badge attention">{{ p.pendingApprovalCount }} ⚠</span>
                } @else if (p.busyCount > 0) {
                  <span class="badge busy">{{ p.busyCount }} ●</span>
                }
                <span class="chevron">›</span>
              </button>
            </li>
          }
        </ul>
      } @else {
        <h2 class="section">Sessions</h2>
        <ul class="list">
          @for (s of chronological(); track s.id) {
            <li>
              <button class="row" (click)="openSession(s)">
                <span class="dot lg" [style.background]="color(s)"></span>
                <span class="info">
                  <span class="name">{{ s.displayName }}</span>
                  <span class="meta">{{ s.projectName }} · {{ label(s) }}</span>
                </span>
                @if (s.pendingApprovalCount > 0) {
                  <span class="badge attention">⚠</span>
                } @else if (s.hasUnreadCompletion) {
                  <span class="unread"></span>
                }
                <span class="chevron">›</span>
              </button>
            </li>
          }
        </ul>
      }

      <button class="fab" (click)="newSession()">＋ New</button>
    </section>
  `,
  styles: [
    `
      .screen { padding: 16px; }
      .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .icon { width: 40px; height: 40px; border-radius: 50%; background: var(--surface); color: var(--text); border: none; font-size: 18px; }
      .conn { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-secondary); }
      .conn .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-secondary); }
      .conn .dot.on { background: var(--accent-online); }
      .popover {
        position: absolute; right: 16px; top: 56px; z-index: 5;
        background: var(--surface-2); border-radius: 14px; padding: 8px; display: flex; flex-direction: column;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5); min-width: 180px;
      }
      .popover .cap { font-size: 12px; color: var(--text-secondary); padding: 6px 12px; }
      .popover button { background: none; border: none; color: var(--text); text-align: left; padding: 10px 12px; font-size: 15px; }
      h1 { margin: 4px 0 12px; }
      .rollup { display: flex; gap: 8px; margin-bottom: 16px; flex-wrap: wrap; }
      .pill {
        font-size: 13px; padding: 7px 14px; border-radius: var(--radius-pill); border: none;
        background: var(--surface); color: var(--text);
      }
      .pill.paused { background: rgba(255,159,10,0.2); color: var(--accent-attention); }
      .pill.attention { background: rgba(255,159,10,0.15); color: var(--accent-attention); }
      .section { color: var(--text); margin: 16px 0 8px; }
      .muted { color: var(--text-secondary); }
      .list { list-style: none; padding: 0; margin: 0 0 80px; }
      .row {
        width: 100%; display: flex; align-items: center; gap: 12px;
        background: transparent; border: none; color: var(--text); padding: 14px 4px; text-align: left;
      }
      .folder { font-size: 18px; opacity: 0.8; }
      .dot.lg { width: 10px; height: 10px; border-radius: 50%; flex: none; }
      .info { display: flex; flex-direction: column; flex: 1; min-width: 0; }
      .name { font-size: 17px; }
      .meta { font-size: 13px; color: var(--text-secondary); text-transform: capitalize; }
      .badge { font-size: 12px; padding: 2px 8px; border-radius: var(--radius-pill); }
      .badge.attention { color: var(--accent-attention); background: rgba(255, 159, 10, 0.15); }
      .badge.busy { color: var(--accent-action); background: rgba(10, 132, 255, 0.15); }
      .unread { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-action); flex: none; }
      .chevron { color: var(--text-secondary); font-size: 20px; }
      .fab {
        position: fixed; right: 20px; bottom: calc(20px + env(safe-area-inset-bottom));
        background: #fff; color: #000; border: none; border-radius: var(--radius-pill);
        padding: 14px 22px; font-size: 16px; font-weight: 600; box-shadow: 0 6px 20px rgba(0,0,0,0.4);
      }
    `,
  ],
})
export class ProjectsComponent implements OnInit {
  private readonly gateway = inject(GatewayClient);
  private readonly hostStore = inject(HostStore);
  private readonly router = inject(Router);

  protected readonly state = this.gateway.state;
  protected readonly online = this.gateway.online;
  protected readonly mode = signal<OrganizeMode>('project');
  protected readonly menuOpen = signal(false);
  protected readonly color = displayStatusColor;
  protected readonly label = displayStatusLabel;

  /** The host's recent directories, so projects with no live session still show. */
  protected readonly recentDirs = signal<MobileRecentDirDto[]>([]);

  protected readonly projects = computed(() => this.gateway.snapshot()?.projects ?? []);

  /** Persisted (history) sessions grouped per project key. */
  private readonly historyByProject = computed(() => {
    const map = new Map<string, { count: number; lastActivity: number }>();
    for (const s of this.gateway.historySessions()) {
      const key = s.workingDirectory || '__no_workspace__';
      const prev = map.get(key) ?? { count: 0, lastActivity: 0 };
      map.set(key, {
        count: prev.count + 1,
        lastActivity: Math.max(prev.lastActivity, s.lastActiveAt),
      });
    }
    return map;
  });

  /**
   * Project list shown on the home screen, merged from three sources so it
   * matches the desktop: live instances (the snapshot), persisted history
   * sessions (chats + archived instance sessions — so a project you ran but
   * since closed still appears with its session count), and the host's recent
   * directories (so even a project with no sessions at all can be opened to
   * start work). Projects with live sessions sort first, then by activity.
   */
  protected readonly mergedProjects = computed<MobileProjectDto[]>(() => {
    const byKey = new Map<string, MobileProjectDto>();
    for (const p of this.projects()) {
      byKey.set(p.key, { ...p });
    }

    // Fold in persisted history: bump session counts and surface
    // history-only projects that have no live instance.
    for (const [key, h] of this.historyByProject()) {
      const existing = byKey.get(key);
      if (existing) {
        existing.sessionCount += h.count;
        existing.lastActivity = Math.max(existing.lastActivity, h.lastActivity);
      } else {
        const path = key === '__no_workspace__' ? '' : key;
        byKey.set(key, {
          key,
          path,
          name: path ? path.split('/').filter(Boolean).pop() || path : 'No workspace',
          sessionCount: h.count,
          busyCount: 0,
          pendingApprovalCount: 0,
          lastActivity: h.lastActivity,
        });
      }
    }

    // Recent dirs fill in genuinely-empty projects (no live + no history).
    for (const d of this.recentDirs()) {
      if (!byKey.has(d.path)) {
        byKey.set(d.path, {
          key: d.path,
          path: d.path,
          name: d.displayName || d.path,
          sessionCount: 0,
          busyCount: 0,
          pendingApprovalCount: 0,
          lastActivity: d.lastAccessed,
        });
      }
    }

    // Sort in tiers so empty recent-dir projects can't float above ones with
    // real work just because their `lastAccessed` timestamp is newer:
    //   1. projects with a live/busy session,
    //   2. projects that have any sessions (live or historical),
    //   3. everything else (empty recent dirs).
    // Within each tier, most-recent activity first.
    const rank = (p: MobileProjectDto): number => {
      if (p.busyCount > 0) return 2;
      if (p.sessionCount > 0) return 1;
      return 0;
    };
    return [...byKey.values()].sort((a, b) => {
      const rankDiff = rank(b) - rank(a);
      if (rankDiff !== 0) return rankDiff;
      return b.lastActivity - a.lastActivity;
    });
  });

  async ngOnInit(): Promise<void> {
    try {
      this.recentDirs.set(await this.gateway.recentDirs());
    } catch {
      /* recent dirs are best-effort; live projects still render */
    }
  }
  protected readonly chronological = computed(() =>
    [...(this.gateway.snapshot()?.instances ?? [])].sort((a, b) => b.lastActivity - a.lastActivity),
  );
  protected readonly promptCount = computed(() => this.gateway.prompts().length);
  protected readonly paused = computed(() => this.gateway.pause().isPaused);
  protected readonly hostName = computed(
    () => this.gateway.snapshot()?.hostName ?? this.hostStore.activeHost()?.name ?? 'Host',
  );

  protected stateLabel(): string {
    return this.online() ? 'online' : this.state();
  }

  protected setMode(mode: OrganizeMode): void {
    this.mode.set(mode);
    this.menuOpen.set(false);
  }

  protected async togglePause(): Promise<void> {
    try {
      await this.gateway.setPause(!this.paused());
    } catch {
      /* ignore */
    }
  }

  protected toHosts(): void {
    void this.router.navigate(['/']);
  }

  protected openProject(p: MobileProjectDto): void {
    if (p.sessionCount === 0) {
      // Empty project (from recent dirs) — jump straight to starting a session there.
      void this.router.navigate(['/new-session'], { queryParams: { dir: p.path } });
      return;
    }
    void this.router.navigate(['/projects', p.key, 'sessions']);
  }

  protected openHistory(): void {
    void this.router.navigate(['/history']);
  }

  protected openSession(s: MobileInstanceDto): void {
    const key = s.workingDirectory || '__no_workspace__';
    void this.router.navigate(['/projects', key, 'sessions', s.id]);
  }

  protected newSession(): void {
    void this.router.navigate(['/new-session']);
  }
}
