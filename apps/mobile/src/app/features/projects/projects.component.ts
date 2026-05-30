import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';

@Component({
  standalone: true,
  selector: 'app-projects',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="screen">
      <header class="top">
        <button class="back" (click)="toHosts()">‹ Hosts</button>
        <span class="conn">
          <span class="dot" [class.on]="online()"></span>{{ stateLabel() }}
        </span>
      </header>

      <h1>{{ hostName() }}</h1>

      @if (!online() && projects().length === 0) {
        <p class="muted">{{ state() === 'connecting' ? 'Connecting…' : 'Not connected.' }}</p>
      }

      <h2 class="section">Projects</h2>
      @if (projects().length === 0 && online()) {
        <p class="muted">No active sessions. Start one on your Mac.</p>
      }
      <ul class="list">
        @for (p of projects(); track p.key) {
          <li>
            <button class="row" (click)="open(p)">
              <span class="folder">🗀</span>
              <span class="info">
                <span class="name">{{ p.name }}</span>
                <span class="meta">{{ p.sessionCount }} session{{ p.sessionCount === 1 ? '' : 's' }}</span>
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
    </section>
  `,
  styles: [
    `
      .screen { padding: 16px; }
      .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
      .back { background: none; border: none; color: var(--accent-action); font-size: 17px; }
      .conn { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--text-secondary); }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-secondary); }
      .dot.on { background: var(--accent-online); }
      h1 { margin: 4px 0 16px; }
      .section { color: var(--text); margin: 16px 0 8px; }
      .muted { color: var(--text-secondary); }
      .list { list-style: none; padding: 0; margin: 0; }
      .row {
        width: 100%; display: flex; align-items: center; gap: 12px;
        background: transparent; border: none; color: var(--text); padding: 14px 4px; text-align: left;
      }
      .folder { font-size: 18px; opacity: 0.8; }
      .info { display: flex; flex-direction: column; flex: 1; min-width: 0; }
      .name { font-size: 17px; }
      .meta { font-size: 13px; color: var(--text-secondary); }
      .badge { font-size: 12px; padding: 2px 8px; border-radius: var(--radius-pill); }
      .badge.attention { color: var(--accent-attention); background: rgba(255, 159, 10, 0.15); }
      .badge.busy { color: var(--accent-action); background: rgba(10, 132, 255, 0.15); }
      .chevron { color: var(--text-secondary); font-size: 20px; }
    `,
  ],
})
export class ProjectsComponent {
  private readonly gateway = inject(GatewayClient);
  private readonly hostStore = inject(HostStore);
  private readonly router = inject(Router);

  protected readonly state = this.gateway.state;
  protected readonly online = this.gateway.online;
  protected readonly projects = computed(() => this.gateway.snapshot()?.projects ?? []);
  protected readonly hostName = computed(
    () => this.gateway.snapshot()?.hostName ?? this.hostStore.activeHost()?.name ?? 'Host',
  );

  protected stateLabel(): string {
    return this.online() ? 'online' : this.state();
  }

  protected toHosts(): void {
    void this.router.navigate(['/']);
  }

  protected open(p: { key: string }): void {
    void this.router.navigate(['/projects', p.key, 'sessions']);
  }
}
