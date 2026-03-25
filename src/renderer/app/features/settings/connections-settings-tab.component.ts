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
  styles: [`
    .connections-tab { display: flex; flex-direction: column; gap: 1rem; }

    .section-title {
      margin: 0; font-size: 1.25rem; font-weight: 600;
      color: var(--text-primary, #e5e5e5);
    }

    .section-desc {
      margin: 0; font-size: 0.875rem;
      color: var(--text-muted, #888);
    }

    .connection-card {
      border: 1px solid var(--border-color, #333);
      border-radius: 8px;
      padding: 1rem;
      background: var(--bg-secondary, #1e1e1e);
      display: flex;
      flex-direction: column;
      gap: 0.625rem;
    }

    .connection-card.connected {
      border-color: var(--success-color, #22c55e);
    }

    .card-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .card-info {
      display: flex;
      align-items: center;
      gap: 0.625rem;
    }

    .card-name {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary, #e5e5e5);
    }

    .status-badge {
      padding: 0.125rem 0.5rem;
      border-radius: 12px;
      font-size: 0.75rem;
      text-transform: capitalize;
      font-weight: 500;
    }

    .status-badge.connected {
      background: color-mix(in srgb, var(--success-color, #22c55e) 15%, transparent);
      color: var(--success-color, #22c55e);
    }

    .status-badge.connecting {
      background: rgba(234, 179, 8, 0.15);
      color: #eab308;
    }

    .status-badge.disconnected {
      background: color-mix(in srgb, var(--text-muted, #6b7280) 15%, transparent);
      color: var(--text-muted, #6b7280);
    }

    .status-badge.error {
      background: color-mix(in srgb, var(--error-color, #ef4444) 15%, transparent);
      color: var(--error-color, #ef4444);
    }

    .connected-detail {
      margin: 0;
      font-size: 0.875rem;
      color: var(--text-muted, #888);
    }

    .error-msg {
      padding: 0.5rem;
      border-radius: 4px;
      font-size: 0.8125rem;
      background: color-mix(in srgb, var(--error-color, #ef4444) 10%, transparent);
      color: var(--error-color, #ef4444);
      border: 1px solid color-mix(in srgb, var(--error-color, #ef4444) 30%, transparent);
    }

    .field-label {
      font-size: 0.8125rem;
      color: var(--text-muted, #888);
    }

    .field-input {
      padding: 0.5rem;
      border: 1px solid var(--border-color, #333);
      border-radius: 4px;
      background: var(--bg-primary, #0f0f0f);
      color: var(--text-primary, #e5e5e5);
      font-size: 0.875rem;
      width: 100%;
      box-sizing: border-box;
    }

    .btn {
      padding: 0.5rem 1rem;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 500;
      align-self: flex-start;
    }

    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: var(--primary-color, #3b82f6); color: white; }
    .btn-primary:hover:not(:disabled) { opacity: 0.9; }
    .btn-danger { background: var(--error-color, #ef4444); color: white; }
    .btn-danger:hover:not(:disabled) { opacity: 0.9; }

    .qr-container { text-align: center; padding: 0.5rem; }
    .qr-code {
      font-family: var(--font-family-mono, monospace);
      font-size: 0.75rem;
      word-break: break-all;
      max-height: 200px;
      overflow: auto;
      background: var(--bg-primary, #0f0f0f);
      padding: 0.5rem;
      border-radius: 4px;
    }
  `]
})
export class ConnectionsSettingsTabComponent {
  protected store = inject(ChannelStore);
  protected discordToken = signal('');

  connectDiscord(): void {
    const token = this.discordToken();
    if (token) {
      this.store.connectDiscord(token);
    }
  }
}
