import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { ChannelStore } from '../../../../core/state/channel.store';
import { ChannelIpcService } from '../../../../core/services/ipc/channel-ipc.service';

@Component({
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-channel-connections',
  template: `
    <div class="channels-page">
      <div class="page-header">
        <button class="back-btn" type="button" (click)="router.navigate(['/'])">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/>
          </svg>
          Back to Projects
        </button>
        <h2>Channels</h2>
        <p class="subtitle">Connect Discord and WhatsApp to control the Orchestrator from your phone</p>
        <div class="nav-links">
          <button class="nav-btn active" type="button">Connections</button>
          <button class="nav-btn" type="button" (click)="router.navigate(['/channels/messages'])">Messages</button>
          <button class="nav-btn" type="button" (click)="router.navigate(['/channels/settings'])">Settings</button>
        </div>
      </div>

      <div class="cards">
        <!-- Discord Card -->
        <div class="card" [class.connected]="store.discord().status === 'connected'">
          <div class="card-header">
            <span class="platform-icon">Discord</span>
            <h3>Discord</h3>
            <span class="status-badge" [class]="'status-badge ' + store.discord().status">
              {{ store.discord().status }}
            </span>
          </div>

          @if (store.discord().status === 'connected') {
            <div class="card-body">
              <p class="connected-info">Bot: <strong>{{ store.discord().botUsername }}</strong></p>
              <label class="input-label" for="discord-pair-code-connected">Pairing Code</label>
              <div class="pair-row">
                <input
                  id="discord-pair-code-connected"
                  type="text"
                  class="token-input pair-input"
                  [value]="discordPairCode()"
                  (input)="onDiscordPairCodeInput($any($event.target).value)"
                  placeholder="4393DA"
                  maxlength="6"
                />
                <button
                  class="btn btn-primary"
                  type="button"
                  (click)="pairDiscord()"
                  [disabled]="!canPairDiscord()">
                  {{ pairingWorking() ? 'Pairing...' : 'Pair' }}
                </button>
              </div>
              @if (pairingMessage()) {
                <div class="pairing-msg" [class.pairing-success]="pairingSuccess()" [class.pairing-error]="!pairingSuccess()">
                  {{ pairingMessage() }}
                </div>
              }
              <button class="btn btn-danger" type="button" (click)="store.disconnect('discord')" [disabled]="store.loading()">
                Disconnect
              </button>
            </div>
          } @else {
            <div class="card-body">
              @if (store.discord().error) {
                <div class="error-msg">{{ store.discord().error }}</div>
              }
              <label class="input-label" for="discord-pair-code">Pairing Code</label>
              <div class="pair-row">
                <input
                  id="discord-pair-code"
                  type="text"
                  class="token-input pair-input"
                  [value]="discordPairCode()"
                  (input)="onDiscordPairCodeInput($any($event.target).value)"
                  placeholder="4393DA"
                  maxlength="6"
                />
                <button
                  class="btn btn-primary"
                  type="button"
                  (click)="pairDiscord()"
                  [disabled]="!canPairDiscord()">
                  {{ pairingWorking() ? 'Pairing...' : 'Pair' }}
                </button>
              </div>
              @if (pairingMessage()) {
                <div class="pairing-msg" [class.pairing-success]="pairingSuccess()" [class.pairing-error]="!pairingSuccess()">
                  {{ pairingMessage() }}
                </div>
              }
              <div class="section-divider"></div>
              <label class="input-label" for="discord-token">Bot Token</label>
              <input
                id="discord-token"
                type="password"
                class="token-input"
                [value]="discordToken()"
                (input)="discordToken.set($any($event.target).value)"
                placeholder="Enter Discord bot token..."
              />
              <button
                class="btn btn-primary"
                type="button"
                (click)="connectDiscord()"
                [disabled]="store.loading() || !discordToken()">
                {{ store.discord().status === 'connecting' ? 'Connecting...' : 'Connect' }}
              </button>
            </div>
          }
        </div>

        <!-- WhatsApp Card -->
        <div class="card" [class.connected]="store.whatsapp().status === 'connected'">
          <div class="card-header">
            <span class="platform-icon">WhatsApp</span>
            <h3>WhatsApp</h3>
            <span class="status-badge" [class]="'status-badge ' + store.whatsapp().status">
              {{ store.whatsapp().status }}
            </span>
          </div>

          @if (store.whatsapp().status === 'connected') {
            <div class="card-body">
              <p class="connected-info">Phone: <strong>{{ store.whatsapp().phoneNumber }}</strong></p>
              <button class="btn btn-danger" type="button" (click)="store.disconnect('whatsapp')" [disabled]="store.loading()">
                Disconnect
              </button>
            </div>
          } @else {
            <div class="card-body">
              @if (store.whatsapp().error) {
                <div class="error-msg">{{ store.whatsapp().error }}</div>
              }
              @if (store.whatsapp().qrCode) {
                <div class="qr-container">
                  <p>Scan with WhatsApp:</p>
                  <div class="qr-placeholder">{{ store.whatsapp().qrCode }}</div>
                </div>
              }
              <button
                class="btn btn-primary"
                type="button"
                (click)="store.connectWhatsApp()"
                [disabled]="store.loading()">
                {{ store.whatsapp().status === 'connecting' ? 'Waiting for QR scan...' : 'Connect' }}
              </button>
            </div>
          }
        </div>
      </div>
    </div>
  `,
  styles: [`
    .channels-page { padding: 1.5rem; max-width: 800px; }
    .back-btn {
      display: inline-flex; align-items: center; gap: 0.375rem;
      background: none; border: none; color: var(--text-muted, #888);
      cursor: pointer; font-size: 0.8125rem; padding: 0.25rem 0;
      margin-bottom: 0.75rem;
    }
    .back-btn:hover { color: var(--text-primary, #ccc); }
    .page-header { margin-bottom: 1.5rem; }
    .page-header h2 { margin: 0 0 0.25rem; font-size: 1.5rem; }
    .subtitle { color: var(--text-muted, #888); margin: 0 0 1rem; font-size: 0.875rem; }
    .nav-links { display: flex; gap: 0.5rem; }
    .nav-btn {
      padding: 0.375rem 0.75rem; border: 1px solid var(--border-color, #333);
      border-radius: 4px; background: transparent; color: var(--text-primary, #ccc);
      cursor: pointer; font-size: 0.8125rem;
    }
    .nav-btn.active { background: var(--primary-color, #3b82f6); color: white; border-color: transparent; }
    .nav-btn:hover:not(.active) { background: var(--bg-tertiary, #2a2a2a); }

    .cards { display: flex; flex-direction: column; gap: 1rem; }
    .card {
      border: 1px solid var(--border-color, #333); border-radius: 8px;
      padding: 1rem; background: var(--bg-secondary, #1e1e1e);
    }
    .card.connected { border-color: var(--success-color, #22c55e); }
    .card-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; }
    .card-header h3 { margin: 0; flex: 1; font-size: 1.125rem; }
    .platform-icon { font-size: 0.875rem; font-weight: 600; color: var(--text-muted, #888); }
    .status-badge {
      padding: 0.125rem 0.5rem; border-radius: 12px; font-size: 0.75rem;
      text-transform: capitalize; font-weight: 500;
    }
    .status-badge.connected { background: color-mix(in srgb, var(--success-color, #22c55e) 15%, transparent); color: var(--success-color, #22c55e); }
    .status-badge.connecting { background: rgba(234, 179, 8, 0.15); color: #eab308; }
    .status-badge.disconnected { background: color-mix(in srgb, var(--text-muted, #6b7280) 15%, transparent); color: var(--text-muted, #6b7280); }
    .status-badge.error { background: color-mix(in srgb, var(--error-color, #ef4444) 15%, transparent); color: var(--error-color, #ef4444); }

    .card-body { display: flex; flex-direction: column; gap: 0.5rem; }
    .connected-info { margin: 0; font-size: 0.875rem; color: var(--text-muted, #888); }
    .error-msg {
      padding: 0.5rem; border-radius: 4px; font-size: 0.8125rem;
      background: color-mix(in srgb, var(--error-color, #ef4444) 10%, transparent);
      color: var(--error-color, #ef4444);
      border: 1px solid color-mix(in srgb, var(--error-color, #ef4444) 30%, transparent);
    }
    .input-label { font-size: 0.8125rem; color: var(--text-muted, #888); }
    .token-input {
      padding: 0.5rem; border: 1px solid var(--border-color, #333);
      border-radius: 4px; background: var(--bg-primary, #2a2a2a);
      color: var(--text-primary, #ccc); font-size: 0.875rem;
    }
    .pair-row { display: flex; gap: 0.5rem; align-items: center; }
    .pair-input {
      flex: 1;
      min-width: 0;
      font-family: var(--font-family-mono, monospace);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .pairing-msg {
      padding: 0.5rem; border-radius: 4px; font-size: 0.8125rem;
    }
    .pairing-success {
      background: color-mix(in srgb, var(--success-color, #22c55e) 10%, transparent);
      color: var(--success-color, #22c55e);
      border: 1px solid color-mix(in srgb, var(--success-color, #22c55e) 30%, transparent);
    }
    .pairing-error {
      background: color-mix(in srgb, var(--error-color, #ef4444) 10%, transparent);
      color: var(--error-color, #ef4444);
      border: 1px solid color-mix(in srgb, var(--error-color, #ef4444) 30%, transparent);
    }
    .section-divider {
      height: 1px;
      background: var(--border-color, #333);
      margin: 0.25rem 0;
    }
    .btn {
      padding: 0.5rem 1rem; border: none; border-radius: 4px;
      cursor: pointer; font-size: 0.875rem; font-weight: 500;
    }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: var(--primary-color, #3b82f6); color: white; }
    .btn-primary:hover:not(:disabled) { opacity: 0.9; }
    .btn-danger { background: var(--error-color, #ef4444); color: white; }
    .btn-danger:hover:not(:disabled) { opacity: 0.9; }
    .qr-container { text-align: center; padding: 1rem; }
    .qr-placeholder {
      font-family: var(--font-family-mono, monospace); font-size: 0.75rem; word-break: break-all;
      max-height: 200px; overflow: auto; background: var(--bg-primary, #2a2a2a);
      padding: 0.5rem; border-radius: 4px;
    }
  `],
})
export class ChannelConnectionsComponent {
  protected store = inject(ChannelStore);
  protected router = inject(Router);
  private ipcService = inject(ChannelIpcService);

  protected discordToken = signal('');
  protected discordPairCode = signal('');
  protected pairingWorking = signal(false);
  protected pairingMessage = signal<string | null>(null);
  protected pairingSuccess = signal(false);
  protected canPairDiscord = computed(() => this.isPairingCode(this.discordPairCode()) && !this.pairingWorking());

  protected onDiscordPairCodeInput(value: string): void {
    this.discordPairCode.set(value.toUpperCase().trim());
  }

  async connectDiscord(): Promise<void> {
    const token = this.discordToken().trim();
    if (!token) {
      return;
    }

    if (this.isPairingCode(token)) {
      this.discordPairCode.set(token.toUpperCase());
      this.discordToken.set('');
      await this.pairDiscord();
      return;
    }

    await this.store.connectDiscord(token);
  }

  async pairDiscord(): Promise<void> {
    const code = this.discordPairCode().trim().toUpperCase();
    if (!this.isPairingCode(code)) {
      return;
    }

    this.pairingWorking.set(true);
    this.pairingMessage.set(null);

    try {
      const res = await this.ipcService.pairSender('discord', code);
      if (res.success) {
        this.pairingSuccess.set(true);
        this.pairingMessage.set('Sender paired successfully.');
        this.discordPairCode.set('');
      } else {
        this.pairingSuccess.set(false);
        this.pairingMessage.set(res.error?.message ?? 'Pairing failed. Check the code and try again.');
      }
    } catch {
      this.pairingSuccess.set(false);
      this.pairingMessage.set('Pairing failed. Check the code and try again.');
    } finally {
      this.pairingWorking.set(false);
    }
  }

  private isPairingCode(value: string): boolean {
    return /^[0-9a-fA-F]{6}$/.test(value.trim());
  }
}
