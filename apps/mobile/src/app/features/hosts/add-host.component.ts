import { afterRenderEffect, ChangeDetectionStrategy, Component, ElementRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { PairingError, pairWithHost, parsePairingCode, validatePairingPayload } from '../../core/pairing';
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
          aria-label="Back to hosts" [disabled]="busy()"
        >
          <app-mobile-icon name="chevron-left" />
        </button>
        <span mobileHeaderTrailing aria-hidden="true"></span>
      </app-mobile-header>

      <div class="add-host-intro">
        <h1>Pair this phone</h1>
        <ol>
          <li>Connect Tailscale on both devices using the same tailnet.</li>
          <li>On the desktop, open Settings, Mobile. Start the gateway and generate a pairing code.</li>
        </ol>
      </div>

      @if (candidate(); as connection) {
        <section class="connection-summary" aria-labelledby="connection-summary-title">
          <h2 id="connection-summary-title" tabindex="-1">Ready to pair</h2>
          <p>{{ connection.host }}:{{ connection.port }}</p>
          <small>{{ connection.secure ? 'HTTPS over Tailscale' : 'HTTP over Tailscale' }}</small>
          <p>Your connection code stays hidden.</p>
          <label class="field">
            <span>Phone label (optional)</span>
            <input [ngModel]="label()" (ngModelChange)="label.set($event)" placeholder="My iPhone" [disabled]="busy()" />
          </label>
          <button class="mobile-primary-button pair-button" type="button" (click)="pair()" [disabled]="busy()">
            {{ busy() ? 'Pairing…' : 'Pair host' }}
          </button>
          <button class="setup-link" type="button" (click)="startOver()" [disabled]="busy()">Use another code</button>
        </section>
      } @else {
        <div class="setup-paths">
          @if (scanAvailable) {
            <button class="scan-button mobile-pressable" type="button" (click)="scan()" [disabled]="busy()">
              <app-mobile-icon name="qr" /> Scan QR code
            </button>
          }
          <button class="scan-button mobile-pressable" type="button" (click)="chooseMode('paste')" [disabled]="busy()"
            [attr.aria-expanded]="mode() === 'paste'" aria-controls="paste-setup">
            <app-mobile-icon name="clipboard" /> Paste connection code
          </button>
        </div>
        @if (mode() === 'paste') {
          <div id="paste-setup" class="fields">
            <label class="field" for="connection-code">
              <span>Connection code</span>
              <input id="connection-code" type="password" autocomplete="new-password" spellcheck="false"
                autocapitalize="none" placeholder="Paste the complete code" [ngModel]="code()"
                (ngModelChange)="onCode($event)" [disabled]="busy()" [attr.aria-invalid]="!!error()" />
            </label>
            <button class="mobile-primary-button" type="button" (click)="reviewCode()" [disabled]="busy() || !code().trim()">Review connection</button>
          </div>
        }
        <button class="setup-link" type="button" (click)="chooseMode('manual')" [disabled]="busy()"
          [attr.aria-expanded]="mode() === 'manual'" aria-controls="manual-setup">Manual setup</button>
        @if (mode() === 'manual') {
          <div id="manual-setup" class="fields">
            <label class="field">
              <span>Host (Tailscale IP or name)</span>
              <input [ngModel]="host()" (ngModelChange)="host.set($event)" placeholder="Host IP or name"
                autocapitalize="none" spellcheck="false" [disabled]="busy()" />
            </label>
            <label class="field">
              <span>Port</span>
              <input [ngModel]="port()" (ngModelChange)="port.set(+$event)" type="number" min="1" max="65535" step="1" [disabled]="busy()" />
            </label>
            <label class="field">
              <span>Pairing token</span>
              <input type="password" autocomplete="new-password" [ngModel]="token()" (ngModelChange)="token.set($event)"
                placeholder="One-time token" [disabled]="busy()" />
            </label>
            <label class="secure-row">
              <input type="checkbox" [ngModel]="secure()" (ngModelChange)="secure.set($event)" [disabled]="busy()" />
              <span><strong>Secure connection (TLS)</strong><small>Enable only if the desktop gateway has a certificate configured.</small></span>
            </label>
            <button class="mobile-primary-button" type="button" (click)="reviewManual()" [disabled]="busy()">Review connection</button>
          </div>
        }
      }
      @if (error()) {
        <p class="pair-error" role="alert">{{ error() }}</p>
      }
    </section>
  `,
  styles: [
    `
      .add-host-screen { display: flex; min-height: 100%; flex-direction: column; gap: var(--space-4); padding: var(--space-3) var(--mobile-gutter) var(--space-8); }
      .add-host-intro { margin-top: var(--space-5); }
      .add-host-intro h1 { font-size: var(--font-size-display); }
      .scan-button { display: flex; min-height: 52px; align-items: center; justify-content: center; gap: var(--space-2); border: 1px solid var(--separator-strong); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--text); font-size: 1rem; font-weight: 600; }
      .scan-button app-mobile-icon { font-size: 1.25rem; }
      .add-host-intro ol { padding-left: var(--space-5); margin: var(--space-3) 0 0; color: var(--text-secondary); line-height: var(--line-height-normal); }
      .add-host-intro li + li { margin-top: var(--space-2); }
      .setup-paths, .connection-summary { display: grid; gap: var(--space-3); }
      .connection-summary { padding: var(--space-4); border: 1px solid var(--separator); border-radius: var(--radius-md); overflow-wrap: anywhere; }
      .connection-summary h2, .connection-summary p { margin: 0; }
      .connection-summary small { color: var(--text-secondary); }
      .setup-link { min-height: 44px; border: 0; background: transparent; color: var(--accent-action); font: inherit; text-align: center; }
      .fields { display: grid; gap: var(--space-3); }
      .field { display: grid; gap: var(--space-2); color: var(--text-secondary); font-size: var(--font-size-sm); }
      .field input { width: 100%; min-height: 48px; border: 1px solid var(--separator); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--text); padding: var(--space-3); font: inherit; font-size: 1rem; }
      .field input:focus-visible { outline: 2px solid var(--accent-action); outline-offset: 2px; }
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
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly hostStore = inject(HostStore);
  private readonly router = inject(Router);
  private readonly qr = inject(QrScannerService);

  protected readonly scanAvailable = this.qr.available;
  protected readonly mode = signal<'choose' | 'paste' | 'manual'>('choose');
  protected readonly candidate = signal<PairingPayload | null>(null);
  protected readonly code = signal('');
  protected readonly host = signal('');
  protected readonly port = signal(4879);
  protected readonly token = signal('');
  protected readonly label = signal('');
  protected readonly secure = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    afterRenderEffect(() => {
      if (this.candidate()) {
        this.element.nativeElement.querySelector<HTMLElement>('#connection-summary-title')?.focus();
      } else if (this.mode() === 'paste') {
        this.element.nativeElement.querySelector<HTMLInputElement>('#connection-code')?.focus();
      } else if (this.mode() === 'manual') {
        this.element.nativeElement.querySelector<HTMLInputElement>('#manual-setup input')?.focus();
      }
    });
  }

  protected chooseMode(mode: 'paste' | 'manual'): void {
    if (this.busy()) return;
    this.mode.set(mode);
    this.error.set(null);
  }

  protected onCode(value: string): void {
    this.code.set(value);
    this.candidate.set(null);
    this.error.set(null);
  }

  protected reviewCode(): void {
    const result = parsePairingCode(this.code());
    this.candidate.set(result.payload);
    this.error.set(result.error);
    if (result.payload) this.code.set('');
  }

  protected reviewManual(): void {
    const result = validatePairingPayload({ v: 1, host: this.host(), port: this.port(), pairingToken: this.token(), secure: this.secure() });
    this.candidate.set(result.payload);
    this.error.set(result.error);
    if (result.payload) this.token.set('');
  }

  protected startOver(): void {
    if (this.busy()) return;
    this.candidate.set(null);
    this.code.set('');
    this.token.set('');
    this.error.set(null);
    this.mode.set('paste');
  }

  protected async scan(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const raw = await this.qr.scan();
      if (!raw) {
        this.error.set('No code scanned. Try again or paste a connection code.');
        return;
      }
      this.code.set(raw);
      this.reviewCode();
    } catch {
      this.error.set('Could not scan a code. Try again or paste a connection code.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async pair(): Promise<void> {
    const connection = this.candidate();
    if (!connection || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const result = await pairWithHost(
        connection.host,
        connection.port,
        connection.pairingToken,
        this.label().trim() || 'iPhone',
        connection.secure,
      );
      await this.hostStore.addHost({
        id: result.deviceId,
        name: result.hostName || connection.host,
        host: connection.host,
        port: connection.port,
        token: result.token,
        secure: connection.secure,
        addedAt: Date.now(),
      });
      await this.hostStore.setActive(result.deviceId);
      void this.router.navigate(['/projects']);
    } catch (err) {
      this.error.set(err instanceof PairingError ? err.message : 'Could not save this pairing. Check device storage and generate a new connection code before trying again.');
    } finally {
      this.busy.set(false);
    }
  }

  protected cancel(): void {
    if (!this.busy()) void this.router.navigate(['/']);
  }
}
