import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { GatewayClient } from '../../core/gateway-client.service';
import { statusColor, statusLabel } from '../../core/status';

/** A row in the session list — either a live instance or a persisted history session. */
interface SessionRow {
  /** Route target: instance id for live, or namespaced history id for past sessions. */
  id: string;
  name: string;
  provider: string;
  model?: string;
  status: string;
  pendingApprovalCount: number;
  hasUnreadCompletion: boolean;
  live: boolean;
  lastActivity: number;
}

@Component({
  standalone: true,
  selector: 'app-sessions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="screen">
      <header class="top">
        <button class="back" (click)="back()">‹ Projects</button>
        <span class="conn"><span class="dot" [class.on]="online()"></span></span>
      </header>

      <h1>{{ projectName() }}</h1>

      @if (sessions().length === 0) {
        <p class="muted">No sessions in this project right now.</p>
      }

      <ul class="list">
        @for (s of visibleSessions(); track s.id) {
          <li>
            <button class="row" (click)="open(s)">
              <span class="dot lg" [style.background]="color(s.status)"></span>
              <span class="info">
                <span class="name">
                  {{ s.name }}
                  @if (s.hasUnreadCompletion) { <span class="unread"></span> }
                </span>
                <span class="meta">{{ s.provider }}{{ s.model ? ' · ' + s.model : '' }}</span>
              </span>
              @if (s.pendingApprovalCount > 0) {
                <span class="chip attention">Awaiting approval</span>
              } @else if (!s.live) {
                <span class="chip">past</span>
              } @else {
                <span class="chip">{{ label(s.status) }}</span>
              }
              <span class="chevron">›</span>
            </button>
          </li>
        }
      </ul>

      @if (hiddenCount() > 0) {
        <button class="show-more" (click)="showMore()">Show more ({{ hiddenCount() }})</button>
      }

      <button class="fab" (click)="newSession()">＋ New</button>
    </section>
  `,
  styles: [
    `
      .screen { padding: 16px; }
      .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .back { background: none; border: none; color: var(--accent-action); font-size: 17px; }
      .conn .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-secondary); }
      .conn .dot.on { background: var(--accent-online); }
      h1 { margin: 4px 0 16px; word-break: break-word; }
      .muted { color: var(--text-secondary); }
      .list { list-style: none; padding: 0; margin: 0; }
      .row {
        width: 100%; display: flex; align-items: center; gap: 12px; padding: 14px 4px;
        background: transparent; border: none; color: var(--text); text-align: left;
      }
      .dot.lg { width: 10px; height: 10px; border-radius: 50%; flex: none; }
      .info { display: flex; flex-direction: column; flex: 1; min-width: 0; }
      .name { font-size: 17px; display: flex; align-items: center; gap: 6px; }
      .unread { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-action); }
      .meta { font-size: 13px; color: var(--text-secondary); }
      .chip {
        font-size: 12px; color: var(--text-secondary); background: var(--surface);
        padding: 4px 10px; border-radius: var(--radius-pill); text-transform: capitalize; white-space: nowrap;
      }
      .chip.attention { color: var(--accent-attention); background: rgba(255, 159, 10, 0.15); }
      .chevron { color: var(--text-secondary); font-size: 20px; }
      .show-more {
        width: 100%; background: transparent; border: none; color: var(--accent-action);
        padding: 14px; font-size: 15px; margin-bottom: 80px;
      }
      .fab {
        position: fixed; right: 20px; bottom: calc(20px + env(safe-area-inset-bottom));
        background: #fff; color: #000; border: none; border-radius: var(--radius-pill);
        padding: 14px 22px; font-size: 16px; font-weight: 600; box-shadow: 0 6px 20px rgba(0,0,0,0.4);
      }
    `,
  ],
})
export class SessionsComponent {
  private readonly gateway = inject(GatewayClient);
  private readonly router = inject(Router);

  readonly projectKey = input<string>('');

  protected readonly online = this.gateway.online;
  protected readonly color = statusColor;
  protected readonly label = statusLabel;

  /** Show the most recent sessions first; reveal the rest in pages via "Show more". */
  private static readonly PAGE = 10;
  protected readonly visibleCount = signal(SessionsComponent.PAGE);

  protected readonly sessions = computed<SessionRow[]>(() => {
    const key = this.projectKey();

    const live: SessionRow[] = (this.gateway.snapshot()?.instances ?? [])
      .filter((i) => (i.workingDirectory || '__no_workspace__') === key)
      .map((i) => ({
        id: i.id,
        name: i.displayName,
        provider: i.provider,
        model: i.model,
        status: i.status,
        pendingApprovalCount: i.pendingApprovalCount,
        hasUnreadCompletion: i.hasUnreadCompletion,
        live: true,
        lastActivity: i.lastActivity,
      }));

    // Persisted (closed) sessions for this project. A history session that is
    // still live is already represented by the live instance above, so skip it.
    const liveHistoryHandled = new Set(live.map((r) => r.id));
    const past: SessionRow[] = this.gateway
      .historySessions()
      .filter((h) => (h.workingDirectory || '__no_workspace__') === key)
      .filter((h) => !(h.live && h.instanceId && liveHistoryHandled.has(h.instanceId)))
      .map((h) => ({
        id: h.id,
        name: h.name,
        provider: h.provider ?? 'session',
        model: h.model ?? undefined,
        status: 'idle',
        pendingApprovalCount: 0,
        hasUnreadCompletion: false,
        live: false,
        lastActivity: h.lastActiveAt,
      }));

    return [...live, ...past].sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return b.lastActivity - a.lastActivity;
    });
  });

  /** The slice currently shown (most recent first), capped by visibleCount. */
  protected readonly visibleSessions = computed<SessionRow[]>(() =>
    this.sessions().slice(0, this.visibleCount()),
  );

  /** How many sessions are hidden behind "Show more". */
  protected readonly hiddenCount = computed(() =>
    Math.max(0, this.sessions().length - this.visibleCount()),
  );

  protected showMore(): void {
    this.visibleCount.update((n) => n + SessionsComponent.PAGE);
  }

  protected readonly projectName = computed(() => {
    const project = this.gateway.snapshot()?.projects.find((p) => p.key === this.projectKey());
    if (project) return project.name;
    const key = this.projectKey();
    if (key === '__no_workspace__') return 'No workspace';
    return key.split('/').filter(Boolean).pop() || 'Sessions';
  });

  protected open(session: SessionRow): void {
    if (session.live) {
      void this.router.navigate(['/projects', this.projectKey(), 'sessions', session.id]);
    } else {
      // Past session → read-only transcript (history id is already namespaced).
      void this.router.navigate(['/history', session.id]);
    }
  }

  protected newSession(): void {
    void this.router.navigate(['/new-session'], { queryParams: { dir: this.projectKey() } });
  }

  protected back(): void {
    void this.router.navigate(['/projects']);
  }
}
