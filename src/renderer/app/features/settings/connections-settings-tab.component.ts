/**
 * Connections Settings Tab
 * Configure Discord and WhatsApp integrations from within Settings.
 */

import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from '@angular/core';
import { ChannelStore } from '../../core/state/channel.store';
import { ChannelIpcService } from '../../core/services/ipc/channel-ipc.service';

@Component({
  standalone: true,
  selector: 'app-connections-settings-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="connections-tab">
      <h3 class="section-title">Connections</h3>
      <p class="section-desc">Connect external services to control the Orchestrator remotely.</p>

      <!-- Discord -->
      <div class="connection-card" [class.connected]="store.discord().status === 'connected'">
        <div class="card-row">
          <div class="card-info">
            <span class="card-name">Discord</span>
            <span class="status-badge" [class]="'status-badge ' + store.discord().status">
              {{ store.discord().status }}
            </span>
          </div>
        </div>

        @if (store.discord().status === 'connected') {
          <p class="connected-detail">Bot: <strong>{{ store.discord().botUsername }}</strong></p>

          <!-- Pairing section -->
          <div class="pairing-section">
            <label class="field-label" for="discord-pair">Pairing Code</label>
            <p class="field-hint">DM the bot to get a code, then enter it here to authorize your account.</p>
            <div class="pair-row">
              <input
                id="discord-pair"
                type="text"
                class="field-input pair-input"
                [value]="discordPairCode()"
                (input)="discordPairCode.set($any($event.target).value.toUpperCase().trim())"
                placeholder="e.g. 4553FD"
                maxlength="6"
                style="text-transform: uppercase; font-family: var(--font-family-mono, monospace); letter-spacing: 0.1em;"
              />
              <button
                class="btn btn-primary"
                type="button"
                (click)="pairDiscord()"
                [disabled]="pairingWorking() || discordPairCode().length < 4"
              >
                {{ pairingWorking() ? 'Pairing...' : 'Pair' }}
              </button>
            </div>
            @if (pairingMessage()) {
              <div class="pairing-msg" [class.pairing-success]="pairingSuccess()" [class.pairing-error]="!pairingSuccess()">
                {{ pairingMessage() }}
              </div>
            }
          </div>

          <button
            class="btn btn-danger"
            type="button"
            (click)="store.disconnect('discord')"
            [disabled]="store.loading()"
          >
            Disconnect
          </button>
        } @else {
          @if (store.discord().error) {
            <div class="error-msg">{{ store.discord().error }}</div>
          }
          <label class="field-label" for="discord-token">Bot Token</label>
          <input
            id="discord-token"
            type="password"
            class="field-input"
            [value]="discordToken()"
            (input)="discordToken.set($any($event.target).value)"
            placeholder="Paste your Discord bot token..."
          />
          <button
            class="btn btn-primary"
            type="button"
            (click)="connectDiscord()"
            [disabled]="store.loading() || !discordToken()"
          >
            {{ store.discord().status === 'connecting' ? 'Connecting...' : 'Connect' }}
          </button>
        }
      </div>

      <!-- WhatsApp -->
      <div class="connection-card" [class.connected]="store.whatsapp().status === 'connected'">
        <div class="card-row">
          <div class="card-info">
            <span class="card-name">WhatsApp</span>
            <span class="status-badge" [class]="'status-badge ' + store.whatsapp().status">
              {{ store.whatsapp().status }}
            </span>
          </div>
        </div>

        @if (store.whatsapp().status === 'connected') {
          <p class="connected-detail">Phone: <strong>{{ store.whatsapp().phoneNumber }}</strong></p>
          <button
            class="btn btn-danger"
            type="button"
            (click)="store.disconnect('whatsapp')"
            [disabled]="store.loading()"
          >
            Disconnect
          </button>
        } @else {
          @if (store.whatsapp().error) {
            <div class="error-msg">{{ store.whatsapp().error }}</div>
          }
          @if (store.whatsapp().qrCode) {
            <div class="qr-container">
              <p>Scan with WhatsApp:</p>
              <div class="qr-code">{{ store.whatsapp().qrCode }}</div>
            </div>
          }
          <button
            class="btn btn-primary"
            type="button"
            (click)="store.connectWhatsApp()"
            [disabled]="store.loading()"
          >
            {{ store.whatsapp().status === 'connecting' ? 'Waiting for QR scan...' : 'Connect' }}
          </button>
        }
      </div>
    </div>
  `,
  styleUrl: './connections-settings-tab.component.scss'
})
export class ConnectionsSettingsTabComponent {
  protected store = inject(ChannelStore);
  private ipcService = inject(ChannelIpcService);
  protected discordToken = signal('');
  protected discordPairCode = signal('');
  protected pairingWorking = signal(false);
  protected pairingMessage = signal<string | null>(null);
  protected pairingSuccess = signal(false);

  connectDiscord(): void {
    const token = this.discordToken();
    if (token) {
      this.store.connectDiscord(token);
    }
  }

  async pairDiscord(): Promise<void> {
    const code = this.discordPairCode().trim().toUpperCase();
    if (!code) return;

    this.pairingWorking.set(true);
    this.pairingMessage.set(null);

    try {
      const res = await this.ipcService.pairSender('discord', code);
      if (res.success) {
        this.pairingSuccess.set(true);
        this.pairingMessage.set('Paired successfully! You can now send messages via Discord.');
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
}
