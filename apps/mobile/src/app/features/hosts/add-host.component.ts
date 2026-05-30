import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { HostStore } from '../../core/host-store';
import { GatewayClient } from '../../core/gateway-client.service';
import { QrScannerService } from '../../core/qr-scanner.service';
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
        On your Mac: <strong>Settings → Mobile → Generate pairing code</strong>, then scan the QR
        (or paste the connection code below).
      </p>

      @if (scanAvailable) {
        <button class="scan" (click)="scan()" [disabled]="busy()">⛶ Scan QR code</button>
      }

      <span class="lbl">Connection code</span>
      <textarea
        rows="3"
        placeholder='{"v":1,"host":"100.x.y.z","port":4879,"pairingToken":"…"}'
        [ngModel]="code()"
        (ngModelChange)="onCode($event)"
      ></textarea>

      <div class="fields">
        <span class="lbl">Host (Tailscale IP)</span>
        <input [ngModel]="host()" (ngModelChange)="host.set($event)" placeholder="100.x.y.z" inputmode="decimal" />
        <span class="lbl">Port</span>
        <input [ngModel]="port()" (ngModelChange)="port.set(+$event)" type="number" />
        <span class="lbl">Pairing token</span>
        <input [ngModel]="token()" (ngModelChange)="token.set($event)" placeholder="one-time token" />
        <span class="lbl">Label (optional)</span>
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
      .scan {
        background: var(--surface); color: var(--text); border: 1px solid rgba(255,255,255,0.12);
        border-radius: 12px; padding: 14px; font-size: 16px; font-weight: 500;
      }
      .lbl { font-size: 13px; color: var(--text-secondary); }
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
  private readonly qr = inject(QrScannerService);

  protected readonly scanAvailable = this.qr.available;
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
    this.applyPayload(value);
  }

  /** Parse a pairing JSON payload into the form fields; returns true if it parsed. */
  private applyPayload(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) {
      return false;
    }
    try {
      const parsed = JSON.parse(trimmed) as Partial<PairingPayload>;
      if (typeof parsed.host === 'string') this.host.set(parsed.host);
      if (typeof parsed.port === 'number') this.port.set(parsed.port);
      if (typeof parsed.pairingToken === 'string') this.token.set(parsed.pairingToken);
      return true;
    } catch {
      return false;
    }
  }

  protected async scan(): Promise<void> {
    this.error.set(null);
    const raw = await this.qr.scan();
    if (!raw) {
      return; // cancelled or unavailable
    }
    this.code.set(raw);
    if (this.applyPayload(raw) && this.canPair()) {
      await this.pair(); // QR carried everything — pair straight away
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
