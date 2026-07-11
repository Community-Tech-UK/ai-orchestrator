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

      <h1>Past sessions</h1>

      @if (loading()) {
        <p class="history-state">Loading sessions…</p>
      } @else if (error()) {
        <p class="history-error" role="alert">{{ error() }}</p>
      } @else if (groups().length === 0) {
        <div class="mobile-empty-state">
          <app-mobile-icon name="history" />
          <h2>No past sessions yet</h2>
        </div>
      } @else {
        @for (group of groups(); track group.key) {
          <section class="history-group" [attr.aria-labelledby]="'history-group-' + $index">
            <h2 [id]="'history-group-' + $index">{{ group.name }}</h2>
            @for (session of group.sessions; track session.id) {
              <app-mobile-session-row [row]="rowForSession(session)" (activate)="open(session)" />
            }
          </section>
        }
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
    for (const session of this.sessions()) {
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

  async ngOnInit(): Promise<void> {
    try {
      this.sessions.set(await this.gateway.history());
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected rowForSession(session: MobileHistorySessionDto): MobileSessionRowView {
    return {
      id: session.id,
      title: session.name,
      subtitle: `${session.provider || 'session'} · ${this.when(session.lastActiveAt)}`,
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
      void this.router.navigate(['/projects', key, 'sessions', session.instanceId]);
    } else {
      void this.router.navigate(['/history', session.id]);
    }
  }

  protected when(timestamp: number): string {
    const minutes = Math.round((Date.now() - timestamp) / 60_000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  protected back(): void {
    void this.router.navigate(['/projects']);
  }
}
