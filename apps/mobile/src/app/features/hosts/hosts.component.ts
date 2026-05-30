import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';
import { HostStore } from '../../core/host-store';
import { GatewayClient } from '../../core/gateway-client.service';

@Component({
  standalone: true,
  selector: 'app-hosts',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="screen">
      <header class="top">
        <h1>Hosts</h1>
        <button class="icon" (click)="add()" aria-label="Add host">＋</button>
      </header>

      @if (hosts().length === 0) {
        <div class="empty">
          <p>No hosts yet.</p>
          <p class="muted">
            On your Mac open <strong>Settings → Mobile</strong>, start the gateway, and generate a
            pairing code.
          </p>
          <button class="cta" (click)="add()">Add a host</button>
        </div>
      } @else {
        <ul class="list">
          @for (h of hosts(); track h.id) {
            <li>
              <button class="row" (click)="open(h.id)">
                <span class="dot" [class.on]="h.id === activeId() && online()"></span>
                <span class="info">
                  <span class="name">{{ h.name }}</span>
                  <span class="addr">{{ h.host }}:{{ h.port }}</span>
                </span>
                <span class="state">{{ stateLabel(h.id) }}</span>
              </button>
            </li>
          }
        </ul>
      }
    </section>
  `,
  styles: [
    `
      .screen { padding: 16px; }
      .top { display: flex; align-items: center; justify-content: space-between; margin: 8px 0 20px; }
      .icon {
        width: 40px; height: 40px; border-radius: 50%;
        background: var(--surface); color: var(--text); border: none; font-size: 22px;
      }
      .list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 4px; }
      .row {
        width: 100%; display: flex; align-items: center; gap: 12px;
        background: transparent; border: none; color: var(--text);
        padding: 14px 8px; text-align: left;
      }
      .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--text-secondary); flex: none; }
      .dot.on { background: var(--accent-online); }
      .info { display: flex; flex-direction: column; flex: 1; min-width: 0; }
      .name { font-size: 17px; }
      .addr { font-size: 13px; color: var(--text-secondary); }
      .state { font-size: 13px; color: var(--text-secondary); }
      .empty { text-align: center; padding: 48px 16px; color: var(--text); }
      .muted { color: var(--text-secondary); font-size: 15px; }
      .cta {
        margin-top: 16px; background: #fff; color: #000; border: none;
        border-radius: var(--radius-pill); padding: 12px 24px; font-size: 16px; font-weight: 600;
      }
    `,
  ],
})
export class HostsComponent {
  private readonly hostStore = inject(HostStore);
  private readonly gateway = inject(GatewayClient);
  private readonly router = inject(Router);

  protected readonly hosts = this.hostStore.hosts;
  protected readonly activeId = this.hostStore.activeId;
  protected readonly online = this.gateway.online;

  protected stateLabel(id: string): string {
    if (id !== this.activeId()) {
      return '';
    }
    return this.gateway.state() === 'connected' ? 'online' : this.gateway.state();
  }

  protected add(): void {
    void this.router.navigate(['/add-host']);
  }

  protected async open(id: string): Promise<void> {
    await this.hostStore.setActive(id);
    void this.router.navigate(['/projects']);
  }
}
