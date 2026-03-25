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

@Component({
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  selector: 'app-channel-messages',
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
        <h2>Channel Messages</h2>
        <p class="subtitle">Messages received and sent via Discord and WhatsApp</p>
        <div class="nav-links">
          <button class="nav-btn" type="button" (click)="router.navigate(['/channels'])">Connections</button>
          <button class="nav-btn active" type="button">Messages</button>
          <button class="nav-btn" type="button" (click)="router.navigate(['/channels/settings'])">Settings</button>
        </div>
      </div>

      <div class="filters">
        <select class="filter-select" (change)="platformFilter.set($any($event.target).value)">
          <option value="all">All Platforms</option>
          <option value="discord">Discord</option>
          <option value="whatsapp">WhatsApp</option>
        </select>
      </div>

      @if (filteredMessages().length === 0) {
        <div class="empty-state">
          <p>No messages yet. Connect a channel and send a message to get started.</p>
        </div>
      } @else {
        <div class="message-list">
          @for (msg of filteredMessages(); track msg.id) {
            <div class="message-item" [class.outbound]="msg.direction === 'outbound'">
              <div class="message-header">
                <span class="platform-badge">{{ msg.platform === 'discord' ? 'Discord' : 'WhatsApp' }}</span>
                <span class="sender-name">{{ msg.senderName }}</span>
                <span class="direction-badge" [class]="'direction-badge ' + msg.direction">{{ msg.direction }}</span>
                <span class="timestamp">{{ formatTime(msg.timestamp) }}</span>
              </div>
              <div class="message-content">{{ msg.content }}</div>
              @if (msg.instanceId) {
                <div class="instance-link">
                  Instance: {{ msg.instanceId.slice(0, 8) }}
                </div>
              }
            </div>
          }
        </div>
      }
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

    .filters { margin-bottom: 1rem; }
    .filter-select {
      padding: 0.375rem 0.75rem; border: 1px solid var(--border-color, #333);
      border-radius: 4px; background: var(--bg-primary, #2a2a2a);
      color: var(--text-primary, #ccc); font-size: 0.8125rem;
    }

    .empty-state { text-align: center; padding: 2rem; color: var(--text-muted, #888); }

    .message-list { display: flex; flex-direction: column; gap: 0.5rem; }
    .message-item {
      border: 1px solid var(--border-color, #333); border-radius: 6px;
      padding: 0.75rem; background: var(--bg-secondary, #1e1e1e);
    }
    .message-item.outbound { border-left: 3px solid var(--primary-color, #3b82f6); }
    .message-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.375rem; font-size: 0.8125rem; }
    .platform-badge { font-size: 0.75rem; color: var(--text-muted, #888); font-weight: 600; }
    .sender-name { font-weight: 500; }
    .direction-badge {
      padding: 0.0625rem 0.375rem; border-radius: 8px; font-size: 0.6875rem;
      text-transform: capitalize;
    }
    .direction-badge.inbound { background: color-mix(in srgb, var(--success-color, #22c55e) 15%, transparent); color: var(--success-color, #22c55e); }
    .direction-badge.outbound { background: color-mix(in srgb, var(--primary-color, #3b82f6) 15%, transparent); color: var(--primary-color, #3b82f6); }
    .timestamp { margin-left: auto; color: var(--text-muted, #888); font-size: 0.75rem; }
    .message-content { font-size: 0.875rem; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
    .instance-link {
      margin-top: 0.375rem; font-size: 0.75rem; color: var(--primary-color, #3b82f6);
      cursor: pointer;
    }
  `],
})
export class ChannelMessagesComponent {
  protected store = inject(ChannelStore);
  protected router = inject(Router);
  protected platformFilter = signal('all');

  filteredMessages = computed(() => {
    const filter = this.platformFilter();
    const msgs = this.store.messages();
    if (filter === 'all') return msgs;
    return msgs.filter(m => m.platform === filter);
  });

  formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleString();
  }
}
