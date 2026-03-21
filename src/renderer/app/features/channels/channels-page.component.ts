/**
 * Channels Page
 * UI for managing Discord/WhatsApp channel connections and messages.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { ChannelStore } from '../../core/state/channel.store';
import { ChannelIpcService } from '../../core/services/ipc/channel-ipc.service';
import type { ChannelPlatform } from '../../../../shared/types/channels';

@Component({
  selector: 'app-channels-page',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="page">
      <div class="page-header">
        <button class="header-btn" type="button" (click)="goBack()">← Back</button>
        <div class="header-title">
          <span class="title">Channels</span>
          <span class="subtitle">Manage Discord and WhatsApp bot connections</span>
        </div>
      </div>

      @if (store.error()) {
        <div class="error-banner">{{ store.error() }}</div>
      }

      <div class="content">

        <!-- Connection Panel -->
        <div class="panel-card">
          <div class="panel-title">Discord Connection</div>

          <div class="status-row">
            <span class="status-dot" [class]="'status-dot--' + store.discordStatus()"></span>
            <span class="status-label">{{ store.discordStatus() }}</span>
            @if (discordBotUsername()) {
              <span class="bot-name">{{ discordBotUsername() }}</span>
            }
          </div>

          @if (store.discordStatus() === 'disconnected' || store.discordStatus() === 'error') {
            <label class="field">
              <span class="label">Bot Token</span>
              <input
                class="input"
                type="password"
                placeholder="Discord bot token"
                [value]="botToken()"
                (input)="onTokenInput($event)"
              />
            </label>

            <div class="row-actions">
              <button
                class="btn btn--primary"
                type="button"
                [disabled]="store.loading()"
                (click)="connect()"
              >
                @if (store.loading()) { Connecting... } @else { Connect }
              </button>
            </div>
          } @else if (store.discordStatus() === 'connecting') {
            <div class="hint">Connecting to Discord...</div>
          } @else {
            <div class="row-actions">
              <button
                class="btn"
                type="button"
                [disabled]="store.loading()"
                (click)="disconnect()"
              >
                Disconnect
              </button>
            </div>
          }
        </div>

        <!-- Messages View -->
        <div class="panel-card panel-card--grow">
          <div class="panel-title">Messages</div>

          @if (store.messages().length === 0) {
            <div class="empty-state">
              <span class="empty-icon">💬</span>
              <span class="empty-text">No messages yet. Connect a channel to start receiving messages.</span>
            </div>
          } @else {
            <div class="messages-list">
              @for (msg of store.messages(); track msg.id) {
                <div class="message-item" [class.message-item--outbound]="msg.direction === 'outbound'">
                  <div class="message-header">
                    <span class="message-sender">{{ msg.senderName }}</span>
                    <span class="message-platform">{{ msg.platform }}</span>
                    <span class="message-direction" [class.outbound]="msg.direction === 'outbound'">
                      {{ msg.direction === 'outbound' ? 'sent' : 'received' }}
                    </span>
                    <span class="message-time">{{ formatTime(msg.timestamp) }}</span>
                  </div>
                  <div class="message-content">{{ msg.content }}</div>
                </div>
              }
            </div>
          }
        </div>

        <!-- Settings Panel -->
        <div class="panel-card">
          <div class="panel-title">Sender Pairing</div>

          <label class="field">
            <span class="label">Pairing Code</span>
            <input
              class="input"
              type="text"
              placeholder="Enter pairing code"
              [value]="pairingCode()"
              (input)="onPairingCodeInput($event)"
            />
          </label>

          <div class="row-actions">
            <button
              class="btn"
              type="button"
              [disabled]="!pairingCode() || pairingWorking()"
              (click)="pairSender()"
            >
              @if (pairingWorking()) { Pairing... } @else { Pair Sender }
            </button>
          </div>

          @if (pairingMessage()) {
            <div class="info-banner">{{ pairingMessage() }}</div>
          }

          <div class="panel-title" style="margin-top: var(--spacing-md)">Access Policy</div>

          <label class="field">
            <span class="label">Mode</span>
            <select
              class="select"
              [value]="accessPolicyMode()"
              (change)="onPolicyModeChange($event)"
            >
              <option value="pairing">pairing</option>
              <option value="allowlist">allowlist</option>
              <option value="disabled">disabled</option>
            </select>
          </label>

          <div class="row-actions">
            <button
              class="btn"
              type="button"
              [disabled]="policyWorking()"
              (click)="applyAccessPolicy()"
            >
              @if (policyWorking()) { Applying... } @else { Apply Policy }
            </button>
          </div>
        </div>

      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        width: 100%;
        height: 100%;
      }

      .page {
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        padding: var(--spacing-lg);
        background: var(--bg-primary);
        color: var(--text-primary);
        overflow: auto;
      }

      .page-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-md);
        flex-shrink: 0;
      }

      .header-title {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-width: 0;
      }

      .title {
        font-size: 18px;
        font-weight: 700;
      }

      .subtitle {
        font-size: 12px;
        color: var(--text-muted);
      }

      .header-btn,
      .btn {
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
        cursor: pointer;
        white-space: nowrap;
      }

      .btn--primary {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: #fff;
      }

      .btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .error-banner,
      .info-banner {
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-sm);
        font-size: 12px;
        flex-shrink: 0;
      }

      .error-banner {
        border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
        background: color-mix(in srgb, var(--error-color) 14%, transparent);
        color: var(--error-color);
      }

      .info-banner {
        border: 1px solid color-mix(in srgb, var(--primary-color) 60%, transparent);
        background: color-mix(in srgb, var(--primary-color) 12%, transparent);
        color: var(--text-primary);
      }

      .content {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: 280px 1fr 280px;
        gap: var(--spacing-md);
      }

      .panel-card {
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        padding: var(--spacing-md);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
        overflow: auto;
      }

      .panel-card--grow {
        min-height: 0;
      }

      .panel-title {
        font-size: 12px;
        font-weight: 700;
        color: var(--text-muted);
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .status-row {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
      }

      .status-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        flex-shrink: 0;
        background: var(--text-muted);
      }

      .status-dot--connected {
        background: var(--success-color);
      }

      .status-dot--connecting {
        background: var(--warning-color);
      }

      .status-dot--error {
        background: var(--error-color);
      }

      .status-dot--disconnected {
        background: var(--text-muted);
      }

      .status-label {
        font-size: 12px;
        color: var(--text-secondary);
        text-transform: capitalize;
      }

      .bot-name {
        font-size: 11px;
        color: var(--text-muted);
        margin-left: auto;
      }

      .field {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .label {
        font-size: 11px;
        color: var(--text-muted);
      }

      .input,
      .select {
        width: 100%;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-primary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
      }

      .row-actions {
        display: flex;
        gap: var(--spacing-xs);
        flex-wrap: wrap;
      }

      .hint {
        font-size: 12px;
        color: var(--text-muted);
      }

      .empty-state {
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--spacing-sm);
        padding: var(--spacing-lg);
      }

      .empty-icon {
        font-size: 32px;
      }

      .empty-text {
        font-size: 13px;
        color: var(--text-muted);
        text-align: center;
        max-width: 300px;
      }

      .messages-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
        overflow: auto;
        flex: 1;
        min-height: 0;
      }

      .message-item {
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        padding: var(--spacing-xs) var(--spacing-sm);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .message-item--outbound {
        background: color-mix(in srgb, var(--primary-color) 10%, var(--bg-tertiary));
        border-color: color-mix(in srgb, var(--primary-color) 40%, transparent);
      }

      .message-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-xs);
        font-size: 11px;
      }

      .message-sender {
        font-weight: 600;
        color: var(--text-primary);
      }

      .message-platform {
        color: var(--text-muted);
        text-transform: capitalize;
      }

      .message-direction {
        color: var(--text-muted);
        margin-left: auto;
      }

      .message-direction.outbound {
        color: var(--primary-color);
      }

      .message-time {
        color: var(--text-muted);
      }

      .message-content {
        font-size: 12px;
        color: var(--text-primary);
        overflow-wrap: anywhere;
      }

      @media (max-width: 900px) {
        .content {
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChannelsPageComponent implements OnInit {
  private readonly router = inject(Router);
  protected readonly store = inject(ChannelStore);
  private readonly channelIpc = inject(ChannelIpcService);

  readonly botToken = signal('');
  readonly pairingCode = signal('');
  readonly pairingMessage = signal<string | null>(null);
  readonly pairingWorking = signal(false);
  readonly accessPolicyMode = signal<'pairing' | 'allowlist' | 'disabled'>('pairing');
  readonly policyWorking = signal(false);

  readonly discordBotUsername = (() => {
    const channel = this.store.channels().find(c => c.platform === 'discord');
    return channel?.botUsername ?? null;
  });

  async ngOnInit(): Promise<void> {
    const response = await this.channelIpc.channelGetStatus();
    if (response.success && response.data) {
      const statuses = response.data as Array<{ platform: ChannelPlatform; status: string; botUsername?: string }>;
      statuses.forEach(s => {
        if (s.platform === 'discord') {
          this.store['updateChannelStatus']?.(s.platform, s.status as never, { botUsername: s.botUsername });
        }
      });
    }

    const policyResp = await this.channelIpc.channelGetAccessPolicy('discord');
    if (policyResp.success && policyResp.data) {
      const policy = policyResp.data as { mode: 'pairing' | 'allowlist' | 'disabled' };
      this.accessPolicyMode.set(policy.mode);
    }
  }

  goBack(): void {
    this.router.navigate(['/']);
  }

  onTokenInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.botToken.set(target.value);
  }

  onPairingCodeInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.pairingCode.set(target.value);
  }

  onPolicyModeChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.accessPolicyMode.set(target.value as 'pairing' | 'allowlist' | 'disabled');
  }

  async connect(): Promise<void> {
    await this.store.connect('discord', this.botToken() || undefined);
  }

  async disconnect(): Promise<void> {
    await this.store.disconnect('discord');
  }

  async pairSender(): Promise<void> {
    this.pairingWorking.set(true);
    this.pairingMessage.set(null);
    try {
      const success = await this.store.pairSender('discord', this.pairingCode());
      if (success) {
        this.pairingMessage.set('Sender paired successfully.');
        this.pairingCode.set('');
      } else {
        this.pairingMessage.set('Pairing failed. Check the code and try again.');
      }
    } finally {
      this.pairingWorking.set(false);
    }
  }

  async applyAccessPolicy(): Promise<void> {
    this.policyWorking.set(true);
    try {
      await this.channelIpc.channelSetAccessPolicy('discord', this.accessPolicyMode());
    } finally {
      this.policyWorking.set(false);
    }
  }

  formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}
