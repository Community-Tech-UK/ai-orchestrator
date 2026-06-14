/**
 * Mobile Settings Tab
 * Enable the mobile gateway, pair a phone (QR), and manage paired devices.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  MobileGatewayIpcService,
  type MobilePairingResult,
} from '../../core/services/ipc/mobile-gateway-ipc.service';
import { SettingsIpcService } from '../../core/services/ipc/settings-ipc.service';
import type {
  MobileGatewayStatus,
  MobileDeviceSummary,
} from '../../../../shared/types/mobile-gateway.types';

@Component({
  standalone: true,
  selector: 'app-mobile-settings-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    <section class="mobile-tab">
      @if (error()) {
        <div class="banner error">{{ error() }}</div>
      }

      <div class="card">
        <div class="status-line">
          <span class="dot" [class.on]="status()?.running"></span>
          <strong>{{ status()?.running ? 'Gateway running' : 'Gateway stopped' }}</strong>
          @if (status()?.running && status()?.tailnetUrl) {
            <code>{{ status()?.tailnetUrl }}</code>
          }
        </div>

        @if (!tailscaleReady()) {
          <p class="hint warn">
            No Tailscale address detected. Start Tailscale on this Mac (and your iPhone, same
            tailnet) so the phone can reach the gateway from anywhere.
          </p>
        }

        <button class="primary" (click)="toggle()" [disabled]="busy()">
          {{ busy() ? 'Working…' : status()?.running ? 'Stop gateway' : 'Start gateway' }}
        </button>
      </div>

      <div class="card">
        <div class="status-line">
          <span class="dot" [class.on]="status()?.pushConfigured"></span>
          <strong>Push notifications (APNs)</strong>
        </div>
        <p class="hint">
          Get pinged on your phone when an agent needs approval — even when the app is closed.
          Paste your Apple Push <code>.p8</code> Auth Key and IDs from the Apple Developer account.
          Push delivers over Apple's network independently of Tailscale.
        </p>

        <label class="field">
          <span>Auth Key (.p8 contents)</span>
          <textarea
            rows="4"
            [ngModel]="apnsKeyP8()"
            (ngModelChange)="apnsKeyP8.set($event)"
            [placeholder]="apnsHasKey() ? '•••• key stored — paste a new one to replace ••••' : '-----BEGIN PRIVATE KEY-----\\n…'"
          ></textarea>
        </label>
        <div class="grid">
          <label class="field">
            <span>Key ID</span>
            <input [ngModel]="apnsKeyId()" (ngModelChange)="apnsKeyId.set($event)" placeholder="ABCDE12345" />
          </label>
          <label class="field">
            <span>Team ID</span>
            <input [ngModel]="apnsTeamId()" (ngModelChange)="apnsTeamId.set($event)" placeholder="TEAM123456" />
          </label>
        </div>
        <label class="field">
          <span>Bundle ID (APNs topic)</span>
          <input
            [ngModel]="apnsBundleId()"
            (ngModelChange)="apnsBundleId.set($event)"
            placeholder="com.shutupandshave.aiorchestrator"
          />
        </label>
        <label class="checkbox">
          <input
            type="checkbox"
            [ngModel]="apnsProduction()"
            (ngModelChange)="apnsProduction.set($event)"
          />
          <span>Production APNs endpoint (uncheck while testing with a development build)</span>
        </label>
        <button (click)="saveApns()" [disabled]="apnsBusy()">
          {{ apnsBusy() ? 'Saving…' : apnsSaved() ? 'Saved' : 'Save push settings' }}
        </button>
      </div>

      <div class="card">
        <div class="status-line">
          <span class="dot" [class.on]="status()?.secure"></span>
          <strong>Secure connection (TLS / wss)</strong>
        </div>
        <p class="hint">
          Optional. Tailscale already encrypts the link end-to-end, so this is extra hardening.
          Generate a publicly-trusted cert with
          <code>tailscale cert &lt;this-mac&gt;.&lt;tailnet&gt;.ts.net</code>
          and point these at the resulting <code>.crt</code> and <code>.key</code> files. The phone
          then connects over <code>wss://</code> by the cert's hostname with no trust prompt.
          Leave blank for plain <code>ws://</code>. Restart the gateway after changing.
        </p>
        @if (status()?.secure && status()?.tlsHostname) {
          <p class="hint">Serving TLS for <code>{{ status()?.tlsHostname }}</code>.</p>
        }
        <label class="field">
          <span>Certificate file (.crt / fullchain.pem)</span>
          <input
            [ngModel]="tlsCertPath()"
            (ngModelChange)="tlsCertPath.set($event)"
            placeholder="/Users/you/certs/mac.tailnet.ts.net.crt"
          />
        </label>
        <label class="field">
          <span>Private key file (.key)</span>
          <input
            [ngModel]="tlsKeyPath()"
            (ngModelChange)="tlsKeyPath.set($event)"
            placeholder="/Users/you/certs/mac.tailnet.ts.net.key"
          />
        </label>
        <button (click)="saveTls()" [disabled]="tlsBusy()">
          {{ tlsBusy() ? 'Saving…' : tlsSaved() ? 'Saved' : 'Save TLS settings' }}
        </button>
      </div>

      @if (status()?.running) {
        <div class="card">
          <h3>Pair a phone</h3>
          <p class="hint">
            Generate a one-time code, then scan it in the Harness phone app.
          </p>
          <button (click)="generatePairing()" [disabled]="pairingBusy()">
            {{ pairingBusy() ? 'Generating…' : 'Generate pairing code' }}
          </button>

          @if (pairing(); as p) {
            <div class="pairing">
              <img class="qr" [src]="p.qrDataUrl" alt="Pairing QR code" />
              <div class="pairing-meta">
                <code class="addr">{{ p.host }}:{{ p.port }}</code>
                <span class="hint">Expires {{ formatExpiry(p.expiresAt) }}</span>
                <span class="hint">Or paste this connection code into the phone app:</span>
                <code class="conn-code">{{ connectionCode(p) }}</code>
                <button (click)="copyCode(p)">{{ copied() ? 'Copied' : 'Copy connection code' }}</button>
              </div>
            </div>
          }
        </div>

        <div class="card">
          <h3>Paired devices ({{ devices().length }})</h3>
          @if (devices().length === 0) {
            <p class="hint">No phones paired yet.</p>
          } @else {
            @for (device of devices(); track device.deviceId) {
              <div class="device-row">
                <div class="device-info">
                  <strong>{{ device.label }}</strong>
                  <span class="meta">
                    last seen {{ formatRelativeTime(device.lastSeenAt) }} ·
                    expires {{ formatExpiry(device.expiresAt) }}
                  </span>
                </div>
                <button class="danger" (click)="revoke(device)">Revoke</button>
              </div>
            }
          }
        </div>
      }
    </section>
  `,
  styles: [
    `
      .mobile-tab { display: flex; flex-direction: column; gap: 16px; max-width: 640px; }
      .card {
        background: var(--surface-2, #1c1c1e);
        border: 1px solid var(--border, rgba(255, 255, 255, 0.08));
        border-radius: 12px;
        padding: 16px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      h3 { margin: 0; font-size: 15px; }
      .status-line { display: flex; align-items: center; gap: 10px; }
      .status-line code { color: var(--text-secondary, #8e8e93); font-size: 13px; }
      .dot {
        width: 10px; height: 10px; border-radius: 50%;
        background: var(--text-secondary, #8e8e93);
      }
      .dot.on { background: #34c759; }
      .hint { color: var(--text-secondary, #8e8e93); font-size: 13px; margin: 0; }
      .hint.warn { color: #ff9f0a; }
      button {
        align-self: flex-start;
        padding: 8px 16px;
        border-radius: 8px;
        border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
        background: var(--surface-3, #2c2c2e);
        color: var(--text, #fff);
        cursor: pointer;
        font-size: 14px;
      }
      button:disabled { opacity: 0.5; cursor: default; }
      button.primary { background: #0a84ff; border-color: #0a84ff; }
      button.danger { background: transparent; border-color: #ff453a; color: #ff453a; padding: 6px 12px; }
      .banner.error {
        background: rgba(255, 69, 58, 0.15);
        border: 1px solid #ff453a;
        color: #ff453a;
        border-radius: 8px;
        padding: 10px 12px;
        font-size: 13px;
      }
      .pairing { display: flex; gap: 16px; align-items: center; }
      .qr { width: 180px; height: 180px; border-radius: 8px; background: #fff; padding: 8px; }
      .pairing-meta { display: flex; flex-direction: column; gap: 6px; max-width: 360px; }
      .addr { font-size: 14px; }
      .conn-code {
        font-size: 11px; color: var(--text-secondary, #8e8e93); word-break: break-all;
        background: var(--bg, #000); padding: 8px; border-radius: 6px; user-select: all;
      }
      .device-row {
        display: flex; justify-content: space-between; align-items: center;
        padding: 10px 0; border-top: 1px solid var(--border, rgba(255, 255, 255, 0.06));
      }
      .device-info { display: flex; flex-direction: column; gap: 2px; }
      .device-info .meta { color: var(--text-secondary, #8e8e93); font-size: 12px; }
      .field { display: flex; flex-direction: column; gap: 4px; }
      .field > span { font-size: 12px; color: var(--text-secondary, #8e8e93); }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
      input[type='text'], input:not([type]), textarea {
        background: var(--bg, #000); color: var(--text, #fff);
        border: 1px solid var(--border, rgba(255, 255, 255, 0.12));
        border-radius: 8px; padding: 8px 10px; font-size: 13px; width: 100%;
        font-family: inherit;
      }
      textarea { font-family: 'SF Mono', ui-monospace, Menlo, monospace; resize: vertical; }
      .checkbox { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-secondary, #8e8e93); }
      .checkbox input { width: auto; }
    `,
  ],
})
export class MobileSettingsTabComponent implements OnInit {
  private readonly ipc = inject(MobileGatewayIpcService);
  private readonly settings = inject(SettingsIpcService);

  protected readonly status = signal<MobileGatewayStatus | null>(null);
  protected readonly devices = signal<MobileDeviceSummary[]>([]);
  protected readonly pairing = signal<MobilePairingResult | null>(null);
  protected readonly busy = signal(false);
  protected readonly pairingBusy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal(false);

  // APNs push config
  protected readonly apnsKeyP8 = signal('');
  protected readonly apnsKeyId = signal('');
  protected readonly apnsTeamId = signal('');
  protected readonly apnsBundleId = signal('');
  protected readonly apnsProduction = signal(false);
  protected readonly apnsHasKey = signal(false);
  protected readonly apnsBusy = signal(false);
  protected readonly apnsSaved = signal(false);

  // Optional TLS (wss://)
  protected readonly tlsCertPath = signal('');
  protected readonly tlsKeyPath = signal('');
  protected readonly tlsBusy = signal(false);
  protected readonly tlsSaved = signal(false);

  protected readonly tailscaleReady = computed(() => Boolean(this.status()?.tailscaleIp));

  protected connectionCode(p: MobilePairingResult): string {
    return JSON.stringify({
      v: 1,
      host: p.host,
      port: p.port,
      pairingToken: p.pairingToken,
      ...(p.secure ? { secure: true } : {}),
    });
  }

  protected async copyCode(p: MobilePairingResult): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.connectionCode(p));
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    } catch {
      /* clipboard may be unavailable in the sandbox; the code is still selectable */
    }
  }

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    this.status.set(await this.ipc.getStatus());
    this.devices.set(await this.ipc.listDevices());
    await this.loadApnsConfig();
  }

  private async loadApnsConfig(): Promise<void> {
    const res = await this.settings.getSettings();
    if (!res.success) return;
    const s = (res.data ?? {}) as Record<string, unknown>;
    this.apnsKeyId.set(typeof s['mobileGatewayApnsKeyId'] === 'string' ? (s['mobileGatewayApnsKeyId'] as string) : '');
    this.apnsTeamId.set(typeof s['mobileGatewayApnsTeamId'] === 'string' ? (s['mobileGatewayApnsTeamId'] as string) : '');
    this.apnsBundleId.set(
      typeof s['mobileGatewayApnsBundleId'] === 'string' ? (s['mobileGatewayApnsBundleId'] as string) : '',
    );
    this.apnsProduction.set(Boolean(s['mobileGatewayApnsProduction']));
    // Never echo the secret key back into the UI; just note whether one is stored.
    this.apnsHasKey.set(typeof s['mobileGatewayApnsKeyP8'] === 'string' && (s['mobileGatewayApnsKeyP8'] as string).length > 0);
    this.apnsKeyP8.set('');
    this.tlsCertPath.set(typeof s['mobileGatewayTlsCertPath'] === 'string' ? (s['mobileGatewayTlsCertPath'] as string) : '');
    this.tlsKeyPath.set(typeof s['mobileGatewayTlsKeyPath'] === 'string' ? (s['mobileGatewayTlsKeyPath'] as string) : '');
  }

  protected async saveTls(): Promise<void> {
    this.tlsBusy.set(true);
    this.error.set(null);
    try {
      await this.settings.setSetting('mobileGatewayTlsCertPath', this.tlsCertPath().trim());
      await this.settings.setSetting('mobileGatewayTlsKeyPath', this.tlsKeyPath().trim());
      this.tlsSaved.set(true);
      setTimeout(() => this.tlsSaved.set(false), 2000);
      await this.refresh();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.tlsBusy.set(false);
    }
  }

  protected async saveApns(): Promise<void> {
    this.apnsBusy.set(true);
    this.error.set(null);
    try {
      await this.settings.setSetting('mobileGatewayApnsKeyId', this.apnsKeyId().trim());
      await this.settings.setSetting('mobileGatewayApnsTeamId', this.apnsTeamId().trim());
      await this.settings.setSetting('mobileGatewayApnsBundleId', this.apnsBundleId().trim());
      await this.settings.setSetting('mobileGatewayApnsProduction', this.apnsProduction());
      // Only overwrite the key when the user pasted a new one.
      const key = this.apnsKeyP8().trim();
      if (key) {
        await this.settings.setSetting('mobileGatewayApnsKeyP8', key);
      }
      this.apnsSaved.set(true);
      setTimeout(() => this.apnsSaved.set(false), 2000);
      await this.refresh();
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.apnsBusy.set(false);
    }
  }

  protected async toggle(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      if (this.status()?.running) {
        this.pairing.set(null);
        this.status.set(await this.ipc.stop());
      } else {
        this.status.set(await this.ipc.start());
      }
      this.devices.set(await this.ipc.listDevices());
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.busy.set(false);
    }
  }

  protected async generatePairing(): Promise<void> {
    this.pairingBusy.set(true);
    this.error.set(null);
    try {
      const result = await this.ipc.issuePairing();
      if (!result) {
        this.error.set('Could not generate a pairing code — is Tailscale running on this Mac?');
      }
      this.pairing.set(result);
    } catch (err) {
      this.error.set((err as Error).message);
    } finally {
      this.pairingBusy.set(false);
    }
  }

  protected async revoke(device: MobileDeviceSummary): Promise<void> {
    if (!confirm(`Revoke "${device.label}"? It will need to pair again to reconnect.`)) {
      return;
    }
    this.error.set(null);
    try {
      await this.ipc.revokeDevice(device.deviceId);
      this.devices.set(await this.ipc.listDevices());
    } catch (err) {
      this.error.set((err as Error).message);
    }
  }

  protected formatExpiry(timestamp: number): string {
    const remainingMs = timestamp - Date.now();
    if (remainingMs <= 0) return 'now';
    const minutes = Math.round(remainingMs / 60_000);
    if (minutes < 60) return `in ${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `in ${hours}h`;
    return `in ${Math.round(hours / 24)}d`;
  }

  protected formatRelativeTime(timestamp?: number): string {
    if (!timestamp) return 'never';
    const deltaMs = Date.now() - timestamp;
    if (deltaMs < 60_000) return 'just now';
    const minutes = Math.round(deltaMs / 60_000);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }
}
