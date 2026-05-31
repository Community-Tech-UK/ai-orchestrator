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
import type { MobileHistorySessionDto } from '../../core/models';

interface HistoryGroup {
  key: string;
  name: string;
  sessions: MobileHistorySessionDto[];
}

/**
 * Browse persisted ("older") sessions — including ones that are closed/archived
 * and no longer live in the desktop's instance list. Sessions are grouped by
 * project (working directory) and ordered newest-first. Tapping a live session
 * deep-links to its live conversation; tapping a closed one opens a read-only
 * transcript.
 */
@Component({
  standalone: true,
  selector: 'app-history',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="screen">
      <header class="top">
        <button class="back" (click)="back()">‹</button>
        <h2>History</h2>
        <span></span>
      </header>

      @if (loading()) {
        <p class="muted">Loading…</p>
      } @else if (error()) {
        <p class="error">{{ error() }}</p>
      } @else if (groups().length === 0) {
        <p class="muted">No past sessions yet.</p>
      } @else {
        @for (g of groups(); track g.key) {
          <h3 class="group">{{ g.name }}</h3>
          <ul class="list">
            @for (s of g.sessions; track s.id) {
              <li>
                <button class="row" (click)="open(s)">
                  <span class="info">
                    <span class="name">{{ s.name }}</span>
                    <span class="meta">
                      {{ s.provider || 'session' }} · {{ when(s.lastActiveAt) }}
                    </span>
                  </span>
                  @if (s.live) {
                    <span class="tag live">live</span>
                  } @else if (s.archived) {
                    <span class="tag">archived</span>
                  }
                  <span class="chevron">›</span>
                </button>
              </li>
            }
          </ul>
        }
      }
    </section>
  `,
  styles: [
    `
      .screen { padding: 16px; }
      .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .back { background: none; border: none; color: var(--accent-action); font-size: 26px; line-height: 1; }
      .muted { color: var(--text-secondary); text-align: center; margin-top: 40px; }
      .error { color: var(--accent-error); }
      .group { color: var(--text-secondary); font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; margin: 18px 0 4px; }
      .list { list-style: none; padding: 0; margin: 0; }
      .row {
        width: 100%; display: flex; align-items: center; gap: 12px;
        background: transparent; border: none; color: var(--text); padding: 14px 4px; text-align: left;
      }
      .info { display: flex; flex-direction: column; flex: 1; min-width: 0; }
      .name { font-size: 17px; }
      .meta { font-size: 13px; color: var(--text-secondary); text-transform: capitalize; }
      .tag { font-size: 11px; padding: 2px 8px; border-radius: var(--radius-pill); background: var(--surface-2); color: var(--text-secondary); }
      .tag.live { background: rgba(52, 199, 89, 0.15); color: var(--accent-online); }
      .chevron { color: var(--text-secondary); font-size: 20px; }
    `,
  ],
})
export class HistoryComponent implements OnInit {
  private readonly gateway = inject(GatewayClient);
  private readonly router = inject(Router);

  protected readonly sessions = signal<MobileHistorySessionDto[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);

  protected readonly groups = computed<HistoryGroup[]>(() => {
    const map = new Map<string, HistoryGroup>();
    for (const s of this.sessions()) {
      const key = s.workingDirectory || '__no_workspace__';
      let g = map.get(key);
      if (!g) {
        g = { key, name: s.workingDirectory ? s.projectName : 'No workspace', sessions: [] };
        map.set(key, g);
      }
      g.sessions.push(s);
    }
    return [...map.values()];
  });

  async ngOnInit(): Promise<void> {
    try {
      const sessions = await this.gateway.history();
      this.sessions.set(sessions);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected open(s: MobileHistorySessionDto): void {
    if (s.live && s.instanceId) {
      const key = s.workingDirectory || '__no_workspace__';
      void this.router.navigate(['/projects', key, 'sessions', s.instanceId]);
    } else {
      void this.router.navigate(['/history', s.id]);
    }
  }

  protected when(ts: number): string {
    const delta = Date.now() - ts;
    const m = Math.round(delta / 60_000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h}h ago`;
    return `${Math.round(h / 24)}d ago`;
  }

  protected back(): void {
    void this.router.navigate(['/projects']);
  }
}
