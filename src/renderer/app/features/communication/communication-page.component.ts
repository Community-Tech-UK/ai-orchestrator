/**
 * Communication Page
 * UI for cross-instance message passing and bridge management.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { CommIpcService } from '../../core/services/ipc/comm-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';

interface CommMessage {
  id: string;
  fromInstanceId: string;
  toInstanceId: string;
  content: string;
  type: string;
  timestamp: number;
}

interface CommBridge {
  id: string;
  instanceId1: string;
  instanceId2: string;
  status: string;
  createdAt: number;
}

@Component({
  selector: 'app-communication-page',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="page">
      <!-- Page Header -->
      <div class="page-header">
        <div class="header-title">
          <span class="title">Communication</span>
          <span class="subtitle">Cross-instance message passing and bridges</span>
        </div>
        <div class="header-actions">
          <button class="btn" type="button" [disabled]="working()" (click)="refresh()">Refresh</button>
        </div>
      </div>

      <!-- Metric cards -->
      <div class="metric-row">
        <div class="metric-card">
          <div class="metric-label">Messages Sent</div>
          <div class="metric-value">{{ messages().length }}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Active Bridges</div>
          <div class="metric-value">{{ activeBridgeCount() }}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Connected Instances</div>
          <div class="metric-value">{{ connectedInstanceCount() }}</div>
        </div>
      </div>

      <!-- Two-column content area -->
      <div class="content">

        <!-- Left: Message Feed -->
        <div class="feed-panel panel-card">
          <div class="panel-title">Message Feed</div>

          @if (messages().length === 0) {
            <div class="empty-state">No messages yet</div>
          } @else {
            <div class="message-list">
              @for (msg of messages(); track msg.id) {
                <div class="message-item">
                  <div class="message-header">
                    <span class="message-route">{{ msg.fromInstanceId }} → {{ msg.toInstanceId }}</span>
                    <span class="type-badge">{{ msg.type }}</span>
                    <span class="message-time">{{ formatTime(msg.timestamp) }}</span>
                  </div>
                  <div class="message-content">{{ msg.content }}</div>
                </div>
              }
            </div>
          }
        </div>

        <!-- Right sidebar -->
        <div class="side-panel">

          <!-- Send Message form -->
          <div class="panel-card">
            <div class="panel-title">Send Message</div>

            <label class="field">
              <span class="label">From Instance ID</span>
              <input
                class="input"
                type="text"
                [value]="sendFrom()"
                placeholder="e.g. instance-abc"
                (input)="onSendFromInput($event)"
              />
            </label>

            <label class="field">
              <span class="label">To Instance ID</span>
              <input
                class="input"
                type="text"
                [value]="sendTo()"
                placeholder="e.g. instance-xyz"
                (input)="onSendToInput($event)"
              />
            </label>

            <label class="field">
              <span class="label">Type</span>
              <select class="select" [value]="sendType()" (change)="onSendTypeChange($event)">
                <option value="text">text</option>
                <option value="command">command</option>
                <option value="data">data</option>
              </select>
            </label>

            <label class="field">
              <span class="label">Content</span>
              <textarea
                class="textarea"
                [value]="sendContent()"
                placeholder="Message content..."
                (input)="onSendContentInput($event)"
              ></textarea>
            </label>

            @if (sendError()) {
              <div class="error-inline">{{ sendError() }}</div>
            }

            @if (sendSuccess()) {
              <div class="success-inline">{{ sendSuccess() }}</div>
            }

            <div class="row-actions">
              <button
                class="btn primary"
                type="button"
                [disabled]="working() || !canSend()"
                (click)="sendMessage()"
              >
                {{ working() ? 'Sending...' : 'Send' }}
              </button>
            </div>
          </div>

          <!-- Bridge Status panel -->
          <div class="panel-card">
            <div class="panel-title">Bridge Status</div>

            @if (bridges().length === 0) {
              <div class="empty-state">No bridges</div>
            } @else {
              <div class="bridge-list">
                @for (bridge of bridges(); track bridge.id) {
                  <div class="bridge-item">
                    <div class="bridge-header">
                      <span class="bridge-instances">{{ bridge.instanceId1 }} ↔ {{ bridge.instanceId2 }}</span>
                      <span class="bridge-status" [class.active]="bridge.status === 'active'">
                        {{ bridge.status }}
                      </span>
                    </div>
                    <div class="bridge-meta">Created {{ formatTime(bridge.createdAt) }}</div>
                  </div>
                }
              </div>
            }

            <div class="panel-title" style="margin-top: 8px;">Create Bridge</div>

            <label class="field">
              <span class="label">Instance 1 ID</span>
              <input
                class="input"
                type="text"
                [value]="bridgeId1()"
                placeholder="e.g. instance-abc"
                (input)="onBridgeId1Input($event)"
              />
            </label>

            <label class="field">
              <span class="label">Instance 2 ID</span>
              <input
                class="input"
                type="text"
                [value]="bridgeId2()"
                placeholder="e.g. instance-xyz"
                (input)="onBridgeId2Input($event)"
              />
            </label>

            @if (bridgeError()) {
              <div class="error-inline">{{ bridgeError() }}</div>
            }

            @if (bridgeSuccess()) {
              <div class="success-inline">{{ bridgeSuccess() }}</div>
            }

            <div class="row-actions">
              <button
                class="btn primary"
                type="button"
                [disabled]="working() || !canCreateBridge()"
                (click)="createBridge()"
              >
                {{ working() ? 'Creating...' : 'Create' }}
              </button>
            </div>
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

      .header-actions {
        display: flex;
        gap: var(--spacing-xs);
      }

      .btn {
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-tertiary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
        cursor: pointer;
      }

      .btn.primary {
        background: var(--primary-color);
        border-color: var(--primary-color);
        color: #fff;
      }

      .btn:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      .notice-banner {
        flex-shrink: 0;
        padding: var(--spacing-sm) var(--spacing-md);
        border-radius: var(--radius-sm);
        border: 1px solid color-mix(in srgb, #f59e0b 60%, transparent);
        background: color-mix(in srgb, #f59e0b 12%, transparent);
        color: #b45309;
        font-size: 12px;
      }

      .metric-row {
        display: flex;
        gap: var(--spacing-md);
        flex-shrink: 0;
      }

      .metric-card {
        flex: 1;
        min-width: 0;
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        padding: var(--spacing-md);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .metric-label {
        font-size: 11px;
        font-weight: 600;
        color: var(--text-muted);
      }

      .metric-value {
        font-size: 24px;
        font-weight: 700;
        color: var(--text-primary);
      }

      .content {
        flex: 1;
        min-height: 0;
        display: grid;
        grid-template-columns: 1fr 300px;
        gap: var(--spacing-md);
      }

      .feed-panel {
        min-height: 0;
        overflow: auto;
      }

      .side-panel {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        min-height: 0;
        overflow: auto;
      }

      .panel-card {
        border: 1px solid var(--border-color);
        border-radius: var(--radius-md);
        background: var(--bg-secondary);
        padding: var(--spacing-md);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-sm);
      }

      .panel-title {
        font-size: 12px;
        font-weight: 700;
        color: var(--text-muted);
      }

      .empty-state {
        font-size: 12px;
        color: var(--text-muted);
        padding: var(--spacing-sm) 0;
      }

      .message-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
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

      .message-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .message-route {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-primary);
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .type-badge {
        font-size: 10px;
        font-weight: 600;
        border: 1px solid var(--border-color);
        border-radius: 999px;
        padding: 1px 6px;
        color: var(--text-muted);
        background: var(--bg-secondary);
        flex-shrink: 0;
      }

      .message-time {
        font-size: 10px;
        color: var(--text-muted);
        flex-shrink: 0;
      }

      .message-content {
        font-size: 12px;
        color: var(--text-secondary);
        overflow-wrap: anywhere;
      }

      .bridge-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .bridge-item {
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        background: var(--bg-tertiary);
        padding: var(--spacing-xs) var(--spacing-sm);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .bridge-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--spacing-xs);
      }

      .bridge-instances {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .bridge-status {
        font-size: 10px;
        font-weight: 600;
        color: var(--text-muted);
        flex-shrink: 0;
      }

      .bridge-status.active {
        color: var(--success-color);
      }

      .bridge-meta {
        font-size: 11px;
        color: var(--text-muted);
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
      .select,
      .textarea {
        width: 100%;
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
        background: var(--bg-primary);
        color: var(--text-primary);
        padding: var(--spacing-xs) var(--spacing-sm);
        font-size: 12px;
      }

      .textarea {
        min-height: 72px;
        resize: vertical;
      }

      .row-actions {
        display: flex;
        gap: var(--spacing-xs);
      }

      .error-inline {
        font-size: 11px;
        color: var(--error-color);
        padding: 2px 0;
      }

      .success-inline {
        font-size: 11px;
        color: var(--success-color);
        padding: 2px 0;
      }

      @media (max-width: 900px) {
        .content {
          grid-template-columns: 1fr;
        }

        .metric-row {
          flex-wrap: wrap;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CommunicationPageComponent implements OnInit {
  private readonly commIpc = inject(CommIpcService);

  readonly messages = signal<CommMessage[]>([]);
  readonly bridges = signal<CommBridge[]>([]);

  readonly sendFrom = signal('');
  readonly sendTo = signal('');
  readonly sendType = signal<'text' | 'command' | 'data'>('text');
  readonly sendContent = signal('');
  readonly sendError = signal<string | null>(null);
  readonly sendSuccess = signal<string | null>(null);

  readonly bridgeId1 = signal('');
  readonly bridgeId2 = signal('');
  readonly bridgeError = signal<string | null>(null);
  readonly bridgeSuccess = signal<string | null>(null);

  readonly working = signal(false);

  get activeBridgeCount(): () => number {
    return () => this.bridges().filter((b) => b.status === 'active').length;
  }

  get connectedInstanceCount(): () => number {
    return () => {
      const ids = new Set<string>();
      for (const bridge of this.bridges()) {
        if (bridge.status === 'active') {
          ids.add(bridge.instanceId1);
          ids.add(bridge.instanceId2);
        }
      }
      return ids.size;
    };
  }

  get canSend(): () => boolean {
    return () =>
      this.sendFrom().trim().length > 0 &&
      this.sendTo().trim().length > 0 &&
      this.sendContent().trim().length > 0;
  }

  get canCreateBridge(): () => boolean {
    return () =>
      this.bridgeId1().trim().length > 0 && this.bridgeId2().trim().length > 0;
  }

  async ngOnInit(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    this.working.set(true);
    try {
      await Promise.all([this.loadMessages(), this.loadBridges()]);
    } finally {
      this.working.set(false);
    }
  }

  async sendMessage(): Promise<void> {
    if (!this.canSend()) return;

    this.sendError.set(null);
    this.sendSuccess.set(null);
    this.working.set(true);

    try {
      const response: IpcResponse = await this.commIpc.sendMessage({
        fromInstanceId: this.sendFrom().trim(),
        toInstanceId: this.sendTo().trim(),
        content: this.sendContent().trim(),
        type: this.sendType(),
      });

      if (!response.success) {
        this.sendError.set(response.error?.message ?? 'Failed to send message.');
        return;
      }

      this.sendSuccess.set('Message sent.');
      this.sendContent.set('');
      await this.loadMessages();
    } catch {
      this.sendError.set('Unexpected error sending message.');
    } finally {
      this.working.set(false);
    }
  }

  async createBridge(): Promise<void> {
    if (!this.canCreateBridge()) return;

    this.bridgeError.set(null);
    this.bridgeSuccess.set(null);
    this.working.set(true);

    try {
      const response: IpcResponse = await this.commIpc.createBridge(
        this.bridgeId1().trim(),
        this.bridgeId2().trim(),
      );

      if (!response.success) {
        this.bridgeError.set(response.error?.message ?? 'Failed to create bridge.');
        return;
      }

      this.bridgeSuccess.set('Bridge created.');
      this.bridgeId1.set('');
      this.bridgeId2.set('');
      await this.loadBridges();
    } catch {
      this.bridgeError.set('Unexpected error creating bridge.');
    } finally {
      this.working.set(false);
    }
  }

  onSendFromInput(event: Event): void {
    this.sendFrom.set((event.target as HTMLInputElement).value);
  }

  onSendToInput(event: Event): void {
    this.sendTo.set((event.target as HTMLInputElement).value);
  }

  onSendTypeChange(event: Event): void {
    this.sendType.set((event.target as HTMLSelectElement).value as 'text' | 'command' | 'data');
  }

  onSendContentInput(event: Event): void {
    this.sendContent.set((event.target as HTMLTextAreaElement).value);
  }

  onBridgeId1Input(event: Event): void {
    this.bridgeId1.set((event.target as HTMLInputElement).value);
  }

  onBridgeId2Input(event: Event): void {
    this.bridgeId2.set((event.target as HTMLInputElement).value);
  }

  formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString();
  }

  private async loadMessages(): Promise<void> {
    const response = await this.commIpc.getMessages();
    if (response.success && Array.isArray(response.data)) {
      this.messages.set(response.data as CommMessage[]);
    } else {
      // Backend not yet available — show empty state
      this.messages.set([]);
    }
  }

  private async loadBridges(): Promise<void> {
    const response = await this.commIpc.getBridges();
    if (response.success && Array.isArray(response.data)) {
      this.bridges.set(response.data as CommBridge[]);
    } else {
      // Backend not yet available — show empty state
      this.bridges.set([]);
    }
  }
}
