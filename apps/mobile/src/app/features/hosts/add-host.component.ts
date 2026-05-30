import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { HostStore } from '../../core/host-store';
import { GatewayClient } from '../../core/gateway-client.service';
import type { PairingPayload } from '../../core/models';

@Component({
  standalone: true,
  selector: 'app-add-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <section class="screen">
      <header class="top">
        <button class="back" (click)="cancel()">‹ Hosts</button>
        <h2>Add a host</h2>
        <span></span>
      </header>

      <p class="muted">
        On your Mac: <strong>Settings → Mobile → Generate pairing code</strong>, then paste the
        connection code below (or type the details).
      </p>

      <label>Connection code</label>
      <textarea
        rows="3"
        placeholder='{"v":1,"host":"100.x.y.z","port":4879,"pairingToken":"…"}'
        [ngModel]="code()"
        (ngModelChange)="onCode($event)"
      ></textarea>

      <div class="fields">
        <label>Host (Tailscale IP)</label>
        <input [ngModel]="host()" (ngModelChange)="host.set($event)" placeholder="100.x.y.z" inputmode="decimal" />
        <label>Port</label>
        <input [ngModel]="port()" (ngModelChange)="port.set(+$event)" type="number" />
        <label>Pairing token</label>
        <input [ngModel]="token()" (ngModelChange)="token.set($event)" placeholder="one-time token" />
        <label>Label (optional)</label>
        <input [ngModel]="label()" (ngModelChange)="label.set($event)" placeholder="My iPhone" />
      </div>

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      <button class="cta" (click)="pair()" [disabled]="busy() || !canPair()">
        {{ busy() ? 'Pairing…' : 'Pair' }}
      </button>
    </section>
  `,
  styles: [
    `
      .screen { padding: 16px; display: flex; flex-direction: column; gap: 12px; }
      .top { display: flex; align-items: center; justify-content: space-between; }
      .back { background: none; border: none; color: var(--accent-action); font-size: 17px; }
      .muted { color: var(--text-secondary); font-size: 15px; margin: 4px 0 8px; }
      label { font-size: 13px; color: var(--text-secondary); }
      .fields { display: flex; flex-direction: column; gap: 6px; }
      .error { color: var(--accent-error); font-size: 14px; }
      .cta {
        margin-top: 8px; background: #fff; color: #000; border: none;
        border-radius: var(--radius-pill); padding: 14px; font-size: 16px; font-weight: 600;
      }
      .cta:disabled { opacity: 0.4; }
    `,
  ],
})
export class AddHostComponent {
  private readonly hostStore = inject(HostStore);
  private readonly router = inject(Router);

  protected readonly code = signal('');
  protected readonly host = signal('');
  protected readonly port = signal(4879);
  protected readonly token = signal('');
  protected readonly label = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected canPair(): boolean {
    return this.host().trim().length > 0 && this.token().trim().length > 0 && this.port() > 0;
  }

  protected onCode(value: string): void {
    this.code.set(value);
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) {
      return;
    }
    try {
      const parsed = JSON.parse(trimmed) as Partial<PairingPayload>;
      if (typeof parsed.host === 'string') this.host.set(parsed.host);
      if (typeof parsed.port === 'number') this.port.set(parsed.port);
      if (typeof parsed.pairingToken === 'string') this.token.set(parsed.pairingToken);
    } catch {
      /* not JSON yet — leave manual fields alone */
    }
  }

  protected async pair(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      const result = await GatewayClient.pair(
        this.host().trim(),
        this.port(),
        this.token().trim(),
        this.label().trim() || 'iPhone',
      );
      await this.hostStore.addHost({
        id: result.deviceId,
        name: result.hostName || this.host().trim(),
        host: this.host().trim(),
        port: this.port(),
        token: result.token,
        addedAt: Date.now(),
      });
      await this.hostStore.setActive(result.deviceId);
      void this.router.navigate(['/projects']);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : String(err));
    } finally {
      this.busy.set(false);
    }
  }

  protected cancel(): void {
    void this.router.navigate(['/']);
  }
}
