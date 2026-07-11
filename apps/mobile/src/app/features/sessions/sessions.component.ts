import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { GatewayClient } from '../../core/gateway-client.service';
import { isWorking, statusLabel } from '../../core/status';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';
import {
  MobileSessionRowComponent,
  type MobileSessionRowView,
} from '../../shared/mobile-session-row.component';

interface SessionRow extends MobileSessionRowView {
  status: string;
  pendingApprovalCount: number;
  isLooping: boolean;
  chip: SessionRowChip;
}

export type SessionRowChipKind = 'attention' | 'loop' | 'past' | 'status';

export interface SessionRowChip {
  kind: SessionRowChipKind;
  label: string;
}

export interface SessionChipInput {
  live: boolean;
  isLooping: boolean;
  status: string;
  pendingApprovalCount: number;
}

export function sessionChipForRow(row: SessionChipInput): SessionRowChip {
  if (row.pendingApprovalCount > 0) return { kind: 'attention', label: 'Awaiting approval' };
  if (!row.live) return { kind: 'past', label: 'past' };
  if (row.isLooping) return { kind: 'loop', label: 'Loop' };
  return { kind: 'status', label: statusLabel(row.status) };
}

export const SESSION_PAGE_SIZE = 10;

export function nextSessionsPageSize(hiddenCount: number, pageSize = SESSION_PAGE_SIZE): number {
  return Math.max(0, Math.min(hiddenCount, pageSize));
}

export function sessionsShowMoreLabel(hiddenCount: number, pageSize = SESSION_PAGE_SIZE): string {
  const nextCount = nextSessionsPageSize(hiddenCount, pageSize);
  if (nextCount <= 0) return 'Show more';
  if (hiddenCount > nextCount) return `Show ${nextCount} more (${hiddenCount} remaining)`;
  return `Show ${nextCount} more`;
}

function sessionTone(row: SessionChipInput): MobileSessionRowView['tone'] {
  if (row.pendingApprovalCount > 0) return 'attention';
  if (!row.live) return 'history';
  if (row.isLooping) return 'loop';
  if (row.status === 'error' || row.status === 'failed' || row.status === 'degraded') return 'error';
  if (isWorking(row.status)) return 'working';
  return 'idle';
}

@Component({
  standalone: true,
  selector: 'app-sessions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MobileHeaderComponent, MobileIconComponent, MobileSessionRowComponent],
  template: `
    <section class="sessions-screen">
      <app-mobile-header
        [title]="projectName()"
        [subtitle]="online() ? 'Connected' : 'Offline'"
        [statusColor]="online() ? 'var(--accent-online)' : 'var(--text-secondary)'"
      >
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

      <h1>Sessions</h1>

      <div class="session-list">
        @for (session of visibleSessions(); track session.id) {
          <app-mobile-session-row [row]="session" (activate)="open(session)" />
        } @empty {
          <div class="mobile-empty-state">
            <app-mobile-icon name="history" />
            <h2>No sessions yet</h2>
            <p>Start a session in this project to see it here.</p>
          </div>
        }
      </div>

      @if (hiddenCount() > 0) {
        <button class="show-more mobile-pressable" type="button" (click)="showMore()">{{ showMoreLabel() }}</button>
      }

      <div class="mobile-bottom-dock sessions-dock">
        <button class="mobile-primary-button" type="button" (click)="newSession()" [disabled]="!online()">
          <app-mobile-icon name="compose" />
          New session
        </button>
      </div>
    </section>
  `,
  styles: [
    `
      .sessions-screen { min-height: 100%; padding: var(--space-3) var(--mobile-gutter) calc(var(--dock-height) + var(--space-12)); }
      h1 { margin: var(--space-8) 0 var(--space-3); font-size: var(--font-size-xl); }
      .session-list { display: grid; }
      .mobile-empty-state > app-mobile-icon { color: var(--text-secondary); font-size: 2.5rem; }
      .mobile-empty-state h2, .mobile-empty-state p { margin: 0; }
      .show-more { width: 100%; min-height: var(--control-size); border: 0; border-radius: var(--radius-pill); background: transparent; color: var(--accent-action); font-size: var(--font-size-sm); }
      .sessions-dock { justify-content: flex-end; }
      .sessions-dock .mobile-primary-button { box-shadow: 0 12px 30px rgba(0, 0, 0, 0.45); }
    `,
  ],
})
export class SessionsComponent {
  private readonly gateway = inject(GatewayClient);
  private readonly router = inject(Router);

  readonly projectKey = input('');

  protected readonly online = this.gateway.online;
  protected readonly visibleCount = signal(SESSION_PAGE_SIZE);
  protected readonly sessions = computed<SessionRow[]>(() => {
    const key = this.projectKey();
    const live: SessionRow[] = (this.gateway.snapshot()?.instances ?? [])
      .filter((instance) => (instance.workingDirectory || '__no_workspace__') === key)
      .map((instance) => {
        const chip = sessionChipForRow({
          live: true,
          isLooping: instance.isLooping === true,
          status: instance.status,
          pendingApprovalCount: instance.pendingApprovalCount,
        });
        return {
          id: instance.id,
          title: instance.displayName,
          subtitle: [instance.provider, instance.model].filter(Boolean).join(' · '),
          status: instance.status,
          statusLabel: chip.label,
          tone: sessionTone({
            live: true,
            isLooping: instance.isLooping === true,
            status: instance.status,
            pendingApprovalCount: instance.pendingApprovalCount,
          }),
          pendingApprovalCount: instance.pendingApprovalCount,
          unread: instance.hasUnreadCompletion,
          isLooping: instance.isLooping === true,
          live: true,
          lastActivity: instance.lastActivity,
          chip,
        };
      });

    const liveHistoryHandled = new Set(live.map((row) => row.id));
    const past: SessionRow[] = this.gateway
      .historySessions()
      .filter((session) => (session.workingDirectory || '__no_workspace__') === key)
      .filter((session) => !(session.live && session.instanceId && liveHistoryHandled.has(session.instanceId)))
      .map((session) => {
        const chip = sessionChipForRow({
          live: false,
          isLooping: false,
          status: 'idle',
          pendingApprovalCount: 0,
        });
        return {
          id: session.id,
          title: session.name,
          subtitle: [session.provider ?? 'session', session.model].filter(Boolean).join(' · '),
          status: 'idle',
          statusLabel: chip.label,
          tone: 'history',
          pendingApprovalCount: 0,
          unread: false,
          isLooping: false,
          live: false,
          lastActivity: session.lastActiveAt,
          chip,
        };
      });

    return [...live, ...past].sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return b.lastActivity - a.lastActivity;
    });
  });
  protected readonly visibleSessions = computed(() => this.sessions().slice(0, this.visibleCount()));
  protected readonly hiddenCount = computed(() => Math.max(0, this.sessions().length - this.visibleCount()));
  protected readonly nextPageSize = computed(() => nextSessionsPageSize(this.hiddenCount()));
  protected readonly showMoreLabel = computed(() => sessionsShowMoreLabel(this.hiddenCount()));
  protected readonly projectName = computed(() => {
    const project = this.gateway.snapshot()?.projects.find((item) => item.key === this.projectKey());
    if (project) return project.name;
    const key = this.projectKey();
    if (key === '__no_workspace__') return 'No workspace';
    return key.split('/').filter(Boolean).pop() || 'Sessions';
  });

  protected showMore(): void {
    this.visibleCount.update((count) => count + this.nextPageSize());
  }

  protected open(session: SessionRow): void {
    if (session.live) {
      void this.router.navigate(['/projects', this.projectKey(), 'sessions', session.id]);
    } else {
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
