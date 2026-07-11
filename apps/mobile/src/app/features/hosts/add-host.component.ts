import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { GatewayClient } from '../../core/gateway-client.service';
import { HostStore } from '../../core/host-store';
import type { PairingPayload } from '../../core/models';
import { QrScannerService } from '../../core/qr-scanner.service';
import { MobileHeaderComponent } from '../../shared/mobile-header.component';
import { MobileIconComponent } from '../../shared/mobile-icon.component';

@Component({
  standalone: true,
  selector: 'app-add-host',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, MobileHeaderComponent, MobileIconComponent],
  template: `
    <section class="add-host-screen">
      <app-mobile-header title="Add host">
        <button
          mobileHeaderLeading
          class="mobile-icon-button"
          type="button"
          (click)="cancel()"
          aria-label="Back to hosts"
        >
          <app-mobile-icon name="chevron-left" />
        </button>
        <span mobileHeaderTrailing aria-hidden="true"></span>
      </app-mobile-header>

      <div class="add-host-intro">
        <h1>Pair this phone</h1>
        <p>On your Mac, open Settings, choose Mobile, and generate a pairing code.</p>
      </div>

      <aside class="connection-note">
        <app-mobile-icon name="warning" />
        <p>Connect Tailscale on this phone first, using the same tailnet as the Mac.</p>
      </aside>

      @if (scanAvailable) {
        <button class="scan-button mobile-pressable" type="button" (click)="scan()" [disabled]="busy()">
          <app-mobile-icon name="qr" />
          Scan QR code
        </button>
      }

      <label class="field">
        <span>Connection code</span>
        <textarea
          rows="3"
          placeholder='{"v":1,"host":"100.x.y.z","port":4879,"pairingToken":"..."}'
          [ngModel]="code()"
          (ngModelChange)="onCode($event)"
        ></textarea>
      </label>

      <div class="fields">
        <label class="field">
          <span>Host (Tailscale IP)</span>
          <input [ngModel]="host()" (ngModelChange)="host.set($event)" placeholder="100.x.y.z" inputmode="decimal" />
        </label>
        <label class="field">
          <span>Port</span>
          <input [ngModel]="port()" (ngModelChange)="port.set(+$event)" type="number" />
        </label>
        <label class="field">
          <span>Pairing token</span>
          <input [ngModel]="token()" (ngModelChange)="token.set($event)" placeholder="One-time token" />
        </label>
        <label class="field">
          <span>Label (optional)</span>
          <input [ngModel]="label()" (ngModelChange)="label.set($event)" placeholder="My iPhone" />
        </label>
        <label class="secure-row">
          <input type="checkbox" [ngModel]="secure()" (ngModelChange)="secure.set($event)" />
          <span>
            <strong>Secure connection</strong>
            <small>Only enable TLS when the Mac gateway has a certificate configured.</small>
          </span>
        </label>
      </div>

      @if (error()) {
        <p class="pair-error" role="alert">{{ error() }}</p>
      }

      <button class="mobile-primary-button pair-button" type="button" (click)="pair()" [disabled]="busy() || !canPair()">
        {{ busy() ? 'Pairing…' : 'Pair host' }}
      </button>
    </section>
  `,
  styles: [
    `
      .add-host-screen { display: flex; min-height: 100%; flex-direction: column; gap: var(--space-4); padding: var(--space-3) var(--mobile-gutter) var(--space-8); }
      .add-host-intro { margin-top: var(--space-5); }
      .add-host-intro h1 { font-size: var(--font-size-display); }
      .add-host-intro p { margin: var(--space-2) 0 0; color: var(--text-secondary); font-size: 0.95rem; line-height: var(--line-height-normal); }
      .connection-note { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: var(--space-3); border-radius: var(--radius-md); background: rgba(255, 159, 10, 0.12); color: var(--accent-attention); padding: var(--space-3); }
      .connection-note app-mobile-icon { margin-top: 2px; font-size: 1.15rem; }
      .connection-note p { margin: 0; font-size: var(--font-size-sm); line-height: var(--line-height-normal); }
      .scan-button { display: flex; min-height: 52px; align-items: center; justify-content: center; gap: var(--space-2); border: 1px solid var(--separator-strong); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--text); font-size: 1rem; font-weight: 600; }
      .scan-button app-mobile-icon { font-size: 1.25rem; }
      .fields { display: grid; gap: var(--space-3); }
      .field { display: grid; gap: var(--space-2); color: var(--text-secondary); font-size: var(--font-size-sm); }
      .field input, .field textarea { width: 100%; min-height: 48px; border: 1px solid var(--separator); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--text); padding: var(--space-3); font: inherit; font-size: 1rem; }
      .field textarea { resize: vertical; line-height: var(--line-height-normal); }
      .field input:focus, .field textarea:focus { border-color: var(--separator-strong); outline: 0; }
      .secure-row { display: grid; min-height: 56px; grid-template-columns: 24px minmax(0, 1fr); align-items: start; gap: var(--space-3); color: var(--text); padding: var(--space-2) 0; }
      .secure-row input { width: 20px; height: 20px; margin: 2px 0 0; accent-color: var(--accent-action); }
      .secure-row span { display: flex; flex-direction: column; gap: 2px; }
      .secure-row strong { font-size: 0.95rem; font-weight: 500; }
      .secure-row small { color: var(--text-secondary); font-size: var(--font-size-sm); line-height: var(--line-height-normal); }
      .pair-error { margin: 0; color: var(--accent-error); font-size: var(--font-size-sm); line-height: var(--line-height-normal); }
      .pair-button { width: 100%; margin-top: var(--space-2); }
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
  protected readonly secure = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected canPair(): boolean {
    return this.host().trim().length > 0 && this.token().trim().length > 0 && this.port() > 0;
  }

  protected onCode(value: string): void {
    this.code.set(value);
    this.applyPayload(value);
  }

  private applyPayload(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{')) return false;
    try {
      const parsed = JSON.parse(trimmed) as Partial<PairingPayload>;
      if (typeof parsed.host === 'string') this.host.set(parsed.host);
      if (typeof parsed.port === 'number') this.port.set(parsed.port);
      if (typeof parsed.pairingToken === 'string') this.token.set(parsed.pairingToken);
      this.secure.set(parsed.secure === true);
      return true;
    } catch {
      return false;
    }
  }

  protected async scan(): Promise<void> {
    this.error.set(null);
    const raw = await this.qr.scan();
    if (!raw) return;
    this.code.set(raw);
    if (this.applyPayload(raw) && this.canPair()) await this.pair();
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
        this.secure(),
      );
      await this.hostStore.addHost({
        id: result.deviceId,
        name: result.hostName || this.host().trim(),
        host: this.host().trim(),
        port: this.port(),
        token: result.token,
        secure: this.secure(),
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
