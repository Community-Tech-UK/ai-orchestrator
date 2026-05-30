import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { Router } from '@angular/router';
import { GatewayClient } from '../../core/gateway-client.service';
import { statusColor, statusLabel } from '../../core/status';
import type { MobileInstanceDto } from '../../core/models';

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
        @for (s of sessions(); track s.id) {
          <li>
            <button class="row" (click)="open(s)">
              <span class="dot lg" [style.background]="color(s.status)"></span>
              <span class="info">
                <span class="name">
                  {{ s.displayName }}
                  @if (s.hasUnreadCompletion) { <span class="unread"></span> }
                </span>
                <span class="meta">{{ s.provider }}{{ s.model ? ' · ' + s.model : '' }}</span>
              </span>
              @if (s.pendingApprovalCount > 0) {
                <span class="chip attention">Awaiting approval</span>
              } @else {
                <span class="chip">{{ label(s.status) }}</span>
              }
              <span class="chevron">›</span>
            </button>
          </li>
        }
      </ul>

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

  protected readonly sessions = computed(() => {
    const key = this.projectKey();
    return (this.gateway.snapshot()?.instances ?? []).filter(
      (i) => (i.workingDirectory || '__no_workspace__') === key,
    );
  });

  protected readonly projectName = computed(() => {
    const project = this.gateway.snapshot()?.projects.find((p) => p.key === this.projectKey());
    return project?.name ?? 'Sessions';
  });

  protected open(session: MobileInstanceDto): void {
    void this.router.navigate(['/projects', this.projectKey(), 'sessions', session.id]);
  }

  protected newSession(): void {
    void this.router.navigate(['/new-session'], { queryParams: { dir: this.projectKey() } });
  }

  protected back(): void {
    void this.router.navigate(['/projects']);
  }
}
